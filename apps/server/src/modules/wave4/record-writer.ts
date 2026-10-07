/**
 * Record create/update for wave-4 modules that cannot go through the HTTP
 * record routes (public form submit has no session; contacts).
 *
 * Mirrors B's write path (cells by slot → insert → sidecars → links/compute →
 * one base change). When B ships `records/write.ts` (`createRecordsInTx`),
 * swap the bodies below to delegate to it.
 */
import { generateUuidV7, keyBetween } from "@tabula/types";
import { sql } from "kysely";
import type { AppContext } from "../../lib/app-context.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { loadTableFields, type FieldRow } from "../schema/field-map.js";
import { afterRecordCellWrite } from "../records/post-write.js";
import { loadSidecarFields, loadSidecarTableMeta } from "../recordstore/load-meta.js";
import { upsertSidecars } from "../recordstore/sidecars.js";

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

export async function createRecordsBySlot(
  ctx: AppContext,
  scope: WriteScope,
  rows: Record<string, unknown>[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const fieldRows: FieldRow[] = await loadTableFields(ctx.db, scope.tableId);
  const sidecarFields = await loadSidecarFields(ctx.db, scope.tableId);
  const sidecarTable = await loadSidecarTableMeta(
    ctx.db,
    scope.tableId,
    scope.workspaceId,
    scope.baseId,
  );
  const ids: string[] = [];

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
      const last = await sql<{ manual_order: string }>`
        SELECT manual_order FROM data.records
        WHERE table_id = ${scope.tableId} AND deleted_at IS NULL
        ORDER BY manual_order COLLATE "C" DESC LIMIT 1
      `.execute(trx);
      let prevKey: string | null = last.rows[0]?.manual_order ?? null;
      const ops: unknown[] = [];

      for (const cells of rows) {
        const recordId = generateUuidV7();
        const rowNum = await sql<{ row_number: string }>`
          UPDATE data.tables
          SET next_row_number = next_row_number + 1,
              record_count = record_count + 1,
              updated_at = now()
          WHERE id = ${scope.tableId}
          RETURNING (next_row_number - 1) AS row_number
        `.execute(trx);
        const rowNumber = rowNum.rows[0]?.row_number ?? "1";
        let manualOrder: string;
        try {
          manualOrder = keyBetween(prevKey, null);
        } catch {
          manualOrder = keyBetween(null, null);
        }
        prevKey = manualOrder;

        await sql`
          INSERT INTO data.records (
            table_id, id, workspace_id, base_id, row_number, manual_order, cells,
            created_by, updated_by, created_via, last_change_seq
          ) VALUES (
            ${scope.tableId}, ${recordId}, ${scope.workspaceId}, ${scope.baseId},
            ${rowNumber}, ${manualOrder}, ${JSON.stringify(cells)}::jsonb,
            ${scope.userId}, ${scope.userId}, ${viaFor(scope.via)}, ${mctx.changeSeq}
          )
        `.execute(trx);
        await upsertSidecars(trx, scope.tableId, recordId, cells, sidecarFields, sidecarTable);
        await afterRecordCellWrite(trx, {
          redis: ctx.redis,
          baseId: scope.baseId,
          workspaceId: scope.workspaceId,
          tableId: scope.tableId,
          recordId,
          fieldRows,
          cells,
          changedSlots: cells,
        });
        ids.push(recordId);
        ops.push({ op: "record.created", recordId, tableId: scope.tableId, cells });
      }

      await sql`
        UPDATE data.base_runtime
        SET record_count = record_count + ${rows.length}, updated_at = now()
        WHERE base_id = ${scope.baseId}
      `.execute(trx);

      const single = ids.length === 1;
      return {
        kind: single ? ("records" as const) : ("bulk" as const),
        ops,
        inverseOps: ids.map((recordId) => ({ op: "record.deleted", recordId })),
        tableIds: [scope.tableId],
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

/** Patch cells (by slot) of one record. */
export async function updateRecordBySlot(
  ctx: AppContext,
  scope: WriteScope,
  recordId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const fieldRows = await loadTableFields(ctx.db, scope.tableId);
  const sidecarFields = await loadSidecarFields(ctx.db, scope.tableId);
  const sidecarTable = await loadSidecarTableMeta(
    ctx.db,
    scope.tableId,
    scope.workspaceId,
    scope.baseId,
  );
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
      const cur = await sql<{ cells: Record<string, unknown> }>`
        SELECT cells FROM data.records
        WHERE table_id = ${scope.tableId} AND id = ${recordId} AND deleted_at IS NULL
        FOR UPDATE
      `.execute(trx);
      const before = cur.rows[0]?.cells ?? {};
      const next: Record<string, unknown> = { ...before };
      for (const [slot, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === "") delete next[slot];
        else next[slot] = value;
      }
      await sql`
        UPDATE data.records
        SET cells = ${JSON.stringify(next)}::jsonb,
            version = version + 1,
            updated_at = now(),
            updated_by = ${scope.userId},
            last_change_seq = ${mctx.changeSeq}
        WHERE table_id = ${scope.tableId} AND id = ${recordId}
      `.execute(trx);
      await upsertSidecars(trx, scope.tableId, recordId, next, sidecarFields, sidecarTable);
      await afterRecordCellWrite(trx, {
        redis: ctx.redis,
        baseId: scope.baseId,
        workspaceId: scope.workspaceId,
        tableId: scope.tableId,
        recordId,
        fieldRows,
        cells: next,
        changedSlots: patch,
      });
      const inverse: Record<string, unknown> = {};
      for (const slot of Object.keys(patch)) inverse[slot] = before[slot] ?? null;
      return {
        kind: "records" as const,
        ops: [{ op: "record.updated", recordId, tableId: scope.tableId, cells: patch }],
        inverseOps: [{ op: "record.updated", recordId, cells: inverse }],
        tableIds: [scope.tableId],
        eventType: "record.updated",
        aggregateType: "record",
        aggregateId: recordId,
        payload: { tableId: scope.tableId, recordId },
      };
    },
  );
}

function viaFor(via: WriteScope["via"]): string {
  return via ?? "api";
}

/** Soft-delete records (counters + one base change). */
export async function softDeleteRecords(
  ctx: AppContext,
  scope: WriteScope,
  recordIds: string[],
): Promise<number> {
  if (recordIds.length === 0) return 0;
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
    async (_mctx, trx) => {
      const res = await sql<{ id: string }>`
        UPDATE data.records
        SET deleted_at = now(), deleted_by = ${scope.userId}
        WHERE table_id = ${scope.tableId} AND id = ANY(${recordIds}::uuid[]) AND deleted_at IS NULL
        RETURNING id
      `.execute(trx);
      deleted = res.rows.length;
      if (deleted > 0) {
        await sql`
          UPDATE data.tables SET record_count = GREATEST(record_count - ${deleted}, 0), updated_at = now()
          WHERE id = ${scope.tableId}
        `.execute(trx);
        await sql`
          UPDATE data.base_runtime SET record_count = GREATEST(record_count - ${deleted}, 0), updated_at = now()
          WHERE base_id = ${scope.baseId}
        `.execute(trx);
      }
      const ids = res.rows.map((r) => r.id);
      return {
        kind: "records" as const,
        ops: ids.map((recordId) => ({ op: "record.deleted", recordId, tableId: scope.tableId })),
        inverseOps: ids.map((recordId) => ({ op: "record.restored", recordId })),
        tableIds: [scope.tableId],
        eventType: ids.length === 1 ? "record.deleted" : "records.batch_deleted",
        aggregateType: ids.length === 1 ? "record" : "table",
        aggregateId: ids.length === 1 ? (ids[0] as string) : scope.tableId,
        payload: { tableId: scope.tableId, recordIds: ids, ...(ids.length === 1 ? { recordId: ids[0] } : {}) },
      };
    },
  );
  return deleted;
}
