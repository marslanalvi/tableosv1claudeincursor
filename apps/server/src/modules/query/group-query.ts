import type { TabulaDb } from "@tabula/db";
import {
  compileFilterToSql,
  compileSearchToSql,
  dateExpr,
  emptyExpr,
  FilterError,
  groupKeyFor,
  kindOf,
  numExpr,
  SqlParams,
  tsExpr,
  type SqlFieldInfo,
} from "@tabula/filter";
import { pid } from "../../lib/public-ids.js";
import { executeRawQuery } from "./raw-sql.js";
import { buildPlanContext, loadQueryFields, loadSqlFieldInfos, type UserQueryContext } from "./context.js";
import { loadViewForQuery } from "./execute-record-query.js";
import { loadRecordNames, loadUsers } from "../records/serialize.js";

export type AggregateOp = "count" | "sum" | "avg" | "min" | "max" | "filled" | "empty" | "unique";

export interface GroupAggregateSpec {
  op: AggregateOp;
  fieldId?: string | undefined;
}

export interface GroupQueryInput {
  filter?: unknown;
  search?: string | undefined;
  viewId?: string | undefined;
  groupBy?: { fieldId: string; direction?: "asc" | "desc" | undefined }[] | undefined;
  aggregates?: GroupAggregateSpec[] | undefined;
}

