import type { QueryClient } from "@tanstack/react-query";
import { ApiProblemError, request, type FilterAst } from "../api.ts";

/** CONTRACTS §3 record wire format. */
export interface RecordWire {
  id: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  rowNumber?: number;
  manualOrder?: string;
  fields: Record<string, unknown>;
  errors?: Record<string, string>;
}

export interface RecordsPage {
  records: RecordWire[];
  nextCursor: string | null;
  totalCount?: number;
}

export interface RecordsQueryBody {
  filter?: FilterAst | null;
  sort?: { field: string; direction: "asc" | "desc" }[];
  search?: string;
  viewId?: string;
  pageSize?: number;
  cursor?: string | null;
  fields?: string[];
}

/** `GET …/records/:r/history` (record revision history, newest first). */
export type HistoryChangeWire =
  | { fieldId: string; before?: unknown; after?: unknown }
  | { fieldId: string; added: { id: string; name: string }[]; removed: { id: string; name: string }[] };

export interface HistoryEntryWire {
  id: string;
  seq: number;
  at: string;
  kind: "created" | "updated" | "deleted" | "restored";
  actor: { id: string; name: string; email: string } | null;
  source: "user" | "automation" | "form" | "import" | "undo" | "redo" | "restore" | "system";
  sourceName?: string;
  duplicatedFrom?: { id: string; name: string };
  changes: HistoryChangeWire[];
  detailed: boolean;
}

export interface HistoryFieldWire {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  deleted: boolean;
}

export interface RecordHistoryPage {
  entries: HistoryEntryWire[];
  fields: Record<string, HistoryFieldWire>;
  nextCursor: string | null;
  retentionDays: number | null;
}

const tbl = (b: string, t: string) => `/v1/bases/${b}/tables/${t}`;

function isNotFound(e: unknown): boolean {
  return e instanceof ApiProblemError && (e.problem.status === 404 || e.problem.status === 405);
}

