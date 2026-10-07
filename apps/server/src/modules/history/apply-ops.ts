import type { Database } from "@tabula/db";
import { sql, type Transaction } from "kysely";
import type { Redis } from "ioredis";
import { loadTableFields } from "../schema/field-map.js";
import { afterRecordCellWrite } from "../records/post-write.js";
import { loadSidecarFields, loadSidecarTableMeta } from "../recordstore/load-meta.js";
import { deleteSidecars, upsertSidecars } from "../recordstore/sidecars.js";
import { createDeletionBatchInTx } from "./apply-inverse.js";

type DbTrx = Transaction<Database>;

export interface HistoryOp {
  op: string;
  recordId?: string;
  recordIds?: string[];
  tableId?: string;
  fieldId?: string;
  relationId?: string;
  name?: string;
  cells?: Record<string, unknown>;
  batchId?: string;
  [key: string]: unknown;
}

/**
 * Op kinds the history applier understands. A change whose ops (or inverse
 * ops) include anything else cannot be undone/redone and is skipped by the
 * stack instead of blocking it.
 */
const SUPPORTED = new Set([
  "record.created",
  "record.deleted",
  "record.soft_deleted",
  "record.restore",
  "record.restored",
  "record.updated",
  "records.deleted",
  "records.created",
  "table.renamed",
  "table.created",
  "table.deleted",
  "table.soft_deleted",
  "table.restored",
  "field.created",
  "field.deleted",
  "field.soft_deleted",
  "field.restored",
  "field.renamed",
  "link_fields.created",
  "link_fields.deleted",
  "base.renamed",
]);

export function isSupportedOpList(ops: unknown): boolean {
  if (!Array.isArray(ops) || ops.length === 0) return false;
  return ops.every(
    (o) =>
      o !== null &&
      typeof o === "object" &&
      typeof (o as { op?: unknown }).op === "string" &&
      SUPPORTED.has((o as { op: string }).op),
  );
}

export interface ApplyContext {
  baseId: string;
  workspaceId: string;
  userId: string;
  changeSeq: number;
  redis: Redis | null;
  /** Table ids recorded on the original change (fallback for lookups). */
  tableIdsHint: string[];
}

export interface ApplyResult {
  tableIds: Set<string>;
  /** Ops to report on the undo/redo change (realtime hints). */
  appliedOps: HistoryOp[];
}

async function tableOfRecord(
  trx: DbTrx,
  ctx: ApplyContext,
  recordId: string,
  hint?: string,
): Promise<string | null> {
  if (hint) return hint;
  const r = await sql<{ table_id: string }>`
    SELECT table_id FROM data.records
    WHERE base_id = ${ctx.baseId} AND id = ${recordId}
    LIMIT 1
  `.execute(trx);
  return r.rows[0]?.table_id ?? ctx.tableIdsHint[0] ?? null;
}

async function adjustCounts(
  trx: DbTrx,
  ctx: ApplyContext,
  tableId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  await sql`
    UPDATE data.tables
    SET record_count = GREATEST(record_count + ${delta}, 0), updated_at = now()
    WHERE id = ${tableId}
  `.execute(trx);
  await sql`
    UPDATE data.base_runtime
    SET record_count = GREATEST(record_count + ${delta}, 0), updated_at = now()
    WHERE base_id = ${ctx.baseId}
  `.execute(trx);
}

/** Re-run sidecars + link sync + compute for a record whose cells changed. */
async function afterCellsChanged(
  trx: DbTrx,
  ctx: ApplyContext,
  tableId: string,
  recordId: string,
  cells: Record<string, unknown>,
  changedSlots: Record<string, unknown>,
): Promise<void> {
  const sidecarFields = await loadSidecarFields(trx, tableId);
  const sidecarTable = await loadSidecarTableMeta(
    trx,
    tableId,
    ctx.workspaceId,
    ctx.baseId,
  );
  await upsertSidecars(trx, tableId, recordId, cells, sidecarFields, sidecarTable);
  const fieldRows = await loadTableFields(trx, tableId);
  await afterRecordCellWrite(trx, {
    redis: ctx.redis,
    baseId: ctx.baseId,
    workspaceId: ctx.workspaceId,
    tableId,
    recordId,
    fieldRows,
    cells,
    changedSlots,
  });
}

