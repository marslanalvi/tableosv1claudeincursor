import { createHash } from "node:crypto";
import type { TabulaDb } from "@tabula/db";
import type { TabulaStorage } from "@tabula/storage";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import { pid } from "../../lib/public-ids.js";
import { withBaseTx } from "../../kernel/mutation.js";
import { compileForUser } from "../access/compile.js";
import { loadTableFieldRows } from "../schema/table-schema.js";
import { createFieldInTx, dedupeName, deleteFieldInTx, setPrimaryFieldInTx, updateFieldInTx, type SchemaOpContext } from "../schema/field-ops.js";
import { createRecordsInTx, deleteRecordsInTx, MAX_BATCH, updateRecordsInTx, type WriteContext } from "../records/write.js";
import { loadSerializeFields, serializeRecordsByIds, type SerializeFieldRow } from "../records/serialize.js";

/**
 * Synced tables. A destination table mirrors a source table from another base:
 * every source field becomes a read-only field in the destination (computed and
 * relational values arrive as their displayed value) and records are created,
 * updated and deleted to match. Runs as a "system" mutation so realtime clients
 * see the changes; it is never undoable.
 */

export interface SyncDeps {
  db: TabulaDb;
  redis?: Redis | null;
  storage?: TabulaStorage | null;
}

export interface SyncRow {
  id: string;
  workspace_id: string;
  base_id: string;
  table_id: string;
  source_base_id: string;
  source_table_id: string;
  owner_user_id: string;
  field_map: Record<string, string>;
  status: "active" | "paused" | "error";
  interval_minutes: number;
  last_synced_at: Date | null;
  last_error: string | null;
  last_record_count: number | null;
}

export class SyncError extends Error {}

/** Field types copied as-is (config and values round-trip unchanged). */
const SAME_TYPES = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "number",
  "currency",
  "percent",
  "rating",
  "duration",
  "checkbox",
  "date",
  "datetime",
  "single_select",
  "multi_select",
  "barcode",
  "json",
]);
const NUMERIC_ROLLUPS = new Set(["sum", "avg", "average", "min", "max", "count", "counta", "count_all", "countall", "count_non_empty"]);
const MAX_SYNC_RECORDS = 50_000;

type Conv = "same" | "number" | "datetime" | "checkbox" | "text" | "files";

export interface MappedField {
  type: string;
  config: Record<string, unknown>;
  conv: Conv;
}

/** Destination field type for a source field; null = not synced (buttons). */
export function mapSourceField(f: Pick<SerializeFieldRow, "type" | "config">): MappedField | null {
  if (SAME_TYPES.has(f.type)) return { type: f.type, config: { ...f.config }, conv: "same" };
  switch (f.type) {
    case "button":
      return null;
    case "count":
    case "autonumber":
      return { type: "number", config: { precision: 0 }, conv: "number" };
    case "rollup": {
      const agg = String(f.config["aggregation"] ?? "").toLowerCase();
      return NUMERIC_ROLLUPS.has(agg) ? { type: "number", config: { precision: 2 }, conv: "number" } : { type: "text", config: {}, conv: "text" };
    }
    case "formula": {
      const rt = String(f.config["resultType"] ?? "");
      if (rt === "number") return { type: "number", config: { precision: 2 }, conv: "number" };
      if (rt === "checkbox") return { type: "checkbox", config: {}, conv: "checkbox" };
      if (rt === "date") return { type: "datetime", config: {}, conv: "datetime" };
      return { type: "text", config: {}, conv: "text" };
    }
    case "created_time":
    case "modified_time":
      return { type: "datetime", config: {}, conv: "datetime" };
    case "attachment":
      return { type: "long_text", config: {}, conv: "files" };
    default:
      return { type: "text", config: {}, conv: "text" };
  }
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function wireText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(wireText).filter((s) => s !== "").join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "label", "text", "filename", "email"]) if (typeof o[k] === "string") return o[k] as string;
    if ("value" in o) return wireText(o["value"]);
    return JSON.stringify(o);
  }
  return "";
}

