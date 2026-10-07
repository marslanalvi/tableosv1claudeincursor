/**
 * Legacy post-write hook for callers that write `records.cells` themselves
 * (history apply-ops, wave4 record-writer, imports). Prefer `write.ts`.
 *
 * - Link arrays present in `changedSlots` are applied to `data.record_links`
 *   (replace semantics for that record's side) and stripped from cells.
 *   Untouched link slots are never re-synced (that clobbered peer links).
 * - Computed fields of the record are recomputed, plus dependents in this and
 *   linked tables.
 */
import type { Database } from "@tabula/db";
import { sql, type Transaction } from "kysely";
import type { Redis } from "ioredis";
import { runComputeInTx, type RecordChange } from "../compute/engine.js";
import { syncLinkCellsDetailed } from "../links/record-links.js";
import type { FieldRow } from "../schema/field-map.js";

type DbTrx = Transaction<Database>;

export function changedSlotsToFieldIds(
  fieldRows: FieldRow[],
  cellPatch: Record<string, unknown>,
): string[] {
  const ids: string[] = [];
  for (const f of fieldRows) {
    if (String(f.slot) in cellPatch) {
      ids.push(f.id);
    }
  }
  return ids;
}

const COMPUTED = new Set(["formula", "lookup", "rollup", "count", "ai_generated"]);

export async function afterRecordCellWrite(
  trx: DbTrx,
  params: {
    redis: Redis | null;
    baseId: string;
    workspaceId: string;
    tableId: string;
    recordId: string;
    fieldRows: FieldRow[];
    cells: Record<string, unknown>;
    changedSlots: Record<string, unknown>;
    afterCommit?: (fn: () => Promise<void> | void) => void;
  },
): Promise<void> {
  const linkFields = params.fieldRows
    .filter((f) => f.type === "link" || f.type === "contact")
    .map((f) => ({ fieldId: f.id, slot: f.slot }));

  const linkResults = await syncLinkCellsDetailed(trx, {
    workspaceId: params.workspaceId,
    baseId: params.baseId,
    tableId: params.tableId,
    recordId: params.recordId,
    linkFields,
    cells: params.cells,
    changedSlots: params.changedSlots,
  });

  const linkSlots = linkFields.map((l) => String(l.slot)).filter((s) => s in params.cells);
  if (linkSlots.length) {
    await sql`
      UPDATE data.records SET cells = cells - ${linkSlots}::text[]
      WHERE table_id = ${params.tableId} AND id = ${params.recordId}
    `.execute(trx);
  }

  const changes: RecordChange[] = [];
  const changed = changedSlotsToFieldIds(params.fieldRows, params.changedSlots);
  if (changed.length) changes.push({ tableId: params.tableId, recordIds: [params.recordId], fieldIds: changed });
  for (const { fieldId, result } of linkResults) {
    changes.push({ tableId: params.tableId, recordIds: [params.recordId], fieldIds: [fieldId] });
    const peers = [...result.added, ...result.removed];
    if (peers.length && result.peerFieldId) {
      changes.push({ tableId: result.peerTableId, recordIds: peers, fieldIds: [result.peerFieldId] });
    }
  }
  const seeds = params.fieldRows
    .filter((f) => COMPUTED.has(f.type))
    .map((f) => ({ fieldId: f.id, recordIds: [params.recordId] }));

  await runComputeInTx(
    trx,
    {
      baseId: params.baseId,
      workspaceId: params.workspaceId,
      redis: params.redis,
      ...(params.afterCommit ? { afterCommit: params.afterCommit } : {}),
    },
    { changes, seeds },
  );
}
