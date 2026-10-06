import { FilterError, type FilterAst, type FilterCondition, type FilterNode } from "./ast.js";
import { parseFilterAst } from "./parse.js";
import { prepareCondition, type PrepareContext, type Prepared } from "./prepare.js";
import {
  boolExpr,
  dateExpr,
  displayExpr,
  elemIdsSql,
  emptyExpr,
  kindOf,
  linkPeersSql,
  metaColumn,
  numExpr,
  selectIdExpr,
  SqlParams,
  textExpr,
  tsDateExpr,
  type SqlFieldInfo,
} from "./sql-exprs.js";

export type SidecarKind = "text" | "num" | "time";

export interface CompileFilterOptions extends PrepareContext {
  /** Field metadata keyed by every accepted id spelling (uuid and `fld_…`). Preferred. */
  fields?: Map<string, SqlFieldInfo> | undefined;
  /** Legacy: fieldId → slot / type (used only when `fields` is absent). */
  fieldTypeByFieldId?: Map<string, string> | undefined;
  /** Alias for the records table in SQL (default `r`). */
  recordAlias?: string | undefined;
  /** Shared parameter list to append to (placeholders continue its numbering). */
  params?: SqlParams | undefined;
  /** What to do with conditions on unknown fields (default "error" → FilterError / 422). */
  unknownField?: "error" | "ignore" | "false" | undefined;
  /** Deprecated (sidecars are not used by the compiler). */
  useSidecars?: boolean | undefined;
  sidecarReadySlots?: Set<number> | undefined;
}

export interface CompiledFilterSql {
  sql: string;
  params: unknown[];
}

function textCmp(t: string, pr: Prepared, p: SqlParams): string {
  const q = p.add(pr.text ?? "", "text");
  const lt = `lower(${t})`;
  switch (pr.op) {
    case "eq":
      return `COALESCE(${lt} = ${q}, false)`;
    case "neq":
      return `NOT COALESCE(${lt} = ${q}, false)`;
    case "contains":
      return `COALESCE(strpos(${lt}, ${q}) > 0, false)`;
    case "notContains":
      return `NOT COALESCE(strpos(${lt}, ${q}) > 0, false)`;
    case "startsWith":
      return `COALESCE(left(${lt}, length(${q})) = ${q}, false)`;
    case "endsWith":
      return `COALESCE(right(${lt}, length(${q})) = ${q}, false)`;
    default:
      return "FALSE";
  }
}

const CMP: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

function numCmp(n: string, pr: Prepared, p: SqlParams): string {
  const v = p.add(pr.num, "float8");
  switch (pr.op) {
    case "eq":
      return `COALESCE(${n} = ${v}, false)`;
    case "neq":
      return `NOT COALESCE(${n} = ${v}, false)`;
    default: {
      const c = CMP[pr.op];
      return c ? `COALESCE(${n} ${c} ${v}, false)` : "FALSE";
    }
  }
}

function dateCmp(d: string, pr: Prepared, p: SqlParams): string {
  if (pr.op === "within" && pr.range) {
    return `COALESCE(${d} BETWEEN ${p.add(pr.range[0], "text")} AND ${p.add(pr.range[1], "text")}, false)`;
  }
  const v = p.add(pr.date, "text");
  switch (pr.op) {
    case "eq":
      return `COALESCE(${d} = ${v}, false)`;
    case "neq":
      return `NOT COALESCE(${d} = ${v}, false)`;
    default: {
      const c = CMP[pr.op];
      return c ? `COALESCE(${d} ${c} ${v}, false)` : "FALSE";
    }
  }
}

/** Set predicates over an "element id" subquery `(SELECT id, o ...)`. */
function setCmp(elems: string, pr: Prepared, p: SqlParams): string {
  const groups = pr.ids ?? [];
  const all = [...new Set(groups.flat())];
  const any = () => `EXISTS (SELECT 1 FROM ${elems} s WHERE s.id = ANY(${p.add(all, "text[]")}))`;
  const each = () =>
    groups.length === 0
      ? "TRUE"
      : groups.map((g) => `EXISTS (SELECT 1 FROM ${elems} s WHERE s.id = ANY(${p.add(g, "text[]")}))`).join(" AND ");
  switch (pr.op) {
    case "anyOf":
    case "hasAnyOf":
      return any();
    case "noneOf":
      return `NOT ${any()}`;
    case "hasAllOf":
      return `(${each()})`;
    case "exactly":
    case "neq": {
      const exact = `(${each()} AND NOT EXISTS (SELECT 1 FROM ${elems} s WHERE s.id IS NOT NULL AND s.id <> '' AND NOT (s.id = ANY(${p.add(all, "text[]")}))))`;
      return pr.op === "exactly" ? exact : `NOT ${exact}`;
    }
    default:
      return "FALSE";
  }
}

