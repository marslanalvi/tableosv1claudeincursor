import { FilterError, type FilterAndGroup, type FilterAst, type FilterNode, type FilterOrGroup } from "./ast.js";
import { dateInTimeZone } from "./dates.js";
import { filterKindForField, normalizeFieldType } from "./kinds.js";
import { prepareCondition, selectOptionsOf, type FieldLike, type PrepareContext, type Prepared } from "./prepare.js";
import { parseFilterAst } from "./parse.js";

/**
 * In-memory filter evaluation over **wire-format records** (CONTRACTS §3):
 * `record.fields` keyed by field id (`fld_…`), values in output shape.
 * Semantics match the SQL compiler exactly (see parity tests).
 */

export interface EvalField extends FieldLike {
  /** Other ids that refer to this field (e.g. raw uuid). */
  aliases?: string[] | undefined;
  /** Lookup fields: the looked-up field, so select option ids show as labels. */
  lookupTarget?: FieldLike | null | undefined;
}

export interface EvalRecord {
  /** Public `rec_…` id when present (used by the Record ID field / criterion). */
  id?: string;
  fields: Record<string, unknown>;
}

export interface EvalContext extends PrepareContext {
  /** Conditions on unknown fields: "false" (default) or "ignore". */
  unknownField?: "false" | "ignore" | "error" | undefined;
}

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d{1,2})?$/;
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;
const ISO_RE =
  /^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])([T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?)?(Z|[+-]([01]\d|2[0-3])(:?[0-5]\d)?)?$/;

function elemText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "text", "filename"]) if (typeof o[k] === "string") return o[k] as string;
    return null;
  }
  return null;
}

/** Text of a wire value; arrays joined with ", " (mirrors SQL `textOfJson`). */
export function textOf(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.map(elemText).filter((x): x is string => x !== null && x !== "");
    return parts.length ? parts.join(", ") : null;
  }
  return elemText(v);
}

/** Display text of a wire lookup value (mirrors SQL `lookupTextExpr`). */
export function lookupTextOf(field: EvalField, v: unknown): string | null {
  const t = field.lookupTarget;
  const tk = t && normalizeFieldType(field.type) === "lookup" ? filterKindForField(t.type, t.config ?? null) : null;
  if (tk !== "single_select" && tk !== "multi_select") return textOf(v);
  const labels = new Map(selectOptionsOf(t?.config).map((o) => [o.id, o.label]));
  return textOf(asArr(v).map((x) => (typeof x === "string" ? labels.get(x) ?? x : x)));
}

export function numOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && NUM_RE.test(v.trim())) return Number(v.trim());
  return null;
}

function dateOf(v: unknown): string | null {
  return typeof v === "string" && DATE_PREFIX_RE.test(v) ? v.slice(0, 10) : null;
}

/** Parse an ISO date/datetime exactly like the SQL compiler (strict, no day rollover). */
export function parseIsoInstant(v: unknown): Date | null {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  const y = Number(v.slice(0, 4));
  const mo = Number(v.slice(5, 7));
  const day = Number(v.slice(8, 10));
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (day > last) return null;
  const s = v.length === 10 ? `${v}T00:00:00Z` : v.replace(" ", "T");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const tsOf = parseIsoInstant;

function boolOf(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

function asArr(v: unknown): unknown[] {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function idsOf(v: unknown): string[] {
  return asArr(v)
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>)["id"] : x))
    .filter((x): x is string | number => (typeof x === "string" && x !== "") || typeof x === "number")
    .map(String);
}

function selectIdOf(v: unknown): string | null {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" && x !== "" ? x : null;
}