let opSeq = 0;
export function newClientOpId(): string {
  opSeq += 1;
  return `cop_${Date.now().toString(36)}_${opSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Server copy of a record from a write response; `null` when the body was empty. */
function unwrapRecord(res: unknown): RecordWire {
  const r = res as { record?: RecordWire } & RecordWire;
  return (r && r.record ? r.record : r && r.id ? r : null) as RecordWire;
}

export const recordsApi = {
  query(baseId: string, tableId: string, body: RecordsQueryBody, signal?: AbortSignal) {
    const clean: Record<string, unknown> = { ...body };
    if (!clean["filter"]) delete clean["filter"];
    if (!clean["search"]) delete clean["search"];
    if (!clean["cursor"]) delete clean["cursor"];
    if (Array.isArray(clean["sort"]) && (clean["sort"] as unknown[]).length === 0) delete clean["sort"];
    return request<RecordsPage>(`${tbl(baseId, tableId)}/records/query`, {
      method: "POST",
      json: clean,
      ...(signal ? { signal } : {}),
    });
  },

  /** Aggregates over every matching record (`POST …/records/group` without groupBy). */
  async aggregate(
    baseId: string,
    tableId: string,
    body: { filter?: FilterAst | null; search?: string; aggregates: { op: string; fieldId?: string }[] },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const json: Record<string, unknown> = { aggregates: body.aggregates };
    if (body.filter) json["filter"] = body.filter;
    if (body.search) json["search"] = body.search;
    const res = await request<{ groups: { count: number; aggregates: Record<string, unknown> }[] }>(
      `${tbl(baseId, tableId)}/records/group`,
      { method: "POST", json, ...(signal ? { signal } : {}) },
    );
    const g = res?.groups?.[0];
    return g ? { count: g.count, ...g.aggregates } : { count: 0 };
  },

  async get(baseId: string, tableId: string, recordId: string) {
    return unwrapRecord(await request(`${tbl(baseId, tableId)}/records/${recordId}`));
  },

  history(baseId: string, tableId: string, recordId: string, opts: { cursor?: string | null; limit?: number } = {}, signal?: AbortSignal) {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.limit) qs.set("limit", String(opts.limit));
    const q = qs.toString();
    return request<RecordHistoryPage>(`${tbl(baseId, tableId)}/records/${recordId}/history${q ? `?${q}` : ""}`, {
      ...(signal ? { signal } : {}),
    });
  },

  /** Resolves `null` if the server answered without a body (record was still created). */
  async create(baseId: string, tableId: string, fields: Record<string, unknown>, typecast = false): Promise<RecordWire | null> {
    return unwrapRecord(
      await request(`${tbl(baseId, tableId)}/records`, {
        method: "POST",
        json: { fields, ...(typecast ? { typecast } : {}) },
        clientOpId: newClientOpId(),
      }),
    );
  },

  /** Batch create (falls back to sequential creates if the batch route is missing). */
  async createMany(baseId: string, tableId: string, rows: Record<string, unknown>[], typecast = false) {
    const out: RecordWire[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      try {
        const res = await request<{ records: RecordWire[] }>(`${tbl(baseId, tableId)}/records/batch`, {
          method: "POST",
          json: { records: chunk.map((fields) => ({ fields })), ...(typecast ? { typecast } : {}) },
          clientOpId: newClientOpId(),
        });
        out.push(...(res?.records ?? []));
      } catch (e) {
        if (!isNotFound(e)) throw e;
        for (const fields of chunk) {
          const rec = await recordsApi.create(baseId, tableId, fields, typecast);
          if (rec) out.push(rec);
        }
      }
    }
    return out;
  },

  async patch(
    baseId: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
    opts: { version?: number; typecast?: boolean; clientOpId?: string } = {},
  ) {
    const headers: Record<string, string> = {};
    if (opts.version !== undefined) headers["If-Match"] = `"${opts.version}"`;
    const rec = unwrapRecord(
      await request(`${tbl(baseId, tableId)}/records/${recordId}`, {
        method: "PATCH",
        headers,
        json: {
          fields,
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.typecast ? { typecast: true } : {}),
        },
        clientOpId: opts.clientOpId ?? newClientOpId(),
      }),
    );
    // Contract: PATCH returns the updated record. Tolerate an empty body.
    return rec ?? (await recordsApi.get(baseId, tableId, recordId));
  },

  /** Batch update (bulk paste / fill / clear). Falls back to sequential PATCHes. */
  async patchMany(
    baseId: string,
    tableId: string,
    rows: { id: string; fields: Record<string, unknown> }[],
    typecast = false,
  ) {
    const out: RecordWire[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      try {
        const res = await request<{ records: RecordWire[] }>(`${tbl(baseId, tableId)}/records/batch`, {
          method: "PATCH",
          json: { records: chunk, ...(typecast ? { typecast } : {}) },
          clientOpId: newClientOpId(),
        });
        out.push(...(res?.records ?? []));
      } catch (e) {
        if (!isNotFound(e)) throw e;
        for (const r of chunk) out.push(await recordsApi.patch(baseId, tableId, r.id, r.fields, { typecast }));
      }
    }
    return out;
  },

  async remove(baseId: string, tableId: string, recordId: string) {
    await request<void>(`${tbl(baseId, tableId)}/records/${recordId}`, {
      method: "DELETE",
      clientOpId: newClientOpId(),
    });
  },

  async removeMany(baseId: string, tableId: string, ids: string[]) {
    if (ids.length === 1) return recordsApi.remove(baseId, tableId, ids[0]!);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      try {
        await request<void>(`${tbl(baseId, tableId)}/records/batch-delete`, {
          method: "POST",
          json: { ids: chunk },
          clientOpId: newClientOpId(),
        });
      } catch (e) {
        if (!isNotFound(e)) throw e;
        for (const id of chunk) await recordsApi.remove(baseId, tableId, id);
      }
    }
  },

  async duplicate(baseId: string, tableId: string, recordId: string, fallbackFields?: Record<string, unknown>): Promise<RecordWire | null> {
    try {
      return unwrapRecord(
        await request(`${tbl(baseId, tableId)}/records/${recordId}/duplicate`, {
          method: "POST",
          clientOpId: newClientOpId(),
        }),
      );
    } catch (e) {
      if (!isNotFound(e) || !fallbackFields) throw e;
      return recordsApi.create(baseId, tableId, fallbackFields);
    }
  },

  /** Manual reorder: place the record directly before `before` or after `after`. */
  async move(baseId: string, tableId: string, recordId: string, pos: { before?: string | null; after?: string | null }) {
    return unwrapRecord(
      await request(`${tbl(baseId, tableId)}/records/${recordId}/move`, {
        method: "POST",
        json: pos,
        clientOpId: newClientOpId(),
      }),
    );
  },
};

/** Human-readable message from any API error. */
export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof ApiProblemError) return e.problem.detail || e.problem.title || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

// ---------------------------------------------------------------------------
// Cache helpers: records live in several query shapes under
// ["records", baseId, tableId, ...] (infinite pages, plain arrays, {records})
// plus ["record", baseId, tableId, recordId].
// ---------------------------------------------------------------------------

type AnyRecord = { id: string; version?: number; fields: Record<string, unknown> };

function mapShape(data: unknown, fn: (r: AnyRecord) => AnyRecord | null): unknown {
  if (!data) return data;
  if (Array.isArray(data)) {
    let changed = false;
    const out: AnyRecord[] = [];
    for (const r of data as AnyRecord[]) {
      const n = r && typeof r === "object" && "id" in r ? fn(r) : r;
      if (n !== r) changed = true;
      if (n) out.push(n);
    }
    return changed ? out : data;
  }
  const d = data as Record<string, unknown>;
  if (Array.isArray(d["pages"])) {
    const pages = (d["pages"] as unknown[]).map((p) => mapShape(p, fn));
    return pages.some((p, i) => p !== (d["pages"] as unknown[])[i]) ? { ...d, pages } : data;
  }
  if (Array.isArray(d["records"])) {
    const recs = mapShape(d["records"], fn);
    if (recs === d["records"]) return data;
    const removed = (d["records"] as unknown[]).length - (recs as unknown[]).length;
    const next: Record<string, unknown> = { ...d, records: recs };
    if (removed > 0 && typeof d["totalCount"] === "number") next["totalCount"] = (d["totalCount"] as number) - removed;
    return next;
  }
  if (d["record"] && typeof d["record"] === "object") {
    const r = fn(d["record"] as AnyRecord);
    return r === d["record"] ? data : r ? { ...d, record: r } : data;
  }
  if (typeof d["id"] === "string" && d["fields"]) {
    return fn(d as unknown as AnyRecord) ?? data;
  }
  return data;
}

/** Apply `fn` to every cached copy of matching records (return null to remove). */
export function updateRecordCaches(
  qc: QueryClient,
  baseId: string,
  tableId: string,
  fn: (r: AnyRecord) => AnyRecord | null,
): void {
  qc.setQueriesData({ queryKey: ["records", baseId, tableId] }, (old: unknown) => mapShape(old, fn));
  qc.setQueriesData({ queryKey: ["record", baseId, tableId] }, (old: unknown) => mapShape(old, fn));
}

/** Replace cached copies of `rec` with the server copy (only if newer or equal). */
export function putRecordInCaches(qc: QueryClient, baseId: string, tableId: string, rec: RecordWire): void {
  updateRecordCaches(qc, baseId, tableId, (r) => {
    if (r.id !== rec.id) return r;
    if (typeof r.version === "number" && typeof rec.version === "number" && r.version > rec.version) return r;
    return { ...r, ...rec, fields: { ...rec.fields } };
  });
}

export function removeRecordsFromCaches(qc: QueryClient, baseId: string, tableId: string, ids: string[]): void {
  const set = new Set(ids);
  qc.setQueriesData({ queryKey: ["records", baseId, tableId] }, (old: unknown) =>
    mapShape(old, (r) => (set.has(r.id) ? null : r)),
  );
}
