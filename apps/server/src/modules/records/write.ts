/**
 * Record write path (workstream B). Every record create/update/delete —
 * HTTP routes, realtime ops, imports, form submissions — should go through
 * these helpers so validation, links, compute and counters stay consistent.
 *
 * All functions run inside an existing base transaction (`withBaseTx`).
 */
import {
  getFieldType,
  isFieldTypeKey,
  optionColorAt,
  newOptionId,
  FieldValidationError,
  type FieldConfig,
} from "@tabula/fields";
import type { Database } from "@tabula/db";
import { generateUuidV7, keyBetween, keysBetween } from "@tabula/types";
import type { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import { ApiError } from "../../http/errors.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { runComputeInTx, type RecordChange, type SeedRequest } from "../compute/engine.js";
import { createDeletionBatchInTx } from "../history/apply-inverse.js";
import { writeRecordLinksInTx } from "../links/record-links.js";
import { deleteSidecars, shouldMaintainSidecar, upsertSidecars } from "../recordstore/sidecars.js";
import type { SidecarFieldRow, SidecarTableMeta } from "../recordstore/sidecars.js";
import { loadTableSchema, type FieldRowFull, type TableSchema } from "../schema/table-schema.js";

type DbTrx = Transaction<Database>;

export const MAX_BATCH = 500;

export interface WriteContext {
  trx: DbTrx;
  baseId: string;
  workspaceId: string;
  changeSeq: number;
  /** Acting user (created_by / updated_by); null for anonymous form posts. */
  userId: string | null;
  via?: "ui" | "api" | "automation" | "import" | "form" | "undo" | "redo" | "restore" | "system";
  redis?: Redis | null;
  afterCommit?: (fn: () => Promise<void> | void) => void;
}

export interface WriteOptions {
  typecast?: boolean;
}

const LINK_TYPES = new Set(["link", "contact"]);

function decodeFld(s: string): string | null {
  try {
    return parsePid(s, "fld");
  } catch {
    return null;
  }
}

/** Resolve an input key (fld_ id, raw uuid, or field name). */
function resolveKey(schema: TableSchema, key: string): FieldRowFull | undefined {
  if (key.startsWith("fld_")) {
    const id = decodeFld(key);
    return id ? schema.byId.get(id) : undefined;
  }
  const byId = schema.byId.get(key.toLowerCase());
  if (byId) return byId;
  const exact = schema.fields.find((f) => f.name === key);
  if (exact) return exact;
  const lk = key.trim().toLowerCase();
  return schema.fields.find((f) => f.name.trim().toLowerCase() === lk);
}

export interface PreparedFields {
  /** slot → normalized value; `undefined` clears the cell. */
  cells: Map<string, unknown>;
  /** link field id → ordered raw target record ids (replace semantics). */
  links: Map<string, string[]>;
  /** field ids touched by this write. */
  fieldIds: Set<string>;
}

/**
 * Loaded table schema + per-write normalization (options created by typecast
 * are collected and persisted with `persistConfigChanges`).
 */
export class TableWriter {
  private dirtyConfigs = new Set<string>();
  private sidecarFields: SidecarFieldRow[];
  readonly sidecarTable: SidecarTableMeta;

  private constructor(readonly schema: TableSchema) {
    this.sidecarFields = schema.fields.map((f) => ({ slot: f.slot, type: f.type, index_state: f.indexState }));
    this.sidecarTable = {
      record_count: schema.table.recordCount,
      workspace_id: schema.table.workspaceId,
      base_id: schema.table.baseId,
    };
  }

  static async load(trx: DbTrx, tableId: string): Promise<TableWriter> {
    const schema = await loadTableSchema(trx, tableId);
    if (!schema) throw new ApiError(404, "NOT_FOUND", "Table not found");
    return new TableWriter(schema);
  }

  get tableId(): string {
    return this.schema.table.id;
  }

  get needsSidecars(): boolean {
    return this.sidecarFields.some((f) => shouldMaintainSidecar(f, this.sidecarTable));
  }

  async sidecars(trx: DbTrx, recordId: string, cells: Record<string, unknown>): Promise<void> {
    if (!this.needsSidecars) return;
    await upsertSidecars(trx, this.tableId, recordId, cells, this.sidecarFields, this.sidecarTable);
  }

  prepare(input: Record<string, unknown>, opts: WriteOptions = {}): PreparedFields {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ApiError(422, "VALIDATION_FAILED", "`fields` must be an object");
    }
    const out: PreparedFields = { cells: new Map(), links: new Map(), fieldIds: new Set() };
    for (const [key, raw] of Object.entries(input)) {
      const field = resolveKey(this.schema, key);
      if (!field) {
        throw new ApiError(422, "UNKNOWN_FIELD", `Unknown field "${key}"`, { field: key });
      }
      if (raw === undefined) continue;
      if (!isFieldTypeKey(field.type)) {
        throw new ApiError(422, "VALIDATION_FAILED", `Field "${field.name}" has an unsupported type`);
      }
      const def = getFieldType(field.type);
      if (def.readOnly) {
        throw new ApiError(
          422,
          "FIELD_READ_ONLY",
          `Field "${field.name}" (${def.label.toLowerCase()}) is computed or read-only and cannot be written`,
          { field: pid("fld", field.id) },
        );
      }
      try {
        const res = def.normalize(raw, field.config as FieldConfig, {
          typecast: opts.typecast === true,
          createOption: (label) => this.createOption(field, label),
        });
        if (LINK_TYPES.has(field.type)) {
          out.links.set(field.id, (res.value as string[] | undefined) ?? []);
        } else {
          out.cells.set(String(field.slot), res.value);
        }
        out.fieldIds.add(field.id);
      } catch (e) {
        if (e instanceof FieldValidationError) {
          throw new ApiError(422, "FIELD_VALIDATION_FAILED", `${field.name}: ${e.message}`, {
            field: pid("fld", field.id),
          });
        }
        throw e;
      }
    }
    return out;
  }

  /**
   * Collaborator cells may only name users of this org, and attachment cells only
   * files of this base (or files the same column already holds, e.g. after a base
   * duplicate). Anything else would let a write reference another tenant's data.
   */
  async verifyRefs(trx: DbTrx, prepared: PreparedFields[]): Promise<void> {
    const users = new Map<string, FieldRowFull>();
    const atts = new Map<string, FieldRowFull>();
    for (const p of prepared) {
      for (const [slot, v] of p.cells) {
        const f = this.schema.bySlot.get(slot);
        const into = f?.type === "collaborator" ? users : f?.type === "attachment" ? atts : null;
        if (!f || !into || !Array.isArray(v)) continue;
        for (const id of v) if (typeof id === "string") into.set(id, f);
      }
    }
    const reject = (f: FieldRowFull, what: string): never => {
      throw new ApiError(422, "FIELD_VALIDATION_FAILED", `${f.name}: ${what}`, { field: pid("fld", f.id) });
    };
    if (users.size) {
      const ids = [...users.keys()];
      const ok = await sql<{ id: string }>`
        SELECT m.user_id AS id FROM core.organization_members m
        JOIN core.workspaces w ON w.org_id = m.org_id
        WHERE w.id = ${this.schema.table.workspaceId} AND m.status = 'active' AND m.user_id = ANY(${ids}::uuid[])
      `.execute(trx);
      const found = new Set(ok.rows.map((r) => r.id));
      for (const [id, f] of users) if (!found.has(id)) reject(f, `Unknown user "${pid("usr", id)}"`);
    }
    if (atts.size) {
      const ids = [...atts.keys()];
      const ok = await sql<{ id: string }>`
        SELECT id FROM data.attachments WHERE base_id = ${this.schema.table.baseId} AND id = ANY(${ids}::uuid[])
      `.execute(trx);
      const found = new Set(ok.rows.map((r) => r.id));
      for (const [id, f] of atts) {
        if (found.has(id)) continue;
        const held = await sql<{ one: number }>`
          SELECT 1 AS one FROM data.records
          WHERE table_id = ${this.tableId} AND cells -> ${String(f.slot)} ? ${id} LIMIT 1
        `.execute(trx);
        if (held.rows.length === 0) reject(f, `Unknown attachment "${pid("att", id)}"`);
      }
    }
  }

  private createOption(field: FieldRowFull, label: string): string {
    const options = (Array.isArray(field.config["options"]) ? field.config["options"] : []) as Array<{
      id: string;
      label: string;
      color?: string;
    }>;
    const existing = options.find((o) => o.label.toLowerCase() === label.toLowerCase());
    if (existing) return existing.id;
    const opt = { id: newOptionId(), label, color: optionColorAt(options.length) };
    field.config = { ...field.config, options: [...options, opt] };
    this.dirtyConfigs.add(field.id);
    return opt.id;
  }

  /** Persist select options created by typecast. Returns updated field ids. */
  async persistConfigChanges(trx: DbTrx): Promise<string[]> {
    const ids = [...this.dirtyConfigs];
    for (const id of ids) {
      const f = this.schema.byId.get(id)!;
      await sql`
        UPDATE data.fields SET config = ${JSON.stringify(f.config)}::jsonb, updated_at = now()
        WHERE id = ${id}
      `.execute(trx);
    }
    this.dirtyConfigs.clear();
    return ids;
  }

  /** Field ids of auto "last modified" fields (affected by any update). */
  get modifiedMetaFieldIds(): string[] {
    return this.schema.fields.filter((f) => f.type === "modified_time" || f.type === "modified_by").map((f) => f.id);
  }

  get computedFieldIds(): string[] {
    return this.schema.fields.filter((f) => f.isComputed).map((f) => f.id);
  }

  /** Remove slots of link fields (legacy link arrays) from stored cells. */
  stripLinkSlots(cells: Record<string, unknown>): Record<string, unknown> {
    const out = { ...cells };
    for (const f of this.schema.fields) if (LINK_TYPES.has(f.type)) delete out[String(f.slot)];
    for (const k of Object.keys(out)) if (!this.schema.bySlot.has(k)) delete out[k];
    return out;
  }
}