async function softDeleteRecords(
  trx: DbTrx,
  ctx: ApplyContext,
  recordIds: string[],
  tableHint: string | undefined,
  result: ApplyResult,
): Promise<void> {
  if (recordIds.length === 0) return;
  const batchId = await createDeletionBatchInTx(trx, {
    workspaceId: ctx.workspaceId,
    baseId: ctx.baseId,
    userId: ctx.userId,
  });
  for (const recordId of recordIds) {
    const tableId = await tableOfRecord(trx, ctx, recordId, tableHint);
    if (!tableId) continue;
    const res = await sql<{ id: string }>`
      UPDATE data.records
      SET deleted_at = now(), deleted_by = ${ctx.userId}, updated_at = now(),
          deletion_batch_id = ${batchId}, last_change_seq = ${ctx.changeSeq}
      WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL
      RETURNING id
    `.execute(trx);
    if (res.rows.length === 0) continue;
    await sql`
      UPDATE data.record_links SET deletion_batch_id = ${batchId}
      WHERE base_id = ${ctx.baseId}
        AND (a_record_id = ${recordId} OR b_record_id = ${recordId})
        AND deletion_batch_id IS NULL
    `.execute(trx);
    await deleteSidecars(trx, tableId, recordId);
    await adjustCounts(trx, ctx, tableId, -1);
    result.tableIds.add(tableId);
    result.appliedOps.push({ op: "record.soft_deleted", recordId, tableId, batchId });
  }
}

async function restoreRecordRows(
  trx: DbTrx,
  ctx: ApplyContext,
  rows: Array<{ id: string; table_id: string; cells: unknown }>,
  result: ApplyResult,
): Promise<void> {
  for (const row of rows) {
    await adjustCounts(trx, ctx, row.table_id, 1);
    const cells = (row.cells ?? {}) as Record<string, unknown>;
    await afterCellsChanged(trx, ctx, row.table_id, row.id, cells, cells);
    result.tableIds.add(row.table_id);
    result.appliedOps.push({ op: "record.restored", recordId: row.id, tableId: row.table_id });
  }
}

/** Restore one soft-deleted record (and the links deleted with it). */
export async function restoreRecordInTx(
  trx: DbTrx,
  ctx: ApplyContext,
  recordId: string,
  result: ApplyResult,
): Promise<void> {
  const res = await sql<{ id: string; table_id: string; cells: unknown; deletion_batch_id: string | null }>`
    UPDATE data.records r
    SET deleted_at = NULL, deleted_by = NULL, deletion_batch_id = NULL,
        updated_at = now(), last_change_seq = ${ctx.changeSeq}
    FROM (SELECT deletion_batch_id AS old_batch FROM data.records
          WHERE base_id = ${ctx.baseId} AND id = ${recordId}) prev
    WHERE r.base_id = ${ctx.baseId} AND r.id = ${recordId} AND r.deleted_at IS NOT NULL
    RETURNING r.id, r.table_id, r.cells, prev.old_batch AS deletion_batch_id
  `.execute(trx);
  const row = res.rows[0];
  if (!row) return;
  if (row.deletion_batch_id) {
    // Only revive links whose other side is alive.
    await sql`
      UPDATE data.record_links l SET deletion_batch_id = NULL
      WHERE l.base_id = ${ctx.baseId}
        AND l.deletion_batch_id = ${row.deletion_batch_id}
        AND (l.a_record_id = ${recordId} OR l.b_record_id = ${recordId})
    `.execute(trx);
  }
  await restoreRecordRows(trx, ctx, [row], result);
}