function convertValue(conv: Conv, v: unknown): unknown {
  if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) return null;
  switch (conv) {
    case "same":
      return v;
    case "number": {
      const n = typeof v === "number" ? v : Number(wireText(Array.isArray(v) ? v[0] : v));
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return v === true || v === 1 || v === "true" ? true : null;
    case "datetime": {
      const s = wireText(Array.isArray(v) ? v[0] : v);
      return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
    }
    case "files":
      return (Array.isArray(v) ? v : [v])
        .map((a) => {
          const o = a as { filename?: string; url?: string };
          return [o.filename, o.url].filter(Boolean).join(" — ");
        })
        .filter(Boolean)
        .join("\n");
    default: {
      const s = wireText(v);
      return s === "" ? null : s;
    }
  }
}

export async function loadSync(db: TabulaDb, where: { id?: string; tableId?: string }): Promise<SyncRow | null> {
  const r = where.id
    ? await sql<SyncRow>`SELECT * FROM data.table_syncs WHERE id = ${where.id}`.execute(db)
    : await sql<SyncRow>`SELECT * FROM data.table_syncs WHERE table_id = ${where.tableId!}`.execute(db);
  return r.rows[0] ?? null;
}

async function orgOf(db: TabulaDb, baseId: string): Promise<string> {
  const r = await sql<{ org_id: string }>`SELECT org_id FROM core.base_directory WHERE base_id = ${baseId}`.execute(db);
  const org = r.rows[0]?.org_id;
  if (!org) throw new SyncError("Base not found");
  return org;
}

/** Fields of a source table in the order (and with the primary) the mirror uses. */
export async function sourceFieldsInOrder(db: TabulaDb, sourceTableId: string): Promise<SerializeFieldRow[]> {
  const fields = await loadSerializeFields(db, sourceTableId);
  const p = await sql<{ primary_field_id: string | null }>`SELECT primary_field_id FROM data.tables WHERE id = ${sourceTableId}`.execute(db);
  const primary = p.rows[0]?.primary_field_id;
  return [...fields.filter((f) => f.id === primary), ...fields.filter((f) => f.id !== primary)];
}

/** Cheap read-only check so an unchanged schema doesn't open a mutation. */
async function schemaNeedsWork(db: TabulaDb, sync: SyncRow, srcFields: SerializeFieldRow[], fieldMap: Record<string, string>): Promise<boolean> {
  const destFields = await loadTableFieldRows(db, sync.table_id);
  const alive = new Map(destFields.map((f) => [f.id, f]));
  const wanted = new Set<string>();
  for (const sf of srcFields) {
    const mapped = mapSourceField(sf);
    if (!mapped) continue;
    wanted.add(sf.id);
    const existing = fieldMap[sf.id] ? alive.get(fieldMap[sf.id]!) : undefined;
    if (!existing) return true;
    if (existing.name !== sf.name && !destFields.some((f) => f.id !== existing.id && f.name.toLowerCase() === sf.name.toLowerCase())) return true;
    if (existing.type !== mapped.type) return true;
    if (mapped.conv === "same" && stable(existing.config ?? {}) !== stable(mapped.config)) return true;
  }
  if (Object.keys(fieldMap).some((id) => !wanted.has(id))) return true;
  const want = srcFields[0] ? fieldMap[srcFields[0].id] : undefined;
  const t = await sql<{ primary_field_id: string | null }>`SELECT primary_field_id FROM data.tables WHERE id = ${sync.table_id}`.execute(db);
  return Boolean(want && t.rows[0]?.primary_field_id !== want);
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  fieldsChanged: number;
  total: number;
}

