import { FilterError, FILTER_OPS, type FilterCondition, type FilterOp } from "./ast.js";
import { resolveDateOperand, resolveTimeZone, resolveWithinRange, type DateContext } from "./dates.js";
import { filterKindForField, isUntypedFormula, normalizeFieldType, type FilterKind } from "./kinds.js";

/**
 * Condition normalization shared by the SQL compiler and the in-memory
 * evaluator: validates operator/value against the field kind, resolves relative
 * dates, expands id variants. Returns `null` for an incomplete condition (no
 * operand yet), which callers drop from the tree (Airtable semantics).
 */

export interface FieldLike {
  id: string;
  type: string;
  config?: Record<string, unknown> | null | undefined;
}

export interface PrepareContext extends DateContext {
  /** Current user (any id form) for `isMe`. */
  currentUserId?: string | null | undefined;
  /** Expand an id into all its accepted spellings (e.g. `usr_…` ↔ uuid). */
  idVariants?: ((id: string) => string[]) | undefined;
}

export type CanonOp =
  | "eq"
  | "neq"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "within"
  | "empty"
  | "notEmpty"
  | "anyOf"
  | "noneOf"
  | "hasAnyOf"
  | "hasAllOf"
  | "exactly";

export interface Prepared {
  kind: FilterKind;
  op: CanonOp;
  /** lower-cased text operand */
  text?: string;
  num?: number;
  date?: string;
  range?: [string, string];
  bool?: boolean;
  /** operand ids, each with its variants */
  ids?: string[][];
  /** IANA zone used for datetime → date */
  tz: string;
  /** untyped formula: numeric comparisons allowed on text kind */
  numericText?: boolean;
}

const DATE_OP_MAP: Partial<Record<FilterOp, CanonOp>> = {
  eq: "eq",
  neq: "neq",
  isBefore: "lt",
  lt: "lt",
  isAfter: "gt",
  gt: "gt",
  isOnOrBefore: "lte",
  lte: "lte",
  isOnOrAfter: "gte",
  gte: "gte",
  isWithin: "within",
  empty: "empty",
  notEmpty: "notEmpty",
};

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function bad(cond: FilterCondition, type: string): FilterError {
  return new FilterError(
    `Operator "${cond.op}" is not supported for ${type} field ${cond.fieldId}`,
    "UNSUPPORTED_FILTER_OPERATOR",
    cond.fieldId,
  );
}

function toNum(v: unknown, cond: FilterCondition): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d{1,2})?\s*$/.test(v)) return Number(v);
  throw new FilterError(`Filter on ${cond.fieldId} expects a number, got ${JSON.stringify(v)}`, "INVALID_FILTER_VALUE", cond.fieldId);
}

function toText(v: unknown): string {
  if (typeof v === "string") return v.toLowerCase();
  if (typeof v === "number" || typeof v === "boolean") return String(v).toLowerCase();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["name"] === "string") return o["name"].toLowerCase();
    if (typeof o["text"] === "string") return o["text"].toLowerCase();
  }
  return JSON.stringify(v).toLowerCase();
}

function idList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x === "string" && x !== "") out.push(x);
    else if (x && typeof x === "object" && typeof (x as Record<string, unknown>)["id"] === "string") {
      out.push((x as Record<string, unknown>)["id"] as string);
    }
  }
  return out;
}

export interface SelectOptionLike {
  id: string;
  label: string;
}

export function selectOptionsOf(config: Record<string, unknown> | null | undefined): SelectOptionLike[] {
  const raw = (config ?? {})["options"] ?? (config ?? {})["choices"];
  if (!Array.isArray(raw)) return [];
  const out: SelectOptionLike[] = [];
  for (const o of raw) {
    if (typeof o === "string") out.push({ id: o, label: o });
    else if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      const id = typeof r["id"] === "string" ? r["id"] : typeof r["label"] === "string" ? r["label"] : null;
      const label = typeof r["label"] === "string" ? r["label"] : typeof r["name"] === "string" ? r["name"] : id;
      if (id) out.push({ id, label: label ?? id });
    }
  }
  return out;
}

function variantsFor(kind: FilterKind, field: FieldLike, ctx: PrepareContext): (id: string) => string[] {
  if (kind === "single_select" || kind === "multi_select") {
    const opts = selectOptionsOf(field.config);
    return (id) => {
      const o = opts.find((x) => x.id === id) ?? opts.find((x) => x.label === id);
      return o ? [...new Set([o.id, o.label, id])] : [id];
    };
  }
  return (id) => {
    const v = ctx.idVariants ? ctx.idVariants(id) : [id];
    return [...new Set([id, ...v])];
  };
}