export async function restoreBatchInTx(
  trx: DbTrx,
  ctx: ApplyContext,
  batchId: string,
  result: ApplyResult,
): Promise<void> {
  const res = await sql<{ id: string; table_id: string; cells: unknown }>`
    UPDATE data.records
    SET deleted_at = NULL, deleted_by = NULL, deletion_batch_id = NULL,
        updated_at = now(), last_change_seq = ${ctx.changeSeq}
    WHERE base_id = ${ctx.baseId} AND deletion_batch_id = ${batchId}
      AND deleted_at IS NOT NULL
    RETURNING id, table_id, cells
  `.execute(trx);
  await sql`
    UPDATE data.record_links SET deletion_batch_id = NULL
    WHERE base_id = ${ctx.baseId} AND deletion_batch_id = ${batchId}
  `.execute(trx);
  await sql`
    UPDATE data.deletion_batches SET restored_at = now()
    WHERE id = ${batchId} AND restored_at IS NULL
  `.execute(trx);
  await restoreRecordRows(trx, ctx, res.rows, result);
}

/** Pick a non-conflicting name when reviving a table/field. */
async function freeName(
  trx: DbTrx,
  kind: "table" | "field",
  scopeId: string,
  selfId: string,
  name: string,
): Promise<string> {
  let candidate = name;
  for (let i = 2; i < 50; i++) {
    const clash =
      kind === "table"
        ? await sql<{ id: string }>`
            SELECT id FROM data.tables
            WHERE base_id = ${scopeId} AND lower(name) = lower(${candidate})
              AND deleted_at IS NULL AND id <> ${selfId} LIMIT 1
          `.execute(trx)
        : await sql<{ id: string }>`
            SELECT id FROM data.fields
            WHERE table_id = ${scopeId} AND lower(name) = lower(${candidate})
              AND deleted_at IS NULL AND id <> ${selfId} LIMIT 1
          `.execute(trx);
    if (clash.rows.length === 0) return candidate;
    candidate = `${name} (${i})`;
  }
  return `${name} (${Date.now()})`;
}

export async function setTableDeletedInTx(
  trx: DbTrx,
  ctx: ApplyContext,
  tableId: string,
  deleted: boolean,
  result: ApplyResult,
): Promise<void> {
  if (deleted) {
    const res = await sql<{ id: string }>`
      UPDATE data.tables SET deleted_at = now(), deleted_by = ${ctx.userId}, updated_at = now()
      WHERE id = ${tableId} AND base_id = ${ctx.baseId} AND deleted_at IS NULL
      RETURNING id
    `.execute(trx);
    if (res.rows.length > 0) {
      result.tableIds.add(tableId);
      result.appliedOps.push({ op: "table.soft_deleted", tableId });
    }
    return;
  }
  const row = await sql<{ name: string }>`
    SELECT name FROM data.tables
    WHERE id = ${tableId} AND base_id = ${ctx.baseId} AND deleted_at IS NOT NULL
  `.execute(trx);
  const current = row.rows[0];
  if (!current) return;
  const name = await freeName(trx, "table", ctx.baseId, tableId, current.name);
  await sql`
    UPDATE data.tables SET deleted_at = NULL, deleted_by = NULL, name = ${name}, updated_at = now()
    WHERE id = ${tableId}
  `.execute(trx);
  result.tableIds.add(tableId);
  result.appliedOps.push({ op: "table.restored", tableId });
}