/** Bring one synced table up to date. Records failures on the sync row and rethrows. */
export async function runTableSync(deps: SyncDeps, syncId: string): Promise<SyncResult> {
  const { db } = deps;
  const sync = await loadSync(db, { id: syncId });
  if (!sync) throw new SyncError("Sync not found");
  try {
    const result = await syncOnce(deps, sync);
    await sql`
      UPDATE data.table_syncs
      SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'active' END,
          last_synced_at = now(), last_error = NULL, last_record_count = ${result.total}, updated_at = now()
      WHERE id = ${sync.id}
    `.execute(db);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE data.table_syncs SET status = 'error', last_error = ${message.slice(0, 500)}, last_synced_at = now(), updated_at = now()
      WHERE id = ${sync.id}
    `.execute(db);
    throw err;
  }
}

async function syncOnce(deps: SyncDeps, sync: SyncRow): Promise<SyncResult> {
  const { db } = deps;
  const snap = await compileForUser(db, sync.owner_user_id, sync.source_base_id);
  if (!snap.effectiveBaseRole) {
    throw new SyncError("The person who set up this sync can no longer read the source base");
  }
  const src = await sql<{ id: string }>`SELECT id FROM data.tables WHERE id = ${sync.source_table_id} AND deleted_at IS NULL`.execute(db);
  if (!src.rows[0]) throw new SyncError("The source table was deleted");
  const dest = await sql<{ id: string }>`SELECT id FROM data.tables WHERE id = ${sync.table_id} AND deleted_at IS NULL`.execute(db);
  if (!dest.rows[0]) throw new SyncError("The synced table was deleted");

  const orgId = await orgOf(db, sync.base_id);
  const actor = { actorType: "system" as const, actorId: sync.owner_user_id, via: "system" as const };
  const txParams = { orgId, workspaceId: sync.workspace_id, baseId: sync.base_id, actor, redis: deps.redis ?? null };

  // ---- 1. schema
  const srcFields = await sourceFieldsInOrder(db, sync.source_table_id);
  const fieldMap: Record<string, string> = { ...sync.field_map };
  let fieldsChanged = 0;
  if (await schemaNeedsWork(db, sync, srcFields, fieldMap)) await withBaseTx(db, txParams, async (mctx, trx) => {
    const ctx: SchemaOpContext = { trx, baseId: sync.base_id, workspaceId: sync.workspace_id, userId: sync.owner_user_id, redis: deps.redis ?? null, afterCommit: mctx.afterCommit };
    let destFields = await loadTableFieldRows(trx, sync.table_id);
    const alive = new Map(destFields.map((f) => [f.id, f]));
    const touched: string[] = [];
    for (const sf of srcFields) {
      const mapped = mapSourceField(sf);
      if (!mapped) continue;
      const destId = fieldMap[sf.id];
      const existing = destId ? alive.get(destId) : undefined;
      if (!existing) {
        const name = dedupeName(destFields.map((f) => f.name), sf.name);
        let created;
        try {
          created = await createFieldInTx(ctx, sync.table_id, { name, type: mapped.type, config: mapped.config });
        } catch {
          created = await createFieldInTx(ctx, sync.table_id, { name, type: "text", config: {} });
        }
        fieldMap[sf.id] = created.fieldId;
        destFields = await loadTableFieldRows(trx, sync.table_id);
        touched.push(created.fieldId);
        fieldsChanged++;
        continue;
      }
      const patch: { name?: string; type?: string; config?: Record<string, unknown> } = {};
      if (existing.name !== sf.name && !destFields.some((f) => f.id !== existing.id && f.name.toLowerCase() === sf.name.toLowerCase())) {
        patch.name = sf.name;
      }
      if (existing.type !== mapped.type) {
        patch.type = mapped.type;
        patch.config = mapped.config;
      } else if (mapped.conv === "same" && stable(existing.config ?? {}) !== stable(mapped.config)) {
        patch.config = mapped.config;
      }
      if (Object.keys(patch).length) {
        try {
          await updateFieldInTx(ctx, sync.table_id, existing.id, patch);
          fieldsChanged++;
          touched.push(existing.id);
        } catch {
          // Keep the previous definition; values still sync.
        }
      }
    }
    // Source fields that disappeared.
    const srcIds = new Set(srcFields.filter((f) => mapSourceField(f)).map((f) => f.id));
    for (const [srcId, destId] of Object.entries(fieldMap)) {
      if (srcIds.has(srcId)) continue;
      delete fieldMap[srcId];
      if (alive.has(destId)) {
        try {
          await deleteFieldInTx(ctx, sync.table_id, destId);
          fieldsChanged++;
        } catch {
          // e.g. it became the primary field; leave it.
        }
      }
    }
    // Primary follows the source primary.
    const srcPrimary = srcFields[0];
    const wantPrimary = srcPrimary ? fieldMap[srcPrimary.id] : undefined;
    const t = await sql<{ primary_field_id: string | null }>`SELECT primary_field_id FROM data.tables WHERE id = ${sync.table_id}`.execute(trx);
    if (wantPrimary && t.rows[0]?.primary_field_id !== wantPrimary) {
      try {
        await setPrimaryFieldInTx(ctx, sync.table_id, wantPrimary);
        fieldsChanged++;
      } catch {
        // Not every type can be primary.
      }
    }
    await sql`UPDATE data.table_syncs SET field_map = ${JSON.stringify(fieldMap)}::jsonb, updated_at = now() WHERE id = ${sync.id}`.execute(trx);
    return {
      kind: "schema" as const,
      ops: [{ op: "table.synced", tableId: sync.table_id, fieldIds: touched }],
      tableIds: [sync.table_id],
      eventType: "table.synced",
      aggregateType: "table",
      aggregateId: sync.table_id,
      payload: { tableId: sync.table_id, schema: true },
    };
  });

  // ---- 2. records
  const ids = await sql<{ id: string }>`
    SELECT id FROM data.records WHERE table_id = ${sync.source_table_id} AND deleted_at IS NULL
    ORDER BY manual_order COLLATE "C", row_number LIMIT ${MAX_SYNC_RECORDS}
  `.execute(db);
  const sourceIds = ids.rows.map((r) => r.id);
  const mapRows = await sql<{ source_record_id: string; dest_record_id: string; content_hash: string }>`
    SELECT m.source_record_id, m.dest_record_id, m.content_hash
    FROM data.table_sync_records m
    INNER JOIN data.records r ON r.table_id = ${sync.table_id} AND r.id = m.dest_record_id AND r.deleted_at IS NULL
    WHERE m.sync_id = ${sync.id}
  `.execute(db);
  const known = new Map(mapRows.rows.map((r) => [r.source_record_id, r]));
  const convBySrc = new Map(srcFields.map((f) => [f.id, mapSourceField(f)]));

  const toCreate: Array<{ srcId: string; fields: Record<string, unknown>; hash: string }> = [];
  const toUpdate: Array<{ srcId: string; destId: string; fields: Record<string, unknown>; hash: string }> = [];
  for (let i = 0; i < sourceIds.length; i += MAX_BATCH) {
    const chunk = sourceIds.slice(i, i + MAX_BATCH);
    const wire = await serializeRecordsByIds(db, sync.source_table_id, chunk, { fields: srcFields, storage: deps.storage ?? null });
    for (const rec of wire) {
      const srcUuid = chunk.find((id) => pid("rec", id) === rec.id) ?? "";
      const fields: Record<string, unknown> = {};
      for (const sf of srcFields) {
        const m = convBySrc.get(sf.id);
        const destId = fieldMap[sf.id];
        if (!m || !destId) continue;
        fields[destId] = convertValue(m.conv, rec.fields[pid("fld", sf.id)]);
      }
      const hash = createHash("sha1").update(JSON.stringify(fields)).digest("hex");
      const prev = known.get(srcUuid);
      if (!prev) toCreate.push({ srcId: srcUuid, fields, hash });
      else if (prev.content_hash !== hash) toUpdate.push({ srcId: srcUuid, destId: prev.dest_record_id, fields, hash });
    }
  }
  const live = new Set(sourceIds);
  const toDelete = mapRows.rows.filter((r) => !live.has(r.source_record_id));

  const writeCtx = (mctx: { changeSeq: number; afterCommit: WriteContext["afterCommit"] }, trx: WriteContext["trx"]): WriteContext => ({
    trx,
    baseId: sync.base_id,
    workspaceId: sync.workspace_id,
    changeSeq: mctx.changeSeq,
    userId: sync.owner_user_id,
    via: "system",
    redis: deps.redis ?? null,
    ...(mctx.afterCommit ? { afterCommit: mctx.afterCommit } : {}),
  });

  for (let i = 0; i < toCreate.length; i += MAX_BATCH) {
    const chunk = toCreate.slice(i, i + MAX_BATCH);
    await withBaseTx(db, txParams, async (mctx, trx) => {
      const res = await createRecordsInTx(writeCtx(mctx, trx), sync.table_id, chunk.map((c) => ({ fields: c.fields })), { typecast: true });
      for (let k = 0; k < chunk.length; k++) {
        await sql`
          INSERT INTO data.table_sync_records (sync_id, source_record_id, dest_record_id, content_hash)
          VALUES (${sync.id}, ${chunk[k]!.srcId}, ${res.ids[k]!}, ${chunk[k]!.hash})
          ON CONFLICT (sync_id, source_record_id) DO UPDATE SET dest_record_id = EXCLUDED.dest_record_id, content_hash = EXCLUDED.content_hash
        `.execute(trx);
      }
      return {
        kind: "bulk" as const,
        ops: [{ op: "records.created", tableId: sync.table_id, recordIds: res.ids }],
        tableIds: [sync.table_id],
        eventType: "records.batch_created",
        aggregateType: "table",
        aggregateId: sync.table_id,
        payload: { tableId: sync.table_id, recordIds: res.ids, count: res.ids.length, sync: true },
      };
    });
  }
  for (let i = 0; i < toUpdate.length; i += MAX_BATCH) {
    const chunk = toUpdate.slice(i, i + MAX_BATCH);
    await withBaseTx(db, txParams, async (mctx, trx) => {
      const res = await updateRecordsInTx(writeCtx(mctx, trx), sync.table_id, chunk.map((c) => ({ id: c.destId, fields: c.fields })), { typecast: true });
      for (const c of chunk) {
        await sql`UPDATE data.table_sync_records SET content_hash = ${c.hash} WHERE sync_id = ${sync.id} AND source_record_id = ${c.srcId}`.execute(trx);
      }
      return {
        kind: "bulk" as const,
        ops: chunk.map((c) => ({ op: "record.updated", tableId: sync.table_id, recordId: c.destId, cells: res.after.get(c.destId) })),
        tableIds: [sync.table_id],
        eventType: "records.batch_updated",
        aggregateType: "table",
        aggregateId: sync.table_id,
        payload: { tableId: sync.table_id, recordIds: chunk.map((c) => c.destId), sync: true },
      };
    });
  }
  for (let i = 0; i < toDelete.length; i += MAX_BATCH) {
    const chunk = toDelete.slice(i, i + MAX_BATCH);
    await withBaseTx(db, txParams, async (mctx, trx) => {
      const res = await deleteRecordsInTx(writeCtx(mctx, trx), sync.table_id, chunk.map((c) => c.dest_record_id));
      await sql`
        DELETE FROM data.table_sync_records WHERE sync_id = ${sync.id} AND source_record_id = ANY(${chunk.map((c) => c.source_record_id)}::uuid[])
      `.execute(trx);
      return {
        kind: "bulk" as const,
        ops: res.ids.map((recordId) => ({ op: "record.deleted", tableId: sync.table_id, recordId })),
        tableIds: [sync.table_id],
        eventType: "records.batch_deleted",
        aggregateType: "table",
        aggregateId: sync.table_id,
        payload: { tableId: sync.table_id, recordIds: res.ids, sync: true },
      };
    });
  }
  return { created: toCreate.length, updated: toUpdate.length, deleted: toDelete.length, fieldsChanged, total: sourceIds.length };
}

/** Destination field ids managed by syncs, per destination table (for read-only marking). */
export async function syncedFieldsByTable(db: TabulaDb, baseId: string): Promise<Map<string, { sync: SyncRow; fieldIds: Set<string> }>> {
  const r = await sql<SyncRow>`SELECT * FROM data.table_syncs WHERE base_id = ${baseId}`.execute(db);
  return new Map(r.rows.map((s) => [s.table_id, { sync: s, fieldIds: new Set(Object.values(s.field_map ?? {})) }]));
}

/** Syncs that are due, or whose source table changed (`sourceTableIds`). */
export async function dueSyncIds(db: TabulaDb, sourceTableIds?: string[]): Promise<string[]> {
  const r = sourceTableIds?.length
    ? await sql<{ id: string }>`
        SELECT id FROM data.table_syncs WHERE status <> 'paused' AND source_table_id = ANY(${sourceTableIds}::uuid[])
      `.execute(db)
    : await sql<{ id: string }>`
        SELECT id FROM data.table_syncs
        WHERE status <> 'paused'
          AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(mins => interval_minutes))
        ORDER BY last_synced_at NULLS FIRST LIMIT 20
      `.execute(db);
  return r.rows.map((x) => x.id);
}
