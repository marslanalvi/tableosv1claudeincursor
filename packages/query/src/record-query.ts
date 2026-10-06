import {
  compileFilterToSql,
  compileSearchToSql,
  FilterError,
  sortKeysFor,
  SqlParams,
  type SqlFieldInfo,
  type SqlKeyType,
} from "@tabula/filter";
import { decodeRecordCursor, encodeRecordCursor, hashString } from "./cursor.js";
import type { DecodedCursor, PlanQueryContext, RecordQueryInput, RecordQueryPlan, SortKeyPlan, SortSpec } from "./types.js";

export const MANUAL_ORDER_FIELD = "manualOrder";

/** Columns selected for every record row (feed straight into the serializer). */
export const RECORD_COLUMNS = [
  "id",
  "version",
  "row_number",
  "manual_order",
  "cells",
  "computed",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const;

function uniqueFields(fields: Map<string, SqlFieldInfo>): SqlFieldInfo[] {
  const seen = new Map<string, SqlFieldInfo>();
  for (const f of fields.values()) seen.set(f.id, f);
  return [...seen.values()];
}

/** Resolve sort specs to typed key expressions (alias `r`). Throws FilterError for unknown fields. */
export function resolveSortKeys(
  sort: SortSpec[] | undefined,
  fields: Map<string, SqlFieldInfo>,
  params: SqlParams,
  alias = "r",
): SortKeyPlan[] {
  const keys: SortKeyPlan[] = [];
  for (const s of sort ?? []) {
    const direction = s.direction === "desc" ? "desc" : "asc";
    if (s.fieldId === MANUAL_ORDER_FIELD) {
      keys.push({ fieldId: MANUAL_ORDER_FIELD, expr: `${alias}.manual_order`, type: "text", direction });
      continue;
    }
    const f = fields.get(s.fieldId);
    if (!f) throw new FilterError(`Unknown sort field: ${s.fieldId}`, "UNKNOWN_SORT_FIELD", s.fieldId);
    for (const k of sortKeysFor(f, alias, params)) {
      keys.push({ fieldId: s.fieldId, expr: k.expr, type: k.type, direction });
    }
  }
  // Ties keep the table's manual order (Airtable behaviour), then id.
  if (!keys.some((k) => k.fieldId === MANUAL_ORDER_FIELD)) {
    keys.push({ fieldId: MANUAL_ORDER_FIELD, expr: `${alias}.manual_order`, type: "text", direction: "asc" });
  }
  return keys;
}

/** Plan a record list query. `params` must already contain any leading params (e.g. table id). */
export function planRecordQuery(
  input: RecordQueryInput,
  ctx: PlanQueryContext,
  params: SqlParams = new SqlParams(),
): RecordQueryPlan {
  const pageSize = Math.min(Math.max(Math.trunc(input.pageSize) || 100, 1), 500);
  const where: string[] = [];
  const opts = { ...ctx, params };
  for (const flt of [input.viewFilter, input.filter]) {
    if (flt === undefined || flt === null) continue;
    const isView = flt === input.viewFilter;
    const c = compileFilterToSql(flt, undefined, { ...opts, unknownField: isView ? "ignore" : ctx.unknownField ?? "error" });
    if (c.sql !== "TRUE") where.push(c.sql);
  }
  if (input.search && input.search.trim() !== "") {
    const s = compileSearchToSql(input.search, ctx.searchFields ?? uniqueFields(ctx.fields), { params });
    where.push(s.sql);
  }
  const whereParamCount = params.values.length;
  const keys = resolveSortKeys(input.sort, ctx.fields, params);
  const idDirection = keys[0]?.direction ?? "asc";
  const signature = hashString(
    JSON.stringify([(input.sort ?? []).map((s) => [s.fieldId, s.direction]), keys.length]),
  );
  const legacyManual = (input.sort ?? []).length === 0;
  const plan: RecordQueryPlan = {
    pageSize,
    limit: pageSize + 1,
    keys,
    idDirection,
    whereSql: where.length ? where.map((w) => `(${w})`).join(" AND ") : "TRUE",
    params: params.values,
    whereParamCount,
    signature,
  };
  if (input.cursor) {
    const cur = decodeRecordCursor(input.cursor, signature, legacyManual);
    if (cur.keys.length !== keys.length) {
      throw new FilterError("Cursor does not match this query; restart pagination", "INVALID_CURSOR");
    }
    plan.cursor = cur;
  }
  return plan;
}

/**
 * Keyset predicate "row comes strictly after the cursor" for keys ordered
 * `NULLS LAST` in their direction, then id in `idDirection`.
 */
export function cursorPredicate(
  keys: { ref: string; type: SqlKeyType; direction: "asc" | "desc" }[],
  idRef: string,
  idDirection: "asc" | "desc",
  cursor: DecodedCursor,
  params: SqlParams,
): string {
  const ors: string[] = [];
  const eqs: string[] = [];
  keys.forEach((k, i) => {
    const v = cursor.keys[i] ?? null;
    if (v !== null) {
      const p = params.add(v, k.type);
      const op = k.direction === "asc" ? ">" : "<";
      ors.push([...eqs, `(${k.ref} ${op} ${p} OR ${k.ref} IS NULL)`].join(" AND "));
      eqs.push(`${k.ref} = ${p}`);
    } else {
      // Nothing sorts after NULL except other NULLs (handled by equality).
      eqs.push(`${k.ref} IS NULL`);
    }
  });
  const idOp = idDirection === "asc" ? ">" : "<";
  ors.push([...eqs, `${idRef} ${idOp} ${params.add(cursor.id, "uuid")}`].join(" AND "));
  return ors.map((o) => `(${o})`).join(" OR ");
}

export interface RecordQuerySqlOptions {
  /** SQL placeholder for the table id (already in params). */
  tableIdSql: string;
  params: SqlParams;
}

/** Full page query: rows (RECORD_COLUMNS) + `_k<i>` key texts for the next cursor. */
export function buildRecordPageSql(plan: RecordQueryPlan, o: RecordQuerySqlOptions): string {
  const keySel = plan.keys.map((k, i) => `${k.expr} AS _k${i}`).join(",\n    ");
  const inner = `SELECT ${RECORD_COLUMNS.map((c) => `r.${c}`).join(", ")}${keySel ? `,\n    ${keySel}` : ""}
  FROM data.records r
  WHERE r.table_id = ${o.tableIdSql} AND r.deleted_at IS NULL AND (${plan.whereSql})`;
  const refs = plan.keys.map((k, i) => ({ ref: `q._k${i}`, type: k.type, direction: k.direction }));
  const cursorSql = plan.cursor ? cursorPredicate(refs, "q.id", plan.idDirection, plan.cursor, o.params) : "TRUE";
  const order = [
    ...refs.map((k) => `${k.ref} ${k.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`),
    `q.id ${plan.idDirection === "desc" ? "DESC" : "ASC"}`,
  ].join(", ");
  const keyText = plan.keys.map((_, i) => `q._k${i}::text AS _kt${i}`).join(", ");
  return `SELECT q.*${keyText ? `, ${keyText}` : ""} FROM (
  ${inner}
) q
WHERE ${cursorSql}
ORDER BY ${order}
LIMIT ${Math.trunc(plan.limit)}`;
}

/** Exact count of rows matching the plan's WHERE (cursor ignored). */
export function buildRecordCountSql(plan: RecordQueryPlan, o: RecordQuerySqlOptions): string {
  return `SELECT count(*)::bigint AS n FROM data.records r
  WHERE r.table_id = ${o.tableIdSql} AND r.deleted_at IS NULL AND (${plan.whereSql})`;
}

/** Cursor for the row after which the next page starts. */
export function nextCursorFromRow(plan: RecordQueryPlan, row: Record<string, unknown>): string {
  const keys = plan.keys.map((_, i) => {
    const v = row[`_kt${i}`];
    return v === null || v === undefined ? null : String(v);
  });
  return encodeRecordCursor(plan.signature, { keys, id: String(row["id"]) });
}