export async function setFieldDeletedInTx(
  trx: DbTrx,
  ctx: ApplyContext,
  fieldId: string,
  deleted: boolean,
  result: ApplyResult,
): Promise<void> {
  const row = await sql<{ table_id: string; name: string; deleted: boolean }>`
    SELECT table_id, name, (deleted_at IS NOT NULL) AS deleted FROM data.fields
    WHERE id = ${fieldId} AND base_id = ${ctx.baseId}
  `.execute(trx);
  const f = row.rows[0];
  if (!f || f.deleted === deleted) return;
  if (deleted) {
    // Never soft-delete the primary field.
    const primary = await sql<{ id: string }>`
      SELECT id FROM data.tables WHERE id = ${f.table_id} AND primary_field_id = ${fieldId}
    `.execute(trx);
    if (primary.rows.length > 0) return;
    await sql`
      UPDATE data.fields SET deleted_at = now(), deleted_by = ${ctx.userId}, updated_at = now()
      WHERE id = ${fieldId}
    `.execute(trx);
    result.appliedOps.push({ op: "field.soft_deleted", fieldId, tableId: f.table_id });
  } else {
    const name = await freeName(trx, "field", f.table_id, fieldId, f.name);
    await sql`
      UPDATE data.fields SET deleted_at = NULL, deleted_by = NULL, name = ${name}, updated_at = now()
      WHERE id = ${fieldId}
    `.execute(trx);
    result.appliedOps.push({ op: "field.restored", fieldId, tableId: f.table_id });
  }
  result.tableIds.add(f.table_id);
}

function findPairCells(
  pairOps: HistoryOp[],
  recordId: string,
): Record<string, unknown> | undefined {
  for (const p of pairOps) {
    if (p.op === "record.updated" && p.recordId === recordId && p.cells) {
      return p.cells;
    }
  }
  return undefined;
}

/**
 * Apply history ops (inverse ops for undo, forward ops for redo).
 * `pairOps` are the ops of the opposite direction; for `record.updated` they
 * let us patch only the slots that the original change touched, so concurrent
 * edits to other fields are preserved.
 */
