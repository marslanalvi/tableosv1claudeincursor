import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound, PROBLEM_CONTENT_TYPE } from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";
import { compileForUser } from "../access/compile.js";
import { assertCan } from "../access/assert.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import {
  applyHistoryOpsInTx,
  isSupportedOpList,
  restoreBatchInTx,
  restoreRecordInTx,
  setFieldDeletedInTx,
  setTableDeletedInTx,
  type ApplyResult,
  type HistoryOp,
} from "./apply-ops.js";

const restoreBody = z
  .object({
    deletionBatchId: z.string().uuid().optional(),
    recordId: z.string().optional(),
    tableId: z.string().optional(),
    fieldId: z.string().optional(),
  })
  .refine(
    (b) => Boolean(b.deletionBatchId || b.recordId || b.tableId || b.fieldId),
    { message: "Provide deletionBatchId, recordId, tableId or fieldId" },
  );

class StackRaceError extends Error {}
class NothingToRestoreError extends Error {}

/** Changes that are part of a user's undo stack (normal edits). */
const STACK_KINDS_EXCLUDED = ["undo", "redo", "restore"];

function actor(
  user: NonNullable<FastifyRequest["user"]>,
  via: MutationActor["via"],
): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via,
  };
}

function sendStackProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  code: "NOTHING_TO_UNDO" | "NOTHING_TO_REDO",
): void {
  void reply
    .code(409)
    .header("content-type", PROBLEM_CONTENT_TYPE)
    .send({
      type: `https://tabula.dev/errors/${code.toLowerCase().replace(/_/g, "-")}`,
      code,
      title: code === "NOTHING_TO_UNDO" ? "Nothing to undo" : "Nothing to redo",
      status: 409,
      detail: code === "NOTHING_TO_UNDO" ? "Nothing to undo" : "Nothing to redo",
      requestId: request.id,
    });
}

interface ChangeRow {
  seq: string;
  kind: string;
  ops: unknown;
  inverse_ops: unknown;
  table_ids: string[];
}

/** Short human description of a change for toasts ("Undid: edit record"). */
export function describeOps(ops: unknown): string {
  if (!Array.isArray(ops) || ops.length === 0) return "change";
  const names = ops
    .map((o) => (o && typeof o === "object" ? String((o as { op?: unknown }).op ?? "") : ""))
    .filter(Boolean);
  const first = names[0] ?? "";
  const n = names.length;
  const plural = (s: string) => (n > 1 ? `${n} ${s}s` : s);
  if (first.startsWith("record.updated")) return plural("record edit");
  if (first === "record.created" || first === "records.created") return plural("new record");
  if (first.includes("deleted") && first.startsWith("record")) return plural("record deletion");
  if (first.startsWith("record.restore")) return "record restore";
  if (first === "table.renamed") return "table rename";
  if (first.startsWith("table.")) return first.endsWith("deleted") ? "table deletion" : "table change";
  if (first.startsWith("field.") || first.startsWith("link_fields.")) return "field change";
  if (first === "base.renamed") return "base rename";
  return "change";
}

async function lastUndoableSeq(
  db: AppContext["db"],
  baseId: string,
  userId: string,
): Promise<number> {
  const r = await sql<{ seq: string | null }>`
    SELECT max(seq) AS seq FROM data.base_changes
    WHERE base_id = ${baseId} AND actor_id = ${userId}
      AND kind <> ALL(${STACK_KINDS_EXCLUDED}::text[])
      AND inverse_ops IS NOT NULL
  `.execute(db);
  return Number(r.rows[0]?.seq ?? 0);
}

async function findUndoCandidate(
  db: AppContext["db"],
  baseId: string,
  userId: string,
): Promise<ChangeRow | null> {
  // Walk back through the user's edits, skipping ones we cannot undo.
  for (let i = 0; i < 100; i++) {
    const r = await sql<ChangeRow>`
      SELECT seq, kind, ops, inverse_ops, table_ids
      FROM data.base_changes
      WHERE base_id = ${baseId} AND actor_id = ${userId}
        AND kind <> ALL(${STACK_KINDS_EXCLUDED}::text[])
        AND inverse_ops IS NOT NULL
        AND undone_by_seq IS NULL
        AND NOT undo_skipped
      ORDER BY seq DESC
      LIMIT 1
    `.execute(db);
    const row = r.rows[0];
    if (!row) return null;
    if (isSupportedOpList(row.inverse_ops)) return row;
    await sql`
      UPDATE data.base_changes SET undo_skipped = true
      WHERE base_id = ${baseId} AND seq = ${row.seq}
    `.execute(db);
  }
  return null;
}