function compilePrepared(f: SqlFieldInfo, pr: Prepared, a: string, p: SqlParams): string {
  if (pr.op === "empty") return emptyExpr(f, a, p);
  if (pr.op === "notEmpty") return `NOT ${emptyExpr(f, a, p)}`;
  const kind = kindOf(f);
  switch (kind) {
    case "text":
      if (pr.numericText) return numCmp(numExpr(f, a), pr, p);
      return textCmp(textExpr(f, a), pr, p);
    case "array":
      return textCmp(textExpr(f, a), pr, p);
    case "number":
      return numCmp(numExpr(f, a), pr, p);
    case "date":
      return dateCmp(dateExpr(f, a), pr, p);
    case "datetime":
      return dateCmp(tsDateExpr(f, a, p.add(pr.tz, "text")), pr, p);
    case "checkbox":
      return pr.bool ? boolExpr(f, a) : `NOT ${boolExpr(f, a)}`;
    case "single_select": {
      const id = selectIdExpr(f, a);
      const all = [...new Set((pr.ids ?? []).flat())];
      const hit = `COALESCE(${id} = ANY(${p.add(all, "text[]")}), false)`;
      return pr.op === "noneOf" ? `NOT ${hit}` : hit;
    }
    case "multi_select":
    case "collaborator":
      return setCmp(elemIdsSql(f, a), pr, p);
    case "user": {
      const m = metaColumn(f, a);
      if (!m) return "FALSE";
      const all = [...new Set((pr.ids ?? []).flat())];
      const hit = `COALESCE((${m.expr})::text = ANY(${p.add(all, "text[]")}), false)`;
      return pr.op === "noneOf" ? `NOT ${hit}` : hit;
    }
    case "link": {
      const peers = linkPeersSql(f, a, p);
      if (!peers) return pr.op === "noneOf" || pr.op === "notContains" ? "TRUE" : "FALSE";
      if (pr.op === "contains" || pr.op === "notContains") {
        const prim = f.link?.peerPrimary;
        const name = prim ? displayExpr(prim, "pp", p, 1) : "NULL::text";
        const hit = `EXISTS (SELECT 1 FROM ${peers} pp WHERE COALESCE(strpos(lower(${name}), ${p.add(pr.text ?? "", "text")}) > 0, false))`;
        return pr.op === "contains" ? hit : `NOT ${hit}`;
      }
      return setCmp(`(SELECT pq.id::text AS id, pq.o FROM ${peers} pq)`, pr, p);
    }
    default:
      return "FALSE";
  }
}

function lookupField(cond: FilterCondition, options: CompileFilterOptions, legacySlots?: Map<string, number>): SqlFieldInfo | null {
  const f = options.fields?.get(cond.fieldId);
  if (f) return f;
  if (!options.fields && legacySlots) {
    const slot = legacySlots.get(cond.fieldId);
    if (slot !== undefined) {
      return { id: cond.fieldId, slot, type: options.fieldTypeByFieldId?.get(cond.fieldId) ?? "text", config: {}, isComputed: false };
    }
  }
  return null;
}

function compileNode(
  node: FilterNode,
  options: CompileFilterOptions,
  a: string,
  p: SqlParams,
  legacySlots?: Map<string, number>,
): string | null {
  if (node.kind === "condition") {
    const f = lookupField(node, options, legacySlots);
    if (!f) {
      const mode = options.unknownField ?? "error";
      if (mode === "ignore") return null;
      if (mode === "false") return "FALSE";
      throw new FilterError(`Unknown field in filter: ${node.fieldId}`, "UNKNOWN_FILTER_FIELD", node.fieldId);
    }
    const pr = prepareCondition(node, { id: f.id, type: f.type, config: f.config }, options);
    if (!pr) return null;
    return `(${compilePrepared(f, pr, a, p)})`;
  }
  const parts = node.children
    .map((c) => compileNode(c, options, a, p, legacySlots))
    .filter((x): x is string => x !== null);
  if (parts.length === 0) return null;
  return `(${parts.join(node.kind === "and" ? " AND " : " OR ")})`;
}

/**
 * Compile a filter AST to a SQL boolean over `data.records` (alias `r`).
 * Incomplete conditions are dropped; an empty result compiles to `TRUE`.
 * Throws `FilterError` for unknown fields/operators and invalid operands.
 */
export function compileFilterToSql(
  filter: FilterAst | unknown,
  fieldSlotById: Map<string, number> | undefined,
  options: CompileFilterOptions = {},
): CompiledFilterSql {
  const ast = parseFilterAst(filter);
  const p = options.params ?? new SqlParams();
  if (!ast) return { sql: "TRUE", params: p.values };
  const a = options.recordAlias ?? "r";
  const sql = compileNode(ast, options, a, p, fieldSlotById) ?? "TRUE";
  return { sql, params: p.values };
}

/** SQL predicate for free-text search across the given fields' display values. */
export function compileSearchToSql(
  search: string,
  fields: SqlFieldInfo[],
  options: { recordAlias?: string; params?: SqlParams } = {},
): CompiledFilterSql {
  const p = options.params ?? new SqlParams();
  const q = search.trim().toLowerCase();
  if (q === "") return { sql: "TRUE", params: p.values };
  const a = options.recordAlias ?? "r";
  const qp = p.add(q, "text");
  const parts: string[] = [];
  for (const f of fields) {
    const kind = kindOf(f);
    if (kind === "checkbox" || kind === "none" || kind === "attachment") continue;
    if (kind === "datetime" && metaColumn(f, a)) continue;
    const d = displayExpr(f, a, p);
    if (d === "NULL") continue;
    parts.push(`COALESCE(strpos(lower(${d}), ${qp}) > 0, false)`);
  }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "FALSE", params: p.values };
}
