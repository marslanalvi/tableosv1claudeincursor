import { sql } from "kysely";
import type { TabulaDb } from "@tabula/db";
import { FilterError, SqlParams, type SqlFieldInfo } from "@tabula/filter";
import {
  buildRecordCountSql,
  buildRecordPageSql,
  nextCursorFromRow,
  planRecordQuery,
  type RecordQueryInput,
  type SortSpec,
} from "@tabula/query";
import type { TabulaStorage } from "@tabula/storage";
import { parsePid, pid } from "../../lib/public-ids.js";
import {
  buildPlanContext,
  fieldInfoMap,
  loadQueryFields,
  loadSqlFieldInfos,
  type QueryFieldRow,
  type UserQueryContext,
} from "./context.js";
import { executeRawQuery } from "./raw-sql.js";
import { serializeRecords, type RecordRowLike, type RecordWire } from "../records/serialize.js";

export interface RecordQueryRequest {
  filter?: unknown;
  sort?: SortSpec[] | undefined;
  search?: string | undefined;
  viewId?: string | undefined;
  pageSize?: number | undefined;
  cursor?: string | null | undefined;
  fields?: string[] | undefined;
  /** Default: only on the first page (no cursor). */
  includeTotalCount?: boolean | undefined;
}

export interface RecordQueryResult {
  records: RecordWire[];
  nextCursor: string | null;
  totalCount?: number;
}

export class QueryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryNotFoundError";
  }
}

export interface LoadedView {
  id: string;
  filter: unknown;
  sorts: SortSpec[];
  hiddenFieldIds: string[];
}

/** Load a view of `tableId` (`viw_` or uuid). Throws QueryNotFoundError. */
export async function loadViewForQuery(
  db: TabulaDb,
  tableId: string,
  viewId: string,
  /** When given, other users' personal views are not found. */
  userId?: string,
): Promise<LoadedView> {
  const id = viewId.startsWith("viw_") ? parsePid(viewId, "viw") : viewId;
  const r = await sql<{ id: string; config: Record<string, unknown> }>`
    SELECT id, config FROM data.views
    WHERE id = ${id}::uuid AND table_id = ${tableId} AND deleted_at IS NULL
      AND (${userId ?? null}::uuid IS NULL OR visibility <> 'personal' OR owner_user_id = ${userId ?? null}::uuid)
  `.execute(db);
  const v = r.rows[0];
  if (!v) throw new QueryNotFoundError("View not found");
  const cfg = v.config ?? {};
  const filter = cfg["filter"] ?? cfg["filters"] ?? null;
  const sortsRaw = Array.isArray(cfg["sorts"]) ? cfg["sorts"] : Array.isArray(cfg["sort"]) ? cfg["sort"] : [];
  const sorts: SortSpec[] = [];
  for (const s of sortsRaw as unknown[]) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const fid = o["fieldId"] ?? o["field"];
    if (typeof fid !== "string") continue;
    sorts.push({ fieldId: fid, direction: o["direction"] === "desc" ? "desc" : "asc" });
  }
  const hidden = Array.isArray(cfg["hiddenFieldIds"]) ? (cfg["hiddenFieldIds"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { id: v.id, filter: filter && typeof filter === "object" ? filter : null, sorts, hiddenFieldIds: hidden };
}

/** Resolve requested projection ids (fld_/uuid) to uuids; unknown → FilterError (422). */
export function resolveProjection(fieldRows: QueryFieldRow[], ids: string[] | undefined): string[] | undefined {
  if (!ids) return undefined;
  const byKey = new Map<string, string>();
  for (const f of fieldRows) {
    byKey.set(f.id, f.id);
    byKey.set(pid("fld", f.id), f.id);
    byKey.set(f.name.toLowerCase(), f.id);
  }
  return ids.map((x) => {
    const id = byKey.get(x) ?? byKey.get(x.toLowerCase());
    if (!id) throw new FilterError(`Unknown field in projection: ${x}`, "UNKNOWN_FIELD", x);
    return id;
  });
}

export async function executeRecordQuery(
  db: TabulaDb,
  tableId: string,
  req: RecordQueryRequest,
  opts: { user?: UserQueryContext | null; storage?: TabulaStorage | null } = {},
): Promise<RecordQueryResult> {
  const fieldRows = await loadQueryFields(db, tableId);
  const infos = await loadSqlFieldInfos(db, fieldRows);
  const ctx = buildPlanContext(infos, opts.user ?? null);

  let viewFilter: unknown = undefined;
  let sort = req.sort;
  let searchFields: SqlFieldInfo[] = infos;
  if (req.viewId) {
    const view = await loadViewForQuery(db, tableId, req.viewId, opts.user?.userId);
    viewFilter = view.filter;
    if (!sort || sort.length === 0) {
      // Drop saved sorts on deleted fields instead of failing the view.
      sort = view.sorts.filter((s) => s.fieldId === "manualOrder" || ctx.fields.has(s.fieldId));
    }
    const hidden = new Set(view.hiddenFieldIds.flatMap((h) => [h, ctx.fields.get(h)?.id ?? h]));
    searchFields = infos.filter((f) => !hidden.has(f.id) && !hidden.has(pid("fld", f.id)));
  }

  const params = new SqlParams([tableId]);
  const input: RecordQueryInput = { pageSize: req.pageSize ?? 100 };
  if (req.filter !== undefined && req.filter !== null) input.filter = req.filter;
  if (viewFilter) input.viewFilter = viewFilter;
  if (sort && sort.length) input.sort = sort;
  if (req.search) input.search = req.search;
  if (req.cursor) input.cursor = req.cursor;
  const plan = planRecordQuery(input, { ...ctx, searchFields }, params);

  const projection = resolveProjection(fieldRows, req.fields);

  const pageSql = buildRecordPageSql(plan, { tableIdSql: "$1::uuid", params });
  const rows = await executeRawQuery<RecordRowLike & Record<string, unknown>>(db, pageSql, params.values);

  const hasMore = rows.length > plan.pageSize;
  const page = hasMore ? rows.slice(0, plan.pageSize) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? nextCursorFromRow(plan, last) : null;

  const records = await serializeRecords(db, tableId, page, {
    fields: fieldRows,
    fieldIds: projection,
    storage: opts.storage ?? null,
  });

  const result: RecordQueryResult = { records, nextCursor };
  const wantTotal = req.includeTotalCount ?? !req.cursor;
  if (wantTotal) {
    if (!req.cursor && !hasMore) {
      result.totalCount = page.length;
    } else {
      const countSql = buildRecordCountSql(plan, { tableIdSql: "$1::uuid", params });
      const c = await executeRawQuery<{ n: string }>(db, countSql, params.values.slice(0, plan.whereParamCount));
      result.totalCount = Number(c[0]?.n ?? 0);
    }
  }
  return result;
}

export { fieldInfoMap };