export function prepareCondition(
  cond: FilterCondition,
  field: FieldLike,
  ctx: PrepareContext,
): Prepared | null {
  if (!FILTER_OPS.includes(cond.op)) {
    throw new FilterError(`Unknown filter operator "${String(cond.op)}"`, "UNSUPPORTED_FILTER_OPERATOR", cond.fieldId);
  }
  const type = normalizeFieldType(field.type);
  const kind = filterKindForField(type, field.config ?? null);
  const cfg = field.config ?? {};
  const tzCfg = typeof cfg["timeZone"] === "string" ? (cfg["timeZone"] as string) : undefined;
  const tz = resolveTimeZone(tzCfg, ctx.timeZone);
  const dctx: DateContext = { now: ctx.now, timeZone: tz };
  const op = cond.op;
  const v = cond.value;
  const base = { kind, tz };

  if (kind === "none") throw bad(cond, type);
  if (op === "empty" || op === "notEmpty") {
    if (kind === "checkbox") return { ...base, op: "eq", bool: op === "notEmpty" };
    return { ...base, op };
  }

  switch (kind) {
    case "text":
    case "array": {
      const untyped = kind === "text" && isUntypedFormula(type, cfg);
      if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        if (!untyped) throw bad(cond, type);
        if (isBlank(v)) return null;
        return { ...base, op, num: toNum(v, cond), numericText: true };
      }
      if (["eq", "neq", "contains", "notContains", "startsWith", "endsWith"].includes(op)) {
        if (kind === "array" && (op === "startsWith" || op === "endsWith")) throw bad(cond, type);
        if (isBlank(v)) return null;
        return { ...base, op: op as CanonOp, text: toText(v) };
      }
      throw bad(cond, type);
    }
    case "number": {
      if (!["eq", "neq", "gt", "gte", "lt", "lte"].includes(op)) throw bad(cond, type);
      if (isBlank(v)) return null;
      return { ...base, op: op as CanonOp, num: toNum(v, cond) };
    }
    case "date":
    case "datetime": {
      const canon = DATE_OP_MAP[op];
      if (!canon) throw bad(cond, type);
      if (canon === "within") {
        const range = resolveWithinRange(v, dctx);
        return range ? { ...base, op: "within", range } : null;
      }
      const d = resolveDateOperand(v, dctx);
      return d ? { ...base, op: canon, date: d } : null;
    }
    case "checkbox": {
      if (op !== "eq" && op !== "neq") throw bad(cond, type);
      if (v === undefined || v === null || v === "") return null;
      let b: boolean;
      if (typeof v === "boolean") b = v;
      else if (v === 1 || v === "true" || v === "1" || v === "checked") b = true;
      else if (v === 0 || v === "false" || v === "0" || v === "unchecked") b = false;
      else throw new FilterError(`Checkbox filter expects true/false`, "INVALID_FILTER_VALUE", cond.fieldId);
      return { ...base, op: "eq", bool: op === "eq" ? b : !b };
    }
    case "single_select": {
      const vf = variantsFor(kind, field, ctx);
      const canon: CanonOp | undefined =
        op === "eq" ? "anyOf" : op === "neq" ? "noneOf" : op === "anyOf" || op === "hasAnyOf" ? "anyOf" : op === "noneOf" ? "noneOf" : undefined;
      if (!canon) throw bad(cond, type);
      const ids = idList(v);
      if (ids.length === 0) return null;
      return { ...base, op: canon, ids: ids.map(vf) };
    }
    case "multi_select":
    case "collaborator": {
      const vf = variantsFor(kind, field, ctx);
      if (op === "isMe") {
        if (kind !== "collaborator") throw bad(cond, type);
        return { ...base, op: "hasAnyOf", ids: ctx.currentUserId ? [vf(ctx.currentUserId)] : [[]] };
      }
      const canon: CanonOp | undefined =
        op === "hasAnyOf" || op === "anyOf" || op === "contains"
          ? "hasAnyOf"
          : op === "hasAllOf"
            ? "hasAllOf"
            : op === "noneOf" || op === "notContains"
              ? "noneOf"
              : op === "eq"
                ? "exactly"
                : op === "neq"
                  ? "neq"
                  : undefined;
      if (!canon) throw bad(cond, type);
      const ids = idList(v);
      if (ids.length === 0) return null;
      return { ...base, op: canon, ids: ids.map(vf) };
    }
    case "user": {
      const vf = variantsFor(kind, field, ctx);
      if (op === "isMe") return { ...base, op: "anyOf", ids: ctx.currentUserId ? [vf(ctx.currentUserId)] : [[]] };
      const canon: CanonOp | undefined =
        op === "eq" || op === "anyOf" || op === "hasAnyOf" ? "anyOf" : op === "neq" || op === "noneOf" ? "noneOf" : undefined;
      if (!canon) throw bad(cond, type);
      const ids = idList(v);
      if (ids.length === 0) return null;
      return { ...base, op: canon, ids: ids.map(vf) };
    }
    case "link": {
      if (op === "contains" || op === "notContains") {
        if (isBlank(v)) return null;
        return { ...base, op, text: toText(v) };
      }
      const vf = variantsFor(kind, field, ctx);
      const canon: CanonOp | undefined =
        op === "hasAnyOf" || op === "anyOf" || op === "eq" ? "hasAnyOf" : op === "hasAllOf" ? "hasAllOf" : op === "noneOf" || op === "neq" ? "noneOf" : undefined;
      if (!canon) throw bad(cond, type);
      const ids = idList(v);
      if (ids.length === 0) return null;
      return { ...base, op: canon, ids: ids.map(vf) };
    }
    case "attachment":
      throw bad(cond, type);
    default:
      throw bad(cond, type);
  }
}