export async function applyHistoryOpsInTx(
  trx: DbTrx,
  ctx: ApplyContext,
  ops: HistoryOp[],
  pairOps: HistoryOp[],
): Promise<ApplyResult> {
  const result: ApplyResult = { tableIds: new Set(), appliedOps: [] };

  for (const op of ops) {
    switch (op.op) {
      case "record.created":
      case "records.created": {
        // Redo of a create (the undo soft-deleted it): bring it back.
        const ids = op.recordIds ?? (op.recordId ? [op.recordId] : []);
        for (const id of ids) await restoreRecordInTx(trx, ctx, id, result);
        break;
      }
      case "record.deleted":
      case "records.deleted":
      case "record.soft_deleted": {
        const ids = op.recordIds ?? (op.recordId ? [op.recordId] : []);
        await softDeleteRecords(trx, ctx, ids, op.tableId, result);
        break;
      }
      case "record.restore":
      case "record.restored": {
        if (op.batchId) await restoreBatchInTx(trx, ctx, op.batchId, result);
        else if (op.recordId) await restoreRecordInTx(trx, ctx, op.recordId, result);
        break;
      }
      case "record.updated": {
        if (!op.recordId || !op.cells) break;
        const tableId = await tableOfRecord(trx, ctx, op.recordId, op.tableId);
        if (!tableId) break;
        const current = await sql<{ cells: unknown }>`
          SELECT cells FROM data.records
          WHERE table_id = ${tableId} AND id = ${op.recordId} AND deleted_at IS NULL
          FOR UPDATE
        `.execute(trx);
        const row = current.rows[0];
        if (!row) break;
        const currentCells = { ...((row.cells ?? {}) as Record<string, unknown>) };
        const target = op.cells;
        const other = findPairCells(pairOps, op.recordId);
        // Slots the original change touched: those that differ between the
        // before/after snapshots (all target slots if we lack the pair).
        const slots = new Set<string>();
        if (other) {
          for (const k of new Set([...Object.keys(target), ...Object.keys(other)])) {
            if (JSON.stringify(target[k]) !== JSON.stringify(other[k])) slots.add(k);
          }
        } else {
          for (const k of Object.keys(target)) slots.add(k);
        }
        if (slots.size === 0) break;
        const changed: Record<string, unknown> = {};
        for (const k of slots) {
          if (k in target) {
            currentCells[k] = target[k];
            changed[k] = target[k];
          } else {
            delete currentCells[k];
            changed[k] = null;
          }
        }
        await sql`
          UPDATE data.records
          SET cells = ${JSON.stringify(currentCells)}::jsonb,
              version = version + 1,
              updated_by = ${ctx.userId},
              updated_at = now(),
              last_change_seq = ${ctx.changeSeq}
          WHERE table_id = ${tableId} AND id = ${op.recordId}
        `.execute(trx);
        await afterCellsChanged(trx, ctx, tableId, op.recordId, currentCells, changed);
        result.tableIds.add(tableId);
        result.appliedOps.push({
          op: "record.updated",
          recordId: op.recordId,
          tableId,
          cells: currentCells,
          prevCells: (row.cells ?? {}) as Record<string, unknown>,
        });
        break;
      }
      case "table.renamed": {
        if (!op.tableId || typeof op.name !== "string") break;
        const name = await freeName(trx, "table", ctx.baseId, op.tableId, op.name);
        await sql`
          UPDATE data.tables SET name = ${name}, updated_by = ${ctx.userId}, updated_at = now()
          WHERE id = ${op.tableId} AND base_id = ${ctx.baseId}
        `.execute(trx);
        result.tableIds.add(op.tableId);
        result.appliedOps.push({ op: "table.renamed", tableId: op.tableId, name });
        break;
      }
      case "table.deleted":
      case "table.soft_deleted":
        if (op.tableId) await setTableDeletedInTx(trx, ctx, op.tableId, true, result);
        break;
      case "table.created":
      case "table.restored":
        if (op.tableId) await setTableDeletedInTx(trx, ctx, op.tableId, false, result);
        break;
      case "field.deleted":
      case "field.soft_deleted":
        if (op.fieldId) await setFieldDeletedInTx(trx, ctx, op.fieldId, true, result);
        break;
      case "field.created":
      case "field.restored":
        if (op.fieldId) await setFieldDeletedInTx(trx, ctx, op.fieldId, false, result);
        break;
      case "field.renamed": {
        if (!op.fieldId || typeof op.name !== "string") break;
        await sql`
          UPDATE data.fields SET name = ${op.name}, updated_by = ${ctx.userId}, updated_at = now()
          WHERE id = ${op.fieldId} AND base_id = ${ctx.baseId}
        `.execute(trx);
        result.appliedOps.push({ op: "field.renamed", fieldId: op.fieldId });
        break;
      }
      case "link_fields.created":
      case "link_fields.deleted": {
        if (!op.relationId) break;
        const rel = await sql<{ a_field_id: string; b_field_id: string | null }>`
          SELECT a_field_id, b_field_id FROM data.link_relations
          WHERE id = ${op.relationId} AND base_id = ${ctx.baseId}
        `.execute(trx);
        const r = rel.rows[0];
        if (!r) break;
        const del = op.op === "link_fields.deleted";
        for (const fid of [r.a_field_id, r.b_field_id]) {
          if (fid) await setFieldDeletedInTx(trx, ctx, fid, del, result);
        }
        break;
      }
      case "base.renamed": {
        if (typeof op.name !== "string") break;
        await sql`
          UPDATE data.bases SET name = ${op.name}, updated_by = ${ctx.userId}, updated_at = now()
          WHERE id = ${ctx.baseId}
        `.execute(trx);
        await sql`
          UPDATE core.base_directory SET name = ${op.name}, updated_at = now()
          WHERE base_id = ${ctx.baseId}
        `.execute(trx);
        result.appliedOps.push({ op: "base.renamed", name: op.name });
        break;
      }
      default:
        break;
    }
  }
  return result;
}
