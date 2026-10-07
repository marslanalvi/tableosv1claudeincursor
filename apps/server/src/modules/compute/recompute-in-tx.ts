/**
 * Compatibility wrapper over the compute engine (`engine.ts`).
 * Recomputes fields that depend on `changedFieldIds` for `targets`, plus
 * records reached through links.
 */
import type { Database } from "@tabula/db";
import type { Redis } from "ioredis";
import type { Transaction } from "kysely";
import { runComputeInTx, type ComputeScope } from "./engine.js";

type DbTrx = Transaction<Database>;

export interface RecomputeTarget {
  tableId: string;
  recordId: string;
}

export interface RecomputeResult {
  updatedRecords: number;
  deferred: boolean;
}

export async function recomputeInTx(
  trx: DbTrx,
  baseId: string,
  workspaceId: string,
  targets: RecomputeTarget[],
  changedFieldIds: string[],
  redis: Redis | null,
  afterCommit?: ComputeScope["afterCommit"],
): Promise<RecomputeResult> {
  if (targets.length === 0 || changedFieldIds.length === 0) return { updatedRecords: 0, deferred: false };
  const byTable = new Map<string, string[]>();
  for (const t of targets) {
    const list = byTable.get(t.tableId) ?? [];
    list.push(t.recordId);
    byTable.set(t.tableId, list);
  }
  const res = await runComputeInTx(
    trx,
    { baseId, workspaceId, redis, ...(afterCommit ? { afterCommit } : {}) },
    {
      changes: [...byTable].map(([tableId, recordIds]) => ({ tableId, recordIds, fieldIds: changedFieldIds })),
    },
  );
  let n = 0;
  for (const s of res.touched.values()) n += s.size;
  return { updatedRecords: n, deferred: res.deferred > 0 };
}