function applyCells(base: Record<string, unknown>, patch: Map<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [slot, v] of patch) {
    if (v === undefined) delete out[slot];
    else out[slot] = v;
  }
  return out;
}

/** Append keys after the current last record (bytewise order). */
async function appendOrderKeys(trx: DbTrx, tableId: string, n: number): Promise<string[]> {
  const last = await sql<{ manual_order: string }>`
    SELECT manual_order FROM data.records
    WHERE table_id = ${tableId} AND deleted_at IS NULL
    ORDER BY manual_order DESC LIMIT 1
  `.execute(trx);
  const max = last.rows[0]?.manual_order ?? null;
  try {
    return keysBetween(max, null, n);
  } catch {
    return keysBetween(null, null, n);
  }
}

/** One record's link field change (raw uuids), kept on ops for record history. */
export interface LinkDiff {
  recordId: string;
  fieldId: string;
  added: string[];
  removed: string[];
  peerFieldId: string | null;
}

interface LinkEffects {
  changes: RecordChange[];
  diffs?: LinkDiff[];
}

async function applyLinks(
  ctx: WriteContext,
  recordId: string,
  links: Map<string, string[]>,
  effects: LinkEffects,
  ownTableId: string,
  mode: "replace" = "replace",
): Promise<void> {
  for (const [fieldId, targets] of links) {
    const res = await writeRecordLinksInTx(ctx.trx, {
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      fieldId,
      recordId,
      targetIds: targets,
      mode,
    });
    if (!res.changed) continue;
    if (res.added.length || res.removed.length) {
      (effects.diffs ??= []).push({
        recordId,
        fieldId,
        added: res.added,
        removed: res.removed,
        peerFieldId: res.peerFieldId,
      });
    }
    effects.changes.push({ tableId: ownTableId, recordIds: [recordId], fieldIds: [fieldId] });
    const peers = [...res.added, ...res.removed];
    if (peers.length && res.peerFieldId) {
      effects.changes.push({ tableId: res.peerTableId, recordIds: peers, fieldIds: [res.peerFieldId] });
    }
  }
}