async function findRedoCandidate(
  db: AppContext["db"],
  baseId: string,
  userId: string,
): Promise<ChangeRow | null> {
  // A new edit after undoing clears the redo stack.
  const lastEdit = await lastUndoableSeq(db, baseId, userId);
  const r = await sql<ChangeRow>`
    SELECT seq, kind, ops, inverse_ops, table_ids
    FROM data.base_changes
    WHERE base_id = ${baseId} AND actor_id = ${userId}
      AND undone_by_seq IS NOT NULL
      AND undone_by_seq > ${lastEdit}
      AND NOT undo_skipped
    ORDER BY undone_by_seq DESC
    LIMIT 1
  `.execute(db);
  const row = r.rows[0];
  if (!row || !isSupportedOpList(row.ops)) return null;
  return row;
}

function toPublicTableIds(ids: Iterable<string>): string[] {
  return [...ids].map((id) => pid("tbl", id));
}

export async function registerHistoryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/undo-state",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }
        const undo = await findUndoCandidate(ctx.db, baseId, user.id);
        const redo = await findRedoCandidate(ctx.db, baseId, user.id);
        void reply.send({
          canUndo: Boolean(undo),
          canRedo: Boolean(redo),
          undoLabel: undo ? describeOps(undo.ops) : null,
          redoLabel: redo ? describeOps(redo.ops) : null,
        });
      } catch (err) {
        if (err instanceof StackRaceError) {
          sendStackProblem(request, reply, request.url.endsWith("/redo") ? "NOTHING_TO_REDO" : "NOTHING_TO_UNDO");
          return;
        }
        if (err instanceof NothingToRestoreError) {
          notFound(request, reply, "Nothing to restore (already restored or not found)");
          return;
        }
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/undo",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }
        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "record.update");

        const change = await findUndoCandidate(ctx.db, baseId, user.id);
        if (!change) {
          sendStackProblem(request, reply, "NOTHING_TO_UNDO");
          return;
        }

        let applied: ApplyResult | null = null;
        let raced = false;
        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: actor(user, "undo"),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            // Claim the change (guards against double-clicks / two tabs).
            const claim = await sql<{ seq: string }>`
              UPDATE data.base_changes SET undone_by_seq = ${mctx.changeSeq}
              WHERE base_id = ${baseId} AND seq = ${change.seq} AND undone_by_seq IS NULL
              RETURNING seq
            `.execute(trx);
            if (claim.rows.length === 0) {
              raced = true;
              throw new StackRaceError();
            }
            applied = await applyHistoryOpsInTx(
                  trx,
                  {
                    baseId,
                    workspaceId: base.workspaceId,
                    userId: user.id,
                    changeSeq: mctx.changeSeq,
                    redis: ctx.redis,
                    tableIdsHint: change.table_ids ?? [],
                  },
                  change.inverse_ops as HistoryOp[],
                  (Array.isArray(change.ops) ? change.ops : []) as HistoryOp[],
                );
            const ops = applied.appliedOps.length
              ? applied.appliedOps
              : [{ op: "change.undone", seq: Number(change.seq) }];
            return {
              kind: "undo" as const,
              ops,
              inverseOps: null,
              tableIds: [...new Set([...(change.table_ids ?? []), ...applied.tableIds])],
              eventType: "change.undone",
              aggregateType: "base",
              aggregateId: baseId,
              payload: { undoneSeq: Number(change.seq) },
            };
          },
        );
        if (raced) {
          sendStackProblem(request, reply, "NOTHING_TO_UNDO");
          return;
        }
        const result = applied as ApplyResult | null;
        void reply.send({
          changeSeq: seq,
          undoneSeq: Number(change.seq),
          description: describeOps(change.ops),
          tableIds: toPublicTableIds(result?.tableIds ?? []),
        });
      } catch (err) {
        if (err instanceof StackRaceError) {
          sendStackProblem(request, reply, request.url.endsWith("/redo") ? "NOTHING_TO_REDO" : "NOTHING_TO_UNDO");
          return;
        }
        if (err instanceof NothingToRestoreError) {
          notFound(request, reply, "Nothing to restore (already restored or not found)");
          return;
        }
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/redo",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }
        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "record.update");

        const change = await findRedoCandidate(ctx.db, baseId, user.id);
        if (!change) {
          sendStackProblem(request, reply, "NOTHING_TO_REDO");
          return;
        }

        let applied: ApplyResult | null = null;
        let raced = false;
        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: actor(user, "redo"),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            const claim = await sql<{ seq: string }>`
              UPDATE data.base_changes SET undone_by_seq = NULL
              WHERE base_id = ${baseId} AND seq = ${change.seq} AND undone_by_seq IS NOT NULL
              RETURNING seq
            `.execute(trx);
            if (claim.rows.length === 0) {
              raced = true;
              throw new StackRaceError();
            }
            applied = await applyHistoryOpsInTx(
                  trx,
                  {
                    baseId,
                    workspaceId: base.workspaceId,
                    userId: user.id,
                    changeSeq: mctx.changeSeq,
                    redis: ctx.redis,
                    tableIdsHint: change.table_ids ?? [],
                  },
                  change.ops as HistoryOp[],
                  (Array.isArray(change.inverse_ops) ? change.inverse_ops : []) as HistoryOp[],
                );
            const ops = applied.appliedOps.length
              ? applied.appliedOps
              : [{ op: "change.redone", seq: Number(change.seq) }];
            return {
              kind: "redo" as const,
              ops,
              inverseOps: null,
              tableIds: [...new Set([...(change.table_ids ?? []), ...applied.tableIds])],
              eventType: "change.redone",
              aggregateType: "base",
              aggregateId: baseId,
              payload: { redoneSeq: Number(change.seq) },
            };
          },
        );
        if (raced) {
          sendStackProblem(request, reply, "NOTHING_TO_REDO");
          return;
        }
        const result = applied as ApplyResult | null;
        void reply.send({
          changeSeq: seq,
          redoneSeq: Number(change.seq),
          description: describeOps(change.ops),
          tableIds: toPublicTableIds(result?.tableIds ?? []),
        });
      } catch (err) {
        if (err instanceof StackRaceError) {
          sendStackProblem(request, reply, request.url.endsWith("/redo") ? "NOTHING_TO_REDO" : "NOTHING_TO_UNDO");
          return;
        }
        if (err instanceof NothingToRestoreError) {
          notFound(request, reply, "Nothing to restore (already restored or not found)");
          return;
        }
        handleRouteError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/trash",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }
        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "base.read");

        const records = await sql<{
          id: string;
          table_id: string;
          table_name: string;
          primary_slot: number | null;
          cells: unknown;
          deleted_at: Date;
          deleted_by: string | null;
          deleted_by_name: string | null;
          deletion_batch_id: string | null;
        }>`
          SELECT r.id, r.table_id, t.name AS table_name, pf.slot AS primary_slot,
                 r.cells, r.deleted_at, r.deleted_by,
                 COALESCE(NULLIF(u.display_name, ''), u.email) AS deleted_by_name,
                 r.deletion_batch_id
          FROM data.records r
          JOIN data.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
          LEFT JOIN data.fields pf ON pf.id = t.primary_field_id
          LEFT JOIN core.users u ON u.id = r.deleted_by
          WHERE r.base_id = ${baseId} AND r.deleted_at IS NOT NULL
            AND r.deleted_at > now() - interval '30 days'
          ORDER BY r.deleted_at DESC
          LIMIT 200
        `.execute(ctx.db);

        const tables = await sql<{
          id: string;
          name: string;
          deleted_at: Date;
          deleted_by_name: string | null;
        }>`
          SELECT t.id, t.name, t.deleted_at,
                 COALESCE(NULLIF(u.display_name, ''), u.email) AS deleted_by_name
          FROM data.tables t
          LEFT JOIN core.users u ON u.id = t.deleted_by
          WHERE t.base_id = ${baseId} AND t.deleted_at IS NOT NULL
            AND t.deleted_at > now() - interval '30 days'
          ORDER BY t.deleted_at DESC
          LIMIT 100
        `.execute(ctx.db);

        const fields = await sql<{
          id: string;
          name: string;
          type: string;
          table_id: string;
          table_name: string;
          deleted_at: Date;
          deleted_by_name: string | null;
        }>`
          SELECT f.id, f.name, f.type, f.table_id, t.name AS table_name, f.deleted_at,
                 COALESCE(NULLIF(u.display_name, ''), u.email) AS deleted_by_name
          FROM data.fields f
          JOIN data.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
          LEFT JOIN core.users u ON u.id = f.deleted_by
          WHERE f.base_id = ${baseId} AND f.deleted_at IS NOT NULL
            AND f.deleted_at > now() - interval '30 days'
          ORDER BY f.deleted_at DESC
          LIMIT 100
        `.execute(ctx.db);

        const label = (cells: unknown, slot: number | null): string => {
          if (slot === null || !cells || typeof cells !== "object") return "";
          const v = (cells as Record<string, unknown>)[String(slot)];
          if (v === null || v === undefined) return "";
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            return String(v);
          }
          return JSON.stringify(v).slice(0, 80);
        };

        void reply.send({
          records: records.rows.map((r) => ({
            id: pid("rec", r.id),
            tableId: pid("tbl", r.table_id),
            tableName: r.table_name,
            name: label(r.cells, r.primary_slot) || "Unnamed record",
            deletedAt: new Date(r.deleted_at).toISOString(),
            deletedBy: r.deleted_by ? pid("usr", r.deleted_by) : null,
            deletedByName: r.deleted_by_name,
            deletionBatchId: r.deletion_batch_id,
          })),
          tables: tables.rows.map((t) => ({
            id: pid("tbl", t.id),
            name: t.name,
            deletedAt: new Date(t.deleted_at).toISOString(),
            deletedByName: t.deleted_by_name,
          })),
          fields: fields.rows.map((f) => ({
            id: pid("fld", f.id),
            name: f.name,
            type: f.type,
            tableId: pid("tbl", f.table_id),
            tableName: f.table_name,
            deletedAt: new Date(f.deleted_at).toISOString(),
            deletedByName: f.deleted_by_name,
          })),
        });
      } catch (err) {
        if (err instanceof StackRaceError) {
          sendStackProblem(request, reply, request.url.endsWith("/redo") ? "NOTHING_TO_REDO" : "NOTHING_TO_UNDO");
          return;
        }
        if (err instanceof NothingToRestoreError) {
          notFound(request, reply, "Nothing to restore (already restored or not found)");
          return;
        }
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/trash/restore",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const body = restoreBody.parse(request.body ?? {});

        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(
          snapshot,
          body.tableId || body.fieldId ? "base.manage_schema" : "record.update",
        );

        const recordId = body.recordId ? parsePid(body.recordId, "rec") : null;
        const tableId = body.tableId ? parsePid(body.tableId, "tbl") : null;
        const fieldId = body.fieldId ? parsePid(body.fieldId, "fld") : null;

        let restored: ApplyResult = { tableIds: new Set(), appliedOps: [] };
        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: actor(user, "restore"),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            const applyCtx = {
              baseId,
              workspaceId: base.workspaceId,
              userId: user.id,
              changeSeq: mctx.changeSeq,
              redis: ctx.redis,
              tableIdsHint: [],
            };
            if (body.deletionBatchId) {
              await restoreBatchInTx(trx, applyCtx, body.deletionBatchId, restored);
            }
            if (recordId) await restoreRecordInTx(trx, applyCtx, recordId, restored);
            if (tableId) await setTableDeletedInTx(trx, applyCtx, tableId, false, restored);
            if (fieldId) await setFieldDeletedInTx(trx, applyCtx, fieldId, false, restored);
            if (restored.appliedOps.length === 0) throw new NothingToRestoreError();
            const ops = restored.appliedOps;
            return {
              kind: "restore" as const,
              ops,
              tableIds: [...restored.tableIds],
              eventType: "trash.restored",
              aggregateType: "base",
              aggregateId: baseId,
              payload: {
                ...(body.deletionBatchId ? { deletionBatchId: body.deletionBatchId } : {}),
                ...(recordId ? { recordId } : {}),
                ...(tableId ? { tableId } : {}),
                ...(fieldId ? { fieldId } : {}),
              },
            };
          },
        );

        restored = restored as ApplyResult;
        void reply.send({
          changeSeq: seq,
          restored: restored.appliedOps.length,
          tableIds: toPublicTableIds(restored.tableIds),
        });
      } catch (err) {
        if (err instanceof StackRaceError) {
          sendStackProblem(request, reply, request.url.endsWith("/redo") ? "NOTHING_TO_REDO" : "NOTHING_TO_UNDO");
          return;
        }
        if (err instanceof NothingToRestoreError) {
          notFound(request, reply, "Nothing to restore (already restored or not found)");
          return;
        }
        handleRouteError(request, reply, err);
      }
    },
  );
}