export interface GroupResult {
  /** Stable string key of the group (JSON of the raw group values). */
  key: string;
  /** Wire value of the first-level group (null = empty group). */
  value: unknown;
  /** Wire values of every level. */
  values: unknown[];
  count: number;
  aggregates: Record<string, number | string | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function aggregateSql(op: AggregateOp, f: SqlFieldInfo | null, a: string, p: SqlParams): { sql: string; numeric: boolean } {
  if (op === "count") return { sql: "count(*)", numeric: true };
  if (!f) throw new FilterError(`Aggregate "${op}" requires a fieldId`, "INVALID_AGGREGATE");
  const kind = kindOf(f);
  switch (op) {
    case "filled":
      return { sql: `count(*) FILTER (WHERE NOT ${emptyExpr(f, a, p)})`, numeric: true };
    case "empty":
      return { sql: `count(*) FILTER (WHERE ${emptyExpr(f, a, p)})`, numeric: true };
    case "unique": {
      const g = groupKeyFor(f, a, p);
      return { sql: `count(DISTINCT ${g.key})`, numeric: true };
    }
    case "sum":
    case "avg":
      if (kind !== "number" && !(kind === "text" && f.type === "formula")) {
        throw new FilterError(`Aggregate "${op}" requires a numeric field`, "INVALID_AGGREGATE", f.id);
      }
      return { sql: `${op}(${numExpr(f, a)})`, numeric: true };
    case "min":
    case "max":
      if (kind === "date") return { sql: `${op}(${dateExpr(f, a)})`, numeric: false };
      if (kind === "datetime") return { sql: `to_char(${op}(${tsExpr(f, a)}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, numeric: false };
      if (kind === "number" || f.type === "formula") return { sql: `${op}(${numExpr(f, a)})`, numeric: true };
      throw new FilterError(`Aggregate "${op}" requires a number or date field`, "INVALID_AGGREGATE", f.id);
    default:
      throw new FilterError(`Unknown aggregate ${String(op)}`, "INVALID_AGGREGATE");
  }
}

export async function executeGroupQuery(
  db: TabulaDb,
  tableId: string,
  input: GroupQueryInput,
  opts: { user?: UserQueryContext | null } = {},
): Promise<{ groups: GroupResult[] }> {
  const fieldRows = await loadQueryFields(db, tableId);
  const infos = await loadSqlFieldInfos(db, fieldRows);
  const ctx = buildPlanContext(infos, opts.user ?? null);
  const p = new SqlParams([tableId]);
  const a = "r";

  const where: string[] = [];
  let searchFields = infos;
  if (input.viewId) {
    const view = await loadViewForQuery(db, tableId, input.viewId);
    if (view.filter) {
      const c = compileFilterToSql(view.filter, undefined, { ...ctx, params: p, unknownField: "ignore" });
      if (c.sql !== "TRUE") where.push(c.sql);
    }
    const hidden = new Set(view.hiddenFieldIds);
    searchFields = infos.filter((f) => !hidden.has(pid("fld", f.id)) && !hidden.has(f.id));
  }
  if (input.filter !== undefined && input.filter !== null) {
    const c = compileFilterToSql(input.filter, undefined, { ...ctx, params: p });
    if (c.sql !== "TRUE") where.push(c.sql);
  }
  if (input.search && input.search.trim()) {
    where.push(compileSearchToSql(input.search, searchFields, { params: p }).sql);
  }

  const levels = (input.groupBy ?? []).map((g) => {
    const f = ctx.fields.get(g.fieldId);
    if (!f) throw new FilterError(`Unknown group field: ${g.fieldId}`, "UNKNOWN_GROUP_FIELD", g.fieldId);
    return { f, dir: g.direction === "desc" ? "DESC" : "ASC", ...groupKeyFor(f, a, p) };
  });

  const aggSpecs = input.aggregates && input.aggregates.length ? input.aggregates : [{ op: "count" as const }];
  const aggs = aggSpecs.map((s, i) => {
    const f = s.fieldId ? ctx.fields.get(s.fieldId) ?? null : null;
    if (s.fieldId && !f) throw new FilterError(`Unknown aggregate field: ${s.fieldId}`, "UNKNOWN_FIELD", s.fieldId);
    const alias = s.fieldId ? `${s.op}:${s.fieldId}` : s.op;
    return { alias, i, ...aggregateSql(s.op, f, a, p) };
  });

  const select = [
    ...levels.map((l, i) => `${l.key} AS g${i}, ${l.sort.expr} AS s${i}`),
    "count(*)::bigint AS cnt",
    ...aggs.map((x) => `${x.sql} AS a${x.i}`),
  ];
  const groupBy = levels.map((_, i) => `g${i}, s${i}`);
  const order = levels.flatMap((l, i) => [`s${i} ${l.dir} NULLS LAST`, `g${i} ${l.dir} NULLS LAST`]);
  const q = `SELECT ${select.join(", ")}
    FROM data.records r
    WHERE r.table_id = $1::uuid AND r.deleted_at IS NULL${where.length ? ` AND ${where.map((w) => `(${w})`).join(" AND ")}` : ""}
    ${groupBy.length ? `GROUP BY ${groupBy.join(", ")}` : ""}
    ${order.length ? `ORDER BY ${order.join(", ")}` : ""}
    LIMIT 2000`;
  const rows = await executeRawQuery<Record<string, unknown>>(db, q, p.values);

  // Hydrate collaborator / user / link group values.
  const userIds = new Set<string>();
  const linkIds = new Set<string>();
  levels.forEach((l, i) => {
    const kind = kindOf(l.f);
    for (const r of rows) {
      const v = r[`g${i}`];
      const arr = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
      for (const x of arr) {
        if (typeof x !== "string" || !UUID_RE.test(x)) continue;
        if (kind === "collaborator" || kind === "user") userIds.add(x);
        if (kind === "link") linkIds.add(x);
      }
    }
  });
  const users = await loadUsers(db, [...userIds]);
  const linkNames = new Map<string, string>();
  for (const l of levels) {
    if (kindOf(l.f) !== "link" || !l.f.link) continue;
    for (const [k, v] of await loadRecordNames(db, l.f.link.peerTableId, [...linkIds])) linkNames.set(k, v);
  }

  const groups: GroupResult[] = rows.map((r) => {
    const raw = levels.map((_, i) => r[`g${i}`] ?? null);
    const values = levels.map((l, i) => {
      const v = r[`g${i}`] ?? null;
      if (v === null) return null;
      const kind = kindOf(l.f);
      if (kind === "collaborator") return (v as string[]).map((x) => users.get(x) ?? { id: x, name: "", email: "" });
      if (kind === "user") return users.get(String(v)) ?? null;
      if (kind === "link") return (v as string[]).map((x) => ({ id: UUID_RE.test(x) ? pid("rec", x) : x, name: linkNames.get(x) ?? "" }));
      if (kind === "attachment") return (v as string[]).map((x) => (UUID_RE.test(x) ? pid("att", x) : x));
      if (kind === "datetime" && typeof v === "string") return new Date(v).toISOString();
      return v;
    });
    const aggregates: Record<string, number | string | null> = {};
    for (const x of aggs) {
      const v = r[`a${x.i}`];
      aggregates[x.alias] = v === null || v === undefined ? null : x.numeric ? Number(v) : String(v);
    }
    return {
      key: JSON.stringify(raw),
      value: values[0] ?? null,
      values,
      count: Number(r["cnt"] ?? 0),
      aggregates,
    };
  });
  return { groups };
}