export interface ComputeOutcome {
  /** tables (other than the written one) whose records' computed values changed */
  touched: Map<string, Set<string>>;
}

async function runCompute(
  ctx: WriteContext,
  changes: RecordChange[],
  seeds: SeedRequest[],
): Promise<ComputeOutcome> {
  const res = await runComputeInTx(
    ctx.trx,
    {
      baseId: ctx.baseId,
      workspaceId: ctx.workspaceId,
      redis: ctx.redis ?? null,
      ...(ctx.afterCommit ? { afterCommit: ctx.afterCommit } : {}),
    },
    { changes, seeds },
  );
  return { touched: res.touched };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateItem {
  fields: Record<string, unknown>;
  /** Optional client-chosen id (`rec_…` or uuid). */
  id?: string;
}

export interface CreateResult {
  ids: string[];
  compute: ComputeOutcome;
  /** Select fields whose options were extended by typecast. */
  configChangedFieldIds: string[];
  linkDiffs: LinkDiff[];
}

export async function createRecordsInTx(
  ctx: WriteContext,
  tableId: string,
  items: CreateItem[],
  opts: WriteOptions & { writer?: TableWriter; orderKeys?: string[] } = {},
): Promise<CreateResult> {
  if (items.length === 0) throw new ApiError(422, "VALIDATION_FAILED", "At least one record is required");
  if (items.length > MAX_BATCH) {
    throw new ApiError(422, "VALIDATION_FAILED", `At most ${MAX_BATCH} records per request`);
  }
  const trx = ctx.trx;
  const writer = opts.writer ?? (await TableWriter.load(trx, tableId));

  // Ids: validate, de-duplicate.
  const ids: string[] = [];
  for (const item of items) {
    let id: string;
    if (item.id) {
      try {
        id = item.id.startsWith("rec_") ? parsePid(item.id, "rec") : item.id.toLowerCase();
      } catch {
        throw new ApiError(422, "VALIDATION_FAILED", `Invalid record id "${item.id}"`);
      }
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(422, "VALIDATION_FAILED", `Invalid record id "${item.id}"`);
    } else {
      id = generateUuidV7();
    }
    if (ids.includes(id)) throw new ApiError(422, "DUPLICATE_RECORD_ID", `Duplicate record id "${item.id}" in request`);
    ids.push(id);
  }
  const explicit = items.filter((i) => i.id).length;
  if (explicit > 0) {
    const exists = await sql<{ id: string }>`
      SELECT id FROM data.records WHERE table_id = ${tableId} AND id = ANY(${ids}::uuid[])
    `.execute(trx);
    if (exists.rows.length > 0) {
      throw new ApiError(409, "CONFLICT", `Record ${pid("rec", exists.rows[0]!.id)} already exists`);
    }
  }

  const prepared = items.map((item) => writer.prepare(item.fields ?? {}, opts));
  await writer.verifyRefs(trx, prepared);
  const configChangedFieldIds = await writer.persistConfigChanges(trx);

  const n = items.length;
  const rowNum = await sql<{ first: string }>`
    UPDATE data.tables
    SET next_row_number = next_row_number + ${n},
        record_count = record_count + ${n},
        updated_at = now()
    WHERE id = ${tableId}
    RETURNING (next_row_number - ${n}) AS first
  `.execute(trx);
  const first = Number(rowNum.rows[0]?.first ?? 1);
  const orderKeys = opts.orderKeys ?? (await appendOrderKeys(trx, tableId, n));

  const effects: LinkEffects = { changes: [], diffs: [] };
  for (let i = 0; i < n; i++) {
    const id = ids[i]!;
    const cells = applyCells({}, prepared[i]!.cells);
    await sql`
      INSERT INTO data.records (
        table_id, id, workspace_id, base_id, row_number, manual_order, cells,
        created_by, updated_by, created_via, last_change_seq
      ) VALUES (
        ${tableId}, ${id}, ${ctx.workspaceId}, ${ctx.baseId}, ${first + i}, ${orderKeys[i]!},
        ${JSON.stringify(cells)}::jsonb, ${ctx.userId}, ${ctx.userId}, ${ctx.via ?? "api"}, ${ctx.changeSeq}
      )
    `.execute(trx);
    await writer.sidecars(trx, id, cells);
  }
  // Links after all rows exist (a batch may link records to each other in self-links).
  for (let i = 0; i < n; i++) {
    if (prepared[i]!.links.size) await applyLinks(ctx, ids[i]!, prepared[i]!.links, effects, tableId);
  }

  await sql`
    UPDATE data.base_runtime SET record_count = record_count + ${n}, updated_at = now()
    WHERE base_id = ${ctx.baseId}
  `.execute(trx);

  const seeds = writer.computedFieldIds.map((fieldId) => ({ fieldId, recordIds: ids }));
  const compute = await runCompute(ctx, effects.changes, seeds);
  return { ids, compute, configChangedFieldIds, linkDiffs: effects.diffs ?? [] };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateItem {
  id: string;
  fields: Record<string, unknown>;
  expectedVersion?: number;
}

export interface UpdateResult {
  versions: Map<string, number>;
  /** previous stored cells per record (for undo) */
  before: Map<string, Record<string, unknown>>;
  after: Map<string, Record<string, unknown>>;
  compute: ComputeOutcome;
  configChangedFieldIds: string[];
  linkDiffs: LinkDiff[];
}

function toRecordUuid(id: string): string {
  if (id.startsWith("rec_")) return parsePid(id, "rec");
  if (/^[0-9a-f-]{36}$/i.test(id)) return id.toLowerCase();
  throw new ApiError(422, "VALIDATION_FAILED", `Invalid record id "${id}"`);
}

export async function updateRecordsInTx(
  ctx: WriteContext,
  tableId: string,
  items: UpdateItem[],
  opts: WriteOptions & { writer?: TableWriter } = {},
): Promise<UpdateResult> {
  if (items.length === 0) throw new ApiError(422, "VALIDATION_FAILED", "At least one record is required");
  if (items.length > MAX_BATCH) {
    throw new ApiError(422, "VALIDATION_FAILED", `At most ${MAX_BATCH} records per request`);
  }
  const trx = ctx.trx;
  const writer = opts.writer ?? (await TableWriter.load(trx, tableId));
  const ids = items.map((i) => toRecordUuid(i.id));
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(422, "DUPLICATE_RECORD_ID", "The same record appears more than once in the request");
  }
  const prepared = items.map((item) => writer.prepare(item.fields ?? {}, opts));
  await writer.verifyRefs(trx, prepared);

  const existing = await sql<{ id: string; cells: Record<string, unknown>; version: string }>`
    SELECT id, cells, version FROM data.records
    WHERE table_id = ${tableId} AND id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  `.execute(trx);
  const byId = new Map(existing.rows.map((r) => [r.id, r]));
  for (let i = 0; i < ids.length; i++) {
    const row = byId.get(ids[i]!);
    if (!row) throw new ApiError(404, "RECORD_NOT_FOUND", `Record ${pid("rec", ids[i]!)} not found`);
    const ev = items[i]!.expectedVersion;
    if (ev !== undefined && !Number.isNaN(ev) && ev !== Number(row.version)) {
      throw new ApiError(409, "VERSION_CONFLICT", "The record was changed by someone else", {
        recordId: pid("rec", row.id),
        currentVersion: Number(row.version),
      });
    }
  }
  const configChangedFieldIds = await writer.persistConfigChanges(trx);

  const versions = new Map<string, number>();
  const before = new Map<string, Record<string, unknown>>();
  const after = new Map<string, Record<string, unknown>>();
  const effects: LinkEffects = { changes: [], diffs: [] };
  const changedByField = new Map<string, string[]>();

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const row = byId.get(id)!;
    const p = prepared[i]!;
    const oldCells = (row.cells ?? {}) as Record<string, unknown>;
    const merged = writer.stripLinkSlots(applyCells(oldCells, p.cells));
    const newVersion = Number(row.version) + 1;
    await sql`
      UPDATE data.records
      SET cells = ${JSON.stringify(merged)}::jsonb,
          version = version + 1,
          updated_by = ${ctx.userId},
          updated_at = now(),
          last_change_seq = ${ctx.changeSeq}
      WHERE table_id = ${tableId} AND id = ${id}
    `.execute(trx);
    versions.set(id, newVersion);
    before.set(id, oldCells);
    after.set(id, merged);
    await writer.sidecars(trx, id, merged);
    if (p.links.size) await applyLinks(ctx, id, p.links, effects, tableId);
    for (const fid of p.fieldIds) {
      if (writer.schema.byId.get(fid) && !["link", "contact"].includes(writer.schema.byId.get(fid)!.type)) {
        const list = changedByField.get(fid) ?? [];
        list.push(id);
        changedByField.set(fid, list);
      }
    }
  }

  const changes: RecordChange[] = [...effects.changes];
  for (const [fid, recs] of changedByField) changes.push({ tableId, recordIds: recs, fieldIds: [fid] });
  const meta = writer.modifiedMetaFieldIds;
  if (meta.length) changes.push({ tableId, recordIds: ids, fieldIds: meta });
  const compute = await runCompute(ctx, changes, []);
  return { versions, before, after, compute, configChangedFieldIds, linkDiffs: effects.diffs ?? [] };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteResult {
  batchId: string;
  ids: string[];
  compute: ComputeOutcome;
}

export async function deleteRecordsInTx(
  ctx: WriteContext,
  tableId: string,
  rawIds: string[],
): Promise<DeleteResult> {
  if (rawIds.length === 0) throw new ApiError(422, "VALIDATION_FAILED", "At least one record id is required");
  if (rawIds.length > MAX_BATCH) throw new ApiError(422, "VALIDATION_FAILED", `At most ${MAX_BATCH} records per request`);
  const trx = ctx.trx;
  const ids = [...new Set(rawIds.map(toRecordUuid))];
  const live = await sql<{ id: string }>`
    SELECT id FROM data.records
    WHERE table_id = ${tableId} AND id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
    FOR UPDATE
  `.execute(trx);
  const liveIds = new Set(live.rows.map((r) => r.id));
  const missing = ids.filter((id) => !liveIds.has(id));
  if (missing.length) throw new ApiError(404, "RECORD_NOT_FOUND", `Record ${pid("rec", missing[0]!)} not found`);

  // Peers that lose a link (their inverse link field / lookups must refresh).
  const peerRows = await sql<{
    peer: string;
    peer_table: string;
    peer_field: string | null;
  }>`
    SELECT l.b_record_id AS peer, r.b_table_id AS peer_table, r.b_field_id AS peer_field
    FROM data.record_links l JOIN data.link_relations r ON r.id = l.relation_id
    WHERE r.a_table_id = ${tableId} AND l.a_record_id = ANY(${ids}::uuid[]) AND l.deletion_batch_id IS NULL
    UNION ALL
    SELECT l.a_record_id AS peer, r.a_table_id AS peer_table, r.a_field_id AS peer_field
    FROM data.record_links l JOIN data.link_relations r ON r.id = l.relation_id
    WHERE r.b_table_id = ${tableId} AND l.b_record_id = ANY(${ids}::uuid[]) AND l.deletion_batch_id IS NULL
  `.execute(trx);

  const batchId = await createDeletionBatchInTx(trx, {
    workspaceId: ctx.workspaceId,
    baseId: ctx.baseId,
    userId: ctx.userId as string,
  });
  await sql`
    UPDATE data.records
    SET deleted_at = now(), deleted_by = ${ctx.userId}, updated_at = now(),
        deletion_batch_id = ${batchId}, last_change_seq = ${ctx.changeSeq}
    WHERE table_id = ${tableId} AND id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
  `.execute(trx);
  await sql`
    UPDATE data.record_links SET deletion_batch_id = ${batchId}
    WHERE base_id = ${ctx.baseId}
      AND (a_record_id = ANY(${ids}::uuid[]) OR b_record_id = ANY(${ids}::uuid[]))
      AND deletion_batch_id IS NULL
  `.execute(trx);
  for (const id of ids) await deleteSidecars(trx, tableId, id);
  await sql`
    UPDATE data.tables SET record_count = GREATEST(record_count - ${ids.length}, 0), updated_at = now()
    WHERE id = ${tableId}
  `.execute(trx);
  await sql`
    UPDATE data.base_runtime SET record_count = GREATEST(record_count - ${ids.length}, 0), updated_at = now()
    WHERE base_id = ${ctx.baseId}
  `.execute(trx);
  await sql`
    DELETE FROM data.computed_stale WHERE table_id = ${tableId} AND record_id = ANY(${ids}::uuid[])
  `.execute(trx);

  const byPeer = new Map<string, { table: string; field: string; ids: Set<string> }>();
  for (const r of peerRows.rows) {
    if (!r.peer_field || liveIds.has(r.peer)) continue;
    const key = `${r.peer_table}:${r.peer_field}`;
    const e = byPeer.get(key) ?? { table: r.peer_table, field: r.peer_field, ids: new Set<string>() };
    e.ids.add(r.peer);
    byPeer.set(key, e);
  }
  const changes: RecordChange[] = [...byPeer.values()].map((e) => ({
    tableId: e.table,
    recordIds: e.ids,
    fieldIds: [e.field],
  }));
  const compute = await runCompute(ctx, changes, []);
  return { batchId, ids, compute };
}

/**
 * Restore side effects (history/trash restore): counters + recompute of the
 * restored records and their link peers. Call after un-deleting `ids`.
 */
export async function afterRecordsRestoredInTx(
  ctx: WriteContext,
  tableId: string,
  ids: string[],
): Promise<ComputeOutcome> {
  if (ids.length === 0) return { touched: new Map() };
  await sql`
    UPDATE data.tables SET record_count = record_count + ${ids.length}, updated_at = now() WHERE id = ${tableId}
  `.execute(ctx.trx);
  await sql`
    UPDATE data.base_runtime SET record_count = record_count + ${ids.length}, updated_at = now()
    WHERE base_id = ${ctx.baseId}
  `.execute(ctx.trx);
  const writer = await TableWriter.load(ctx.trx, tableId);
  const linkFields = writer.schema.fields.filter((f) => LINK_TYPES.has(f.type)).map((f) => f.id);
  const peerRows = await sql<{ peer: string; peer_table: string; peer_field: string | null }>`
    SELECT l.b_record_id AS peer, r.b_table_id AS peer_table, r.b_field_id AS peer_field
    FROM data.record_links l JOIN data.link_relations r ON r.id = l.relation_id
    WHERE r.a_table_id = ${tableId} AND l.a_record_id = ANY(${ids}::uuid[]) AND l.deletion_batch_id IS NULL
    UNION ALL
    SELECT l.a_record_id AS peer, r.a_table_id AS peer_table, r.a_field_id AS peer_field
    FROM data.record_links l JOIN data.link_relations r ON r.id = l.relation_id
    WHERE r.b_table_id = ${tableId} AND l.b_record_id = ANY(${ids}::uuid[]) AND l.deletion_batch_id IS NULL
  `.execute(ctx.trx);
  const changes: RecordChange[] = [];
  if (linkFields.length) changes.push({ tableId, recordIds: ids, fieldIds: linkFields });
  for (const r of peerRows.rows) {
    if (r.peer_field) changes.push({ tableId: r.peer_table, recordIds: [r.peer], fieldIds: [r.peer_field] });
  }
  return runCompute(ctx, changes, writer.computedFieldIds.map((fieldId) => ({ fieldId, recordIds: ids })));
}

// ---------------------------------------------------------------------------
// Duplicate / move
// ---------------------------------------------------------------------------

export async function duplicateRecordInTx(
  ctx: WriteContext,
  tableId: string,
  sourceId: string,
): Promise<CreateResult> {
  const trx = ctx.trx;
  const src = await sql<{ cells: Record<string, unknown>; manual_order: string }>`
    SELECT cells, manual_order FROM data.records
    WHERE table_id = ${tableId} AND id = ${sourceId} AND deleted_at IS NULL
  `.execute(trx);
  const row = src.rows[0];
  if (!row) throw new ApiError(404, "RECORD_NOT_FOUND", "Record not found");
  const writer = await TableWriter.load(trx, tableId);
  const next = await sql<{ manual_order: string }>`
    SELECT manual_order FROM data.records
    WHERE table_id = ${tableId} AND deleted_at IS NULL AND manual_order > ${row.manual_order}
    ORDER BY manual_order ASC LIMIT 1
  `.execute(trx);
  let key: string;
  try {
    key = keyBetween(row.manual_order, next.rows[0]?.manual_order ?? null);
  } catch {
    key = (await appendOrderKeys(trx, tableId, 1))[0]!;
  }
  const fields: Record<string, unknown> = {};
  const cells = writer.stripLinkSlots(row.cells ?? {});
  for (const f of writer.schema.fields) {
    if (f.isComputed || getFieldType(isFieldTypeKey(f.type) ? f.type : "text").readOnly) continue;
    if (LINK_TYPES.has(f.type)) continue;
    const v = cells[String(f.slot)];
    if (v !== undefined) fields[f.id] = v;
  }
  const res = await createRecordsInTx(ctx, tableId, [{ fields }], { writer, orderKeys: [key] });
  // Copy links (our side) in the same order.
  const newId = res.ids[0]!;
  const effects: LinkEffects = { changes: [], diffs: [] };
  for (const f of writer.schema.fields) {
    if (!LINK_TYPES.has(f.type)) continue;
    const { readRecordLinks } = await import("../links/record-links.js");
    const peers = await readRecordLinks(trx, f.id, sourceId);
    if (peers.length) await applyLinks(ctx, newId, new Map([[f.id, peers]]), effects, tableId);
  }
  res.linkDiffs.push(...(effects.diffs ?? []));
  if (effects.changes.length) {
    const more = await runCompute(ctx, effects.changes, []);
    for (const [t, s] of more.touched) {
      const cur = res.compute.touched.get(t) ?? new Set<string>();
      for (const id of s) cur.add(id);
      res.compute.touched.set(t, cur);
    }
  }
  return res;
}

/** Re-key every live record of a table (used when neighbours share a key). */
async function rebalanceOrderKeys(trx: DbTrx, tableId: string): Promise<void> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM data.records WHERE table_id = ${tableId} AND deleted_at IS NULL
    ORDER BY manual_order ASC, id ASC
  `.execute(trx);
  const keys = keysBetween(null, null, rows.rows.length);
  const payload = rows.rows.map((r, i) => ({ id: r.id, k: keys[i]! }));
  for (let i = 0; i < payload.length; i += 1000) {
    await sql`
      UPDATE data.records AS r SET manual_order = v.k
      FROM jsonb_to_recordset(${JSON.stringify(payload.slice(i, i + 1000))}::jsonb) AS v(id uuid, k text)
      WHERE r.table_id = ${tableId} AND r.id = v.id
    `.execute(trx);
  }
}

/**
 * Move a record before `beforeId` or after `afterId` (manual order).
 * Neither → move to the top. Returns the new key.
 */
export async function moveRecordInTx(
  ctx: WriteContext,
  tableId: string,
  recordId: string,
  target: { beforeId?: string | null; afterId?: string | null },
  attempt = 0,
): Promise<string> {
  const trx = ctx.trx;
  const self = await sql<{ manual_order: string }>`
    SELECT manual_order FROM data.records
    WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL FOR UPDATE
  `.execute(trx);
  if (!self.rows[0]) throw new ApiError(404, "RECORD_NOT_FOUND", "Record not found");

  const keyOf = async (id: string): Promise<{ k: string; id: string }> => {
    const r = await sql<{ manual_order: string }>`
      SELECT manual_order FROM data.records WHERE table_id = ${tableId} AND id = ${id} AND deleted_at IS NULL
    `.execute(trx);
    if (!r.rows[0]) throw new ApiError(404, "RECORD_NOT_FOUND", `Record ${pid("rec", id)} not found`);
    return { k: r.rows[0].manual_order, id };
  };
  let lo: string | null = null;
  let hi: string | null = null;
  if (target.afterId) {
    if (target.afterId === recordId) throw new ApiError(422, "VALIDATION_FAILED", "Cannot move a record relative to itself");
    const a = await keyOf(target.afterId);
    lo = a.k;
    const nx = await sql<{ manual_order: string }>`
      SELECT manual_order FROM data.records
      WHERE table_id = ${tableId} AND deleted_at IS NULL AND id <> ${recordId}
        AND (manual_order > ${a.k} OR (manual_order = ${a.k} AND id > ${a.id}))
      ORDER BY manual_order ASC, id ASC LIMIT 1
    `.execute(trx);
    hi = nx.rows[0]?.manual_order ?? null;
  } else if (target.beforeId) {
    if (target.beforeId === recordId) throw new ApiError(422, "VALIDATION_FAILED", "Cannot move a record relative to itself");
    const b = await keyOf(target.beforeId);
    hi = b.k;
    const pv = await sql<{ manual_order: string }>`
      SELECT manual_order FROM data.records
      WHERE table_id = ${tableId} AND deleted_at IS NULL AND id <> ${recordId}
        AND (manual_order < ${b.k} OR (manual_order = ${b.k} AND id < ${b.id}))
      ORDER BY manual_order DESC, id DESC LIMIT 1
    `.execute(trx);
    lo = pv.rows[0]?.manual_order ?? null;
  } else {
    const first = await sql<{ manual_order: string }>`
      SELECT manual_order FROM data.records
      WHERE table_id = ${tableId} AND deleted_at IS NULL AND id <> ${recordId}
      ORDER BY manual_order ASC, id ASC LIMIT 1
    `.execute(trx);
    hi = first.rows[0]?.manual_order ?? null;
  }
  let key: string;
  try {
    key = keyBetween(lo, hi);
  } catch {
    if (attempt > 0) throw new ApiError(409, "CONFLICT", "Could not compute an order key; please retry");
    await rebalanceOrderKeys(trx, tableId);
    return moveRecordInTx(ctx, tableId, recordId, target, attempt + 1);
  }
  await sql`
    UPDATE data.records SET manual_order = ${key}, last_change_seq = ${ctx.changeSeq}
    WHERE table_id = ${tableId} AND id = ${recordId}
  `.execute(trx);
  return key;
}

/** Tables whose records changed via compute, for realtime `tableIds`. */
export function touchedTableIds(primary: string, ...outcomes: ComputeOutcome[]): string[] {
  const s = new Set<string>([primary]);
  for (const o of outcomes) for (const t of o.touched.keys()) s.add(t);
  return [...s];
}

/**
 * `links` payload for a record op (record history reads it, including from the
 * peer side). Pass `recordId` to keep only that record's diffs.
 */
export function linkHistory(diffs: readonly LinkDiff[], recordId?: string): { links?: LinkDiff[] } {
  const list = recordId ? diffs.filter((d) => d.recordId === recordId) : [...diffs];
  return list.length ? { links: list } : {};
}

/** Realtime ops for computed changes in other tables. */
export function computeOps(...outcomes: ComputeOutcome[]): unknown[] {
  const ops: unknown[] = [];
  for (const o of outcomes) {
    for (const [tableId, ids] of o.touched) {
      ops.push({ op: "records.computed", tableId, recordIds: [...ids] });
    }
  }
  return ops;
}
