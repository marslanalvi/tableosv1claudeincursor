/**
 * Record writes for wave-4 modules that cannot go through the HTTP record
 * routes (public form submit has no session; contacts). Delegates to B's write
 * path (`records/write.ts`: validation, typecast, links, compute, counters),
 * wrapped in one base change per call.
 *
 * Inputs are keyed by field **slot** (string) for convenience; values use the
 * wire input shapes (CONTRACTS §3). Attachment values may be raw uuids.
 */
import { sql } from "kysely";
import type { AppContext } from "../../lib/app-context.js";
import { pid } from "../../lib/public-ids.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import {
  computeOps,
  createRecordsInTx,
  deleteRecordsInTx,
  touchedTableIds,
  updateRecordsInTx,
  type WriteContext,
} from "../records/write.js";

export interface WriteScope {
  orgId: string;
  workspaceId: string;
  baseId: string;
  tableId: string;
  actor: MutationActor;
  /** created_by for the record (null for anonymous form submissions). */
  userId: string | null;
  via?: "ui" | "api" | "form" | "import";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** slot-keyed → field-uuid-keyed input (B's writer resolves raw uuids). */
async function bySlotToFieldInput(
  ctx: AppContext,
  tableId: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const fields = await sql<{ id: string; slot: number; type: string }>`
    SELECT id, slot, type FROM data.fields WHERE table_id = ${tableId} AND deleted_at IS NULL
  `.execute(ctx.db);
  const bySlot = new Map(fields.rows.map((f) => [String(f.slot), f]));
  return rows.map((cells) => {
    const out: Record<string, unknown> = {};
    for (const [slot, raw] of Object.entries(cells)) {
      const f = bySlot.get(slot);
      if (!f) continue;
      let value = raw;
      if (f.type === "attachment" && Array.isArray(raw)) {
        value = raw.map((v) => (typeof v === "string" && UUID_RE.test(v) ? pid("att", v) : v));
      }
      out[pid("fld", f.id)] = value === undefined ? null : value;
    }
    return out;
  });
}

function writeCtx(ctx: AppContext, scope: WriteScope, trx: WriteContext["trx"], changeSeq: number, afterCommit: (fn: () => Promise<void> | void) => void): WriteContext {
  return {
    trx,
    baseId: scope.baseId,
    workspaceId: scope.workspaceId,
    changeSeq,
    userId: scope.userId,
    via: scope.via ?? "api",
    redis: ctx.redis,
    afterCommit,
  };
}

export async function createRecordsBySlot(
  ctx: AppContext,
  scope: WriteScope,
  rows: Record<string, unknown>[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const items = (await bySlotToFieldInput(ctx, scope.tableId, rows)).map((fields) => ({ fields }));
  return createRecords(ctx, scope, items, true);
}

/** Create records from wire-shaped input (`{fields}` keyed by fld_ id or name). ≤ 500 per call. */
export async function createRecords(
  ctx: AppContext,
  scope: WriteScope,
  items: { fields: Record<string, unknown> }[],
  typecast: boolean,
): Promise<string[]> {
  if (items.length === 0) return [];
  let ids: string[] = [];
  await withBaseTx(
    ctx.db,
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      baseId: scope.baseId,
      actor: scope.actor,
      redis: ctx.redis,
    },
    async (mctx, trx) => {
      const res = await createRecordsInTx(
        writeCtx(ctx, scope, trx, mctx.changeSeq, (fn) => mctx.afterCommit(fn)),
        scope.tableId,
        items,
        { typecast },
      );
      ids = res.ids;
      const single = ids.length === 1;
      return {
        kind: single ? ("records" as const) : ("bulk" as const),
        ops: [
          ...ids.map((recordId) => ({ op: "record.created", recordId, tableId: scope.tableId })),
          ...computeOps(res.compute),
        ],
        inverseOps: ids.map((recordId) => ({ op: "record.deleted", recordId })),
        tableIds: touchedTableIds(scope.tableId, res.compute),
        eventType: single ? "record.created" : "records.batch_created",
        aggregateType: single ? "record" : "table",
        aggregateId: single ? (ids[0] as string) : scope.tableId,
        payload: single
          ? { tableId: scope.tableId, recordId: ids[0] }
          : { tableId: scope.tableId, recordIds: ids, count: ids.length },
      };
    },
  );
  return ids;
}

/** Patch cells (by slot) of one record. `null` clears a cell. */
export async function updateRecordBySlot(
  ctx: AppContext,
  scope: WriteScope,
  recordId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const [fields] = await bySlotToFieldInput(ctx, scope.tableId, [patch]);
  await withBaseTx(
    ctx.db,
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      baseId: scope.baseId,
      actor: scope.actor,
      redis: ctx.redis,
    },
    async (mctx, trx) => {
      const res = await updateRecordsInTx(
        writeCtx(ctx, scope, trx, mctx.changeSeq, (fn) => mctx.afterCommit(fn)),
        scope.tableId,
        [{ id: recordId, fields: fields ?? {} }],
        { typecast: true },
      );
      const before = res.before.get(recordId) ?? {};
      const after = res.after.get(recordId) ?? {};
      return {
        kind: "records" as const,
        ops: [
          { op: "record.updated", recordId, tableId: scope.tableId, cells: after },
          ...computeOps(res.compute),
        ],
        inverseOps: [{ op: "record.updated", recordId, cells: before }],
        tableIds: touchedTableIds(scope.tableId, res.compute),
        eventType: "record.updated",
        aggregateType: "record",
        aggregateId: recordId,
        payload: { tableId: scope.tableId, recordId },
      };
    },
  );
}

/** Soft-delete records (counters, links, compute; one base change). Returns count deleted. */
export async function softDeleteRecords(
  ctx: AppContext,
  scope: WriteScope,
  recordIds: string[],
): Promise<number> {
  if (recordIds.length === 0) return 0;
  const live = await sql<{ id: string }>`
    SELECT id FROM data.records
    WHERE table_id = ${scope.tableId} AND id = ANY(${recordIds}::uuid[]) AND deleted_at IS NULL
  `.execute(ctx.db);
  if (live.rows.length === 0) return 0;
  let deleted = 0;
  await withBaseTx(
    ctx.db,
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      baseId: scope.baseId,
      actor: scope.actor,
      redis: ctx.redis,
    },
    async (mctx, trx) => {
      const res = await deleteRecordsInTx(
        writeCtx(ctx, scope, trx, mctx.changeSeq, (fn) => mctx.afterCommit(fn)),
        scope.tableId,
        live.rows.map((r) => r.id),
      );
      deleted = res.ids.length;
      return {
        kind: "records" as const,
        ops: [
          ...res.ids.map((recordId) => ({ op: "record.deleted", recordId, tableId: scope.tableId })),
          ...computeOps(res.compute),
        ],
        inverseOps: [{ op: "record.restore", batchId: res.batchId }],
        tableIds: touchedTableIds(scope.tableId, res.compute),
        eventType: res.ids.length === 1 ? "record.deleted" : "records.batch_deleted",
        aggregateType: res.ids.length === 1 ? "record" : "table",
        aggregateId: res.ids.length === 1 ? (res.ids[0] as string) : scope.tableId,
        payload: {
          tableId: scope.tableId,
          recordIds: res.ids,
          ...(res.ids.length === 1 ? { recordId: res.ids[0] } : {}),
        },
      };
    },
  );
  return deleted;
}