function cmp(op: string, a: number | string, b: number | string): boolean {
  switch (op) {
    case "eq":
      return a === b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

export function isEmptyFor(field: FieldLike, v: unknown): boolean {
  const kind = filterKindForField(field.type, field.config ?? null);
  switch (kind) {
    case "number":
      return numOf(v) === null;
    case "date":
      return dateOf(v) === null;
    case "datetime":
      return tsOf(v) === null;
    case "checkbox":
      return !boolOf(v);
    case "single_select":
      return selectIdOf(v) === null;
    case "multi_select":
    case "collaborator":
    case "attachment":
    case "link":
      return idsOf(v).length === 0;
    case "array":
      return asArr(v).every((x) => x === null || x === undefined || x === "" || (Array.isArray(x) && x.length === 0));
    case "user":
      return idsOf(v).length === 0;
    default: {
      const t = textOf(v);
      return t === null || t === "";
    }
  }
}

function textTest(t: string | null, pr: Prepared): boolean {
  const lt = t === null ? null : t.toLowerCase();
  const q = pr.text ?? "";
  const hit = (() => {
    if (lt === null) return false;
    switch (pr.op) {
      case "eq":
      case "neq":
        return lt === q;
      case "contains":
      case "notContains":
        return lt.includes(q);
      case "startsWith":
        return lt.startsWith(q);
      case "endsWith":
        return lt.endsWith(q);
      default:
        return false;
    }
  })();
  return pr.op === "neq" || pr.op === "notContains" ? !hit : hit;
}

function numTest(n: number | null, pr: Prepared): boolean {
  if (pr.op === "neq") return !(n !== null && n === pr.num);
  if (n === null || pr.num === undefined) return false;
  return cmp(pr.op, n, pr.num);
}

function dateTest(d: string | null, pr: Prepared): boolean {
  if (pr.op === "within") return d !== null && !!pr.range && d >= pr.range[0] && d <= pr.range[1];
  if (pr.op === "neq") return !(d !== null && d === pr.date);
  if (d === null || pr.date === undefined) return false;
  return cmp(pr.op, d, pr.date);
}

function setTest(elems: string[], pr: Prepared): boolean {
  const groups = pr.ids ?? [];
  const all = new Set(groups.flat());
  const has = (g: string[]) => elems.some((e) => g.includes(e));
  switch (pr.op) {
    case "anyOf":
    case "hasAnyOf":
      return elems.some((e) => all.has(e));
    case "noneOf":
      return !elems.some((e) => all.has(e));
    case "hasAllOf":
      return groups.every(has);
    case "exactly":
    case "neq": {
      const exact = groups.every(has) && elems.every((e) => all.has(e));
      return pr.op === "exactly" ? exact : !exact;
    }
    default:
      return false;
  }
}

function evalPrepared(field: EvalField, pr: Prepared, v: unknown): boolean {
  if (pr.op === "empty") return isEmptyFor(field, v);
  if (pr.op === "notEmpty") return !isEmptyFor(field, v);
  switch (pr.kind) {
    case "text":
      return pr.numericText ? numTest(numOf(v), pr) : textTest(textOf(v), pr);
    case "array":
      return textTest(lookupTextOf(field, v), pr);
    case "number":
      return numTest(numOf(v), pr);
    case "date":
      return dateTest(dateOf(v), pr);
    case "datetime": {
      const t = tsOf(v);
      return dateTest(t ? dateInTimeZone(t, pr.tz) : null, pr);
    }
    case "checkbox":
      return boolOf(v) === pr.bool;
    case "single_select": {
      const id = selectIdOf(v);
      const hit = id !== null && (pr.ids ?? []).some((g) => g.includes(id));
      return pr.op === "noneOf" ? !hit : hit;
    }
    case "multi_select":
    case "collaborator":
      return setTest(idsOf(v), pr);
    case "user": {
      const id = idsOf(v)[0] ?? null;
      const hit = id !== null && (pr.ids ?? []).some((g) => g.includes(id));
      return pr.op === "noneOf" ? !hit : hit;
    }
    case "link": {
      if (pr.op === "contains" || pr.op === "notContains") {
        const q = pr.text ?? "";
        const hit = asArr(v).some((x) => (elemText(x) ?? "").toLowerCase().includes(q));
        return pr.op === "contains" ? hit : !hit;
      }
      return setTest(idsOf(v), pr);
    }
    default:
      return false;
  }
}

function findField(fields: Map<string, EvalField>, id: string): EvalField | undefined {
  return fields.get(id);
}

function evalNode(
  node: FilterNode,
  record: EvalRecord,
  fields: Map<string, EvalField>,
  ctx: EvalContext,
): boolean | null {
  if (node.kind === "condition") {
    const f = findField(fields, node.fieldId);
    if (!f) {
      const mode = ctx.unknownField ?? "false";
      if (mode === "ignore") return null;
      if (mode === "error") throw new FilterError(`Unknown field in filter: ${node.fieldId}`, "UNKNOWN_FILTER_FIELD", node.fieldId);
      return false;
    }
    const pr = prepareCondition(node, f, ctx);
    if (!pr) return null;
    const raw =
      normalizeFieldType(f.type) === "record_id"
        ? (record.fields[f.id] ?? record.id)
        : record.fields[f.id];
    return evalPrepared(f, pr, raw);
  }
  const results = node.children
    .map((c) => evalNode(c, record, fields, ctx))
    .filter((x): x is boolean => x !== null);
  if (results.length === 0) return null;
  return node.kind === "and" ? results.every(Boolean) : results.some(Boolean);
}

function fieldMap(fields: EvalField[] | Map<string, EvalField>): Map<string, EvalField> {
  if (fields instanceof Map) return fields;
  const m = new Map<string, EvalField>();
  for (const f of fields) {
    m.set(f.id, f);
    for (const a of f.aliases ?? []) m.set(a, f);
  }
  return m;
}

/**
 * Evaluate a filter against a wire-format record. A null/empty filter (or one
 * with only incomplete conditions) matches everything.
 */
export function evaluateFilter(
  ast: FilterAst | null | undefined,
  record: EvalRecord,
  fields: EvalField[] | Map<string, EvalField>,
  ctx: EvalContext = {},
): boolean {
  const parsed = parseFilterAst(ast);
  if (!parsed) return true;
  return evalNode(parsed, record, fieldMap(fields), ctx) ?? true;
}

/** Build a reusable predicate (parses and indexes fields once). */
export function createFilterPredicate(
  ast: FilterAst | null | undefined,
  fields: EvalField[] | Map<string, EvalField>,
  ctx: EvalContext = {},
): (record: EvalRecord) => boolean {
  const parsed = parseFilterAst(ast);
  if (!parsed) return () => true;
  const m = fieldMap(fields);
  return (record) => evalNode(parsed, record, m, ctx) ?? true;
}

export function andGroup(children: FilterNode[]): FilterAndGroup {
  return { kind: "and", children };
}

export function orGroup(children: FilterNode[]): FilterOrGroup {
  return { kind: "or", children };
}
