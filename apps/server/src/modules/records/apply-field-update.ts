import type { TabulaDb } from "@tabula/db";
import type { Redis } from "ioredis";
import { ApiError } from "../../http/errors.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { computeOps, touchedTableIds, updateRecordsInTx, TableWriter } from "./write.js";

export class RecordFieldUpdateError extends Error {
  constructor(
    readonly code: "RECORD_NOT_FOUND" | "VERSION_CONFLICT" | "FIELD_NOT_FOUND" | "VALIDATION_FAILED",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RecordFieldUpdateError";
  }
}

export interface ApplyFieldUpdateParams {
  db: TabulaDb;
  redis: Redis | null;
  orgId: string;
  workspaceId: string;
  baseId: string;
  tableId: string;
  recordId: string;
  fieldPublicId: string;
  value: unknown;
  expectedVersion?: number;
  actor: MutationActor;
  clientMutationId?: string;
}

export interface ApplyFieldUpdateResult {
  seq: number;
  version: number;
  ops: unknown[];
}

/** Single-cell write (realtime `op` path) through the validated write path. */
export async function applyRecordFieldUpdate(
  params: ApplyFieldUpdateParams,
): Promise<ApplyFieldUpdateResult> {
  let newVersion = 0;
  let mutationOps: unknown[] = [];

  try {
    const seq = await withBaseTx(
      params.db,
      {
        orgId: params.orgId,
        workspaceId: params.workspaceId,
        baseId: params.baseId,
        actor: params.actor,
        redis: params.redis,
        ...(params.clientMutationId !== undefined ? { clientMutationId: params.clientMutationId } : {}),
      },
      async (mctx, trx) => {
        const writer = await TableWriter.load(trx, params.tableId);
        const res = await updateRecordsInTx(
          {
            trx,
            baseId: params.baseId,
            workspaceId: params.workspaceId,
            changeSeq: mctx.changeSeq,
            userId: params.actor.actorId,
            via: "ui",
            redis: params.redis,
            afterCommit: mctx.afterCommit,
          },
          params.tableId,
          [
            {
              id: params.recordId,
              fields: { [params.fieldPublicId]: params.value },
              ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
            },
          ],
          { writer },
        );
        newVersion = res.versions.get(params.recordId) ?? 0;
        const cells = res.after.get(params.recordId) ?? {};
        mutationOps = [
          { op: "record.updated", tableId: params.tableId, recordId: params.recordId, cells },
          ...computeOps(res.compute),
        ];
        return {
          kind: "records",
          ops: mutationOps,
          inverseOps: [
            {
              op: "record.updated",
              tableId: params.tableId,
              recordId: params.recordId,
              cells: res.before.get(params.recordId) ?? {},
            },
          ],
          tableIds: touchedTableIds(params.tableId, res.compute),
          eventType: "record.updated",
          aggregateType: "record",
          aggregateId: params.recordId,
          payload: { tableId: params.tableId, recordId: params.recordId, version: newVersion },
        };
      },
    );
    return { seq, version: newVersion, ops: mutationOps };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === "RECORD_NOT_FOUND") throw new RecordFieldUpdateError("RECORD_NOT_FOUND", e.message);
      if (e.code === "VERSION_CONFLICT") throw new RecordFieldUpdateError("VERSION_CONFLICT", e.message);
      if (e.code === "UNKNOWN_FIELD") throw new RecordFieldUpdateError("FIELD_NOT_FOUND", e.message);
      throw new RecordFieldUpdateError("VALIDATION_FAILED", e.message);
    }
    throw e;
  }
}
