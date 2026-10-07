/**
 * Record write endpoints (CONTRACTS §3, workstream B). Reads live in the
 * query module (A). Every response returns full records in the wire format.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { ApiError, handleRouteError, notFound } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { withBaseTx, type MutationActor, type BaseMutationContext } from "../../kernel/mutation.js";
import { LimitsService } from "../billing/limits-service.js";
import { serializeRecordsByIds } from "./serialize.js";
import {
  MAX_BATCH,
  TableWriter,
  computeOps,
  createRecordsInTx,
  deleteRecordsInTx,
  duplicateRecordInTx,
  moveRecordInTx,
  touchedTableIds,
  updateRecordsInTx,
  type WriteContext,
} from "./write.js";

const fieldsSchema = z.record(z.unknown());

const createBody = z.object({
  fields: fieldsSchema.default({}),
  typecast: z.boolean().optional(),
});

const batchCreateBody = z.object({
  records: z
    .array(z.object({ id: z.string().optional(), fields: fieldsSchema.default({}) }))
    .min(1, "At least one record is required")
    .max(MAX_BATCH, `At most ${MAX_BATCH} records per request`),
  typecast: z.boolean().optional(),
  atomic: z.boolean().optional(),
});

const patchBody = z.object({
  fields: fieldsSchema,
  typecast: z.boolean().optional(),
  version: z.number().int().positive().optional(),
});

const batchPatchBody = z.object({
  records: z
    .array(
      z.object({
        id: z.string(),
        fields: fieldsSchema,
        version: z.number().int().positive().optional(),
      }),
    )
    .min(1, "At least one record is required")
    .max(MAX_BATCH, `At most ${MAX_BATCH} records per request`),
  typecast: z.boolean().optional(),
});

const batchDeleteBody = z.object({
  ids: z
    .array(z.string())
    .min(1, "At least one record id is required")
    .max(MAX_BATCH, `At most ${MAX_BATCH} records per request`),
});

const moveBody = z.object({
  before: z.string().nullish(),
  after: z.string().nullish(),
});

function actor(user: NonNullable<FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

type TableCtx = { orgId: string; workspaceId: string; tableName: string };

async function resolve(
  ctx: AppContext,
  request: FastifyRequest<{ Params: { baseId: string; tableId: string } }>,
  reply: FastifyReply,
  action: "record.create" | "record.update" | "record.delete",
): Promise<{ baseId: string; tableId: string; userId: string; table: TableCtx; user: NonNullable<FastifyRequest["user"]> } | null> {
  const user = request.user;
  if (!user) {
    notFound(request, reply);
    return null;
  }
  const baseId = parsePid(request.params.baseId, "bas");
  const tableId = parsePid(request.params.tableId, "tbl");
  const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
  if (!table.ok) {
    notFound(request, reply, "Table not found");
    return null;
  }
  const snapshot = await compileForUser(ctx.db, user.id, baseId);
  assertCan(snapshot, action);
  return { baseId, tableId, userId: user.id, table, user };
}

function writeCtx(
  ctx: AppContext,
  mctx: BaseMutationContext,
  trx: WriteContext["trx"],
  baseId: string,
  workspaceId: string,
  userId: string,
): WriteContext {
  return {
    trx,
    baseId,
    workspaceId,
    changeSeq: mctx.changeSeq,
    userId,
    via: "api",
    redis: ctx.redis,
    afterCommit: mctx.afterCommit,
  };
}

function recordUuid(raw: string): string {
  return parsePid(raw, "rec");
}

export async function registerRecordsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limits = new LimitsService(ctx.db);
  const serialize = (tableId: string, ids: string[]) =>
    serializeRecordsByIds(ctx.db, tableId, ids, { storage: ctx.storage });

  // ---- create ----
  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records",
    async (request, reply) => {
      try {
        const r = await resolve(ctx, request, reply, "record.create");
        if (!r) return;
        const body = createBody.parse(request.body ?? {});
        await limits.assertCanCreateRecord(r.table.orgId, r.baseId, 1);
        let ids: string[] = [];
        await withBaseTx(
          ctx.db,
          { orgId: r.table.orgId, workspaceId: r.table.workspaceId, baseId: r.baseId, actor: actor(r.user), redis: ctx.redis },
          async (mctx, trx) => {
            const res = await createRecordsInTx(
              writeCtx(ctx, mctx, trx, r.baseId, r.table.workspaceId, r.userId),
              r.tableId,
              [{ fields: body.fields }],
              { ...(body.typecast !== undefined ? { typecast: body.typecast } : {}) },
            );
            ids = res.ids;
            return {
              kind: "records" as const,
              ops: [
                { op: "record.created", tableId: r.tableId, recordId: ids[0] },
                ...res.configChangedFieldIds.map((fieldId) => ({ op: "field.updated", tableId: r.tableId, fieldId })),
                ...computeOps(res.compute),
              ],
              inverseOps: [{ op: "record.deleted", tableId: r.tableId, recordId: ids[0] }],
              tableIds: touchedTableIds(r.tableId, res.compute),
              eventType: "record.created",
              aggregateType: "record",
              aggregateId: ids[0]!,
              payload: { tableId: r.tableId, recordId: ids[0] },
            };
          },
        );
        const [record] = await serialize(r.tableId, ids);
        void reply.code(201).send({ record });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // ---- batch create ----
  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/batch",
    async (request, reply) => {
      try {
        const r = await resolve(ctx, request, reply, "record.create");
        if (!r) return;
        const body = batchCreateBody.parse(request.body ?? {});
        await limits.assertCanCreateRecord(r.table.orgId, r.baseId, body.records.length);
        let ids: string[] = [];
        await withBaseTx(
          ctx.db,
          { orgId: r.table.orgId, workspaceId: r.table.workspaceId, baseId: r.baseId, actor: actor(r.user), redis: ctx.redis },
          async (mctx, trx) => {
            const res = await createRecordsInTx(
              writeCtx(ctx, mctx, trx, r.baseId, r.table.workspaceId, r.userId),
              r.tableId,
              body.records.map((x) => ({ fields: x.fields, ...(x.id ? { id: x.id } : {}) })),
              { ...(body.typecast !== undefined ? { typecast: body.typecast } : {}) },
            );
            ids = res.ids;
            return {
              kind: "bulk" as const,
              ops: [
                { op: "records.created", tableId: r.tableId, recordIds: ids },
                ...res.configChangedFieldIds.map((fieldId) => ({ op: "field.updated", tableId: r.tableId, fieldId })),
                ...computeOps(res.compute),
              ],
              inverseOps: ids.map((recordId) => ({ op: "record.deleted", tableId: r.tableId, recordId })),
              tableIds: touchedTableIds(r.tableId, res.compute),
              eventType: "records.batch_created",
              aggregateType: "table",
              aggregateId: r.tableId,
              payload: { tableId: r.tableId, recordIds: ids, count: ids.length },
            };
          },
        );
        const records = await serialize(r.tableId, ids);
        void reply.code(201).send({ records });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // ---- batch patch ----
  app.patch<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/batch",
    async (request, reply) => {
      try {
        const r = await resolve(ctx, request, reply, "record.update");
        if (!r) return;
        const body = batchPatchBody.parse(request.body ?? {});
        const items = body.records.map((x) => ({
          id: recordUuid(x.id),
          fields: x.fields,
          ...(x.version !== undefined ? { expectedVersion: x.version } : {}),
        }));
        await withBaseTx(
          ctx.db,
          { orgId: r.table.orgId, workspaceId: r.table.workspaceId, baseId: r.baseId, actor: actor(r.user), redis: ctx.redis },
          async (mctx, trx) => {
            const res = await updateRecordsInTx(
              writeCtx(ctx, mctx, trx, r.baseId, r.table.workspaceId, r.userId),
              r.tableId,
              items,
              { ...(body.typecast !== undefined ? { typecast: body.typecast } : {}) },
            );
            return {
              kind: "bulk" as const,
              ops: [
                ...items.map((it) => ({ op: "record.updated", tableId: r.tableId, recordId: it.id, cells: res.after.get(it.id) })),
                ...res.configChangedFieldIds.map((fieldId) => ({ op: "field.updated", tableId: r.tableId, fieldId })),
                ...computeOps(res.compute),
              ],
              inverseOps: items.map((it) => ({
                op: "record.updated",
                tableId: r.tableId,
                recordId: it.id,
                cells: res.before.get(it.id),
              })),
              tableIds: touchedTableIds(r.tableId, res.compute),
              eventType: "records.batch_updated",
              aggregateType: "table",
              aggregateId: r.tableId,
              payload: { tableId: r.tableId, recordIds: items.map((i) => i.id) },
            };
          },
        );
        const records = await serialize(r.tableId, items.map((i) => i.id));
        void reply.send({ records });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // ---- batch delete ----
  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/batch-delete",
    async (request, reply) => {
      try {
        const r = await resolve(ctx, request, reply, "record.delete");
        if (!r) return;
        const body = batchDeleteBody.parse(request.body ?? {});
        const ids = body.ids.map(recordUuid);
        await withBaseTx(
          ctx.db,
          { orgId: r.table.orgId, workspaceId: r.table.workspaceId, baseId: r.baseId, actor: actor(r.user), redis: ctx.redis },
          async (mctx, trx) => {
            const res = await deleteRecordsInTx(
              writeCtx(ctx, mctx, trx, r.baseId, r.table.workspaceId, r.userId),
              r.tableId,
              ids,
            );
            return {
              kind: "bulk" as const,
              ops: [
                { op: "records.soft_deleted", tableId: r.tableId, recordIds: res.ids, batchId: res.batchId },
                ...computeOps(res.compute),
              ],
              inverseOps: [{ op: "record.restore", batchId: res.batchId }],
              tableIds: touchedTableIds(r.tableId, res.compute),
              eventType: "records.batch_deleted",
              aggregateType: "table",
              aggregateId: r.tableId,
              payload: { tableId: r.tableId, recordIds: res.ids, batchId: res.batchId },
            };
          },
        );
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // ---- patch one ----
  app.patch<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId",
    async (request, reply) => {
      try {
        const r = await resolve(ctx, request, reply, "record.update");
        if (!r) return;
        const recordId = recordUuid(request.params.recordId);
        const body = patchBody.parse(request.body ?? {});
        const ifMatch = request.headers["if-match"];
        let expectedVersion = body.version;
        if (typeof ifMatch === "string" && ifMatch.trim() !== "" && ifMatch.trim() !== "*") {
          const n = Number(ifMatch.replace(/^W\//, "").replace(/"/g, ""));
          if (!Number.isInteger(n) || n < 1) throw new ApiError(422, "VALIDATION_FAILED", "Invalid If-Match header");
          expectedVersion = n;
        }
        await withBaseTx(
          ctx.db,
          { orgId: r.table.orgId, workspaceId: r.table.workspaceId, baseId: r.baseId, actor: actor(r.user), redis: ctx.redis },
          async (mctx, trx) => {
            const writer = await TableWriter.load(trx, r.tableId);
            const res = await updateRecordsInTx(
              writeCtx(ctx, mctx, trx, r.baseId, r.table.workspaceId, r.userId),
              r.tableId,
              [{ id: recordId, fields: body.fields, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }],
              { writer, ...(body.typecast !== undefined ? { typecast: body.typecast } : {}) },
            );
            const version = res.versions.get(recordId);
            return {
              kind: "records" as const,
              ops: [
                { op: "record.updated", tableId: r.tableId, recordId, cells: res.after.get(recordId) },
                ...res.configChangedFieldIds.map((fieldId) => ({ op: "field.updated", tableId: r.tableId, fieldId })),
                ...computeOps(res.compute),
              ],
              inverseOps: [{ op: "record.updated", tableId: r.tableId, recordId, cells: res.before.get(recordId) }],
              tableIds: touchedTableIds(r.tableId, res.compute),
              eventType: "record.updated",
              aggregateType: "record",
              aggregateId: recordId,
              payload: { tableId: r.tableId, recordId, version },
            };
          },
        );
        const [record] = await serialize(r.tableId, [recordId]);
        if (record) void reply.header("etag", `"${record.version}"`);
        void reply.send({ record });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // ---- delete one ----
  app.delete<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId",
    async (request, reply) => {
      try {
        const r = await resolve(ctx, request, reply, "record.delete");
        if (!r) return;
        const recordId = recordUuid(request.params.recordId);
        await withBaseTx(
          ctx.db,
          { orgId: r.table.orgId, workspaceId: r.table.workspaceId, baseId: r.baseId, actor: actor(r.user), redis: ctx.redis },
          async (mctx, trx) => {
            const res = await deleteRecordsInTx(
              writeCtx(ctx, mctx, trx, r.baseId, r.table.workspaceId, r.userId),
              r.tableId,
              [recordId],
            );
            return {
              kind: "records" as const,
              ops: [
                { op: "record.soft_deleted", tableId: r.tableId, recordId, batchId: res.batchId },
                ...computeOps(res.compute),
              ],
              inverseOps: [{ op: "record.restore", batchId: res.batchId }],
              tableIds: touchedTableIds(r.tableId, res.compute),
              eventType: "record.deleted",
              aggregateType: "record",
              aggregateId: recordId,
              payload: { tableId: r.tableId, recordId, batchId: res.batchId },
            };
          },
        );
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // ---- duplicate ----
  app.post<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/duplicate",
    async (request, reply) => {
      try {
        const r = await resolve(ctx, request, reply, "record.create");
        if (!r) return;
        const sourceId = recordUuid(request.params.recordId);
        await limits.assertCanCreateRecord(r.table.orgId, r.baseId, 1);
        let newId = "";
        await withBaseTx(
          ctx.db,
          { orgId: r.table.orgId, workspaceId: r.table.workspaceId, baseId: r.baseId, actor: actor(r.user), redis: ctx.redis },
          async (mctx, trx) => {
            const res = await duplicateRecordInTx(
              writeCtx(ctx, mctx, trx, r.baseId, r.table.workspaceId, r.userId),
              r.tableId,
              sourceId,
            );
            newId = res.ids[0]!;
            return {
              kind: "records" as const,
              ops: [
                { op: "record.created", tableId: r.tableId, recordId: newId, duplicatedFrom: sourceId },
                ...computeOps(res.compute),
              ],
              inverseOps: [{ op: "record.deleted", tableId: r.tableId, recordId: newId }],
              tableIds: touchedTableIds(r.tableId, res.compute),
              eventType: "record.created",
              aggregateType: "record",
              aggregateId: newId,
              payload: { tableId: r.tableId, recordId: newId, duplicatedFrom: pid("rec", sourceId) },
            };
          },
        );
        const [record] = await serialize(r.tableId, [newId]);
        void reply.code(201).send({ record });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // ---- move (manual order) ----
  app.post<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/move",
    async (request, reply) => {
      try {
        const r = await resolve(ctx, request, reply, "record.update");
        if (!r) return;
        const recordId = recordUuid(request.params.recordId);
        const body = moveBody.parse(request.body ?? {});
        const beforeId = body.before ? recordUuid(body.before) : null;
        const afterId = body.after ? recordUuid(body.after) : null;
        await withBaseTx(
          ctx.db,
          { orgId: r.table.orgId, workspaceId: r.table.workspaceId, baseId: r.baseId, actor: actor(r.user), redis: ctx.redis },
          async (mctx, trx) => {
            const old = await sql<{ manual_order: string }>`
              SELECT manual_order FROM data.records WHERE table_id = ${r.tableId} AND id = ${recordId}
            `.execute(trx);
            const key = await moveRecordInTx(
              writeCtx(ctx, mctx, trx, r.baseId, r.table.workspaceId, r.userId),
              r.tableId,
              recordId,
              { beforeId, afterId },
            );
            const oldKey = old.rows[0]?.manual_order;
            return {
              kind: "records" as const,
              ops: [{ op: "record.moved", tableId: r.tableId, recordId, manualOrder: key }],
              inverseOps: oldKey ? [{ op: "record.moved", tableId: r.tableId, recordId, manualOrder: oldKey }] : null,
              tableIds: [r.tableId],
              eventType: "record.moved",
              aggregateType: "record",
              aggregateId: recordId,
              payload: { tableId: r.tableId, recordId },
            };
          },
        );
        const [record] = await serialize(r.tableId, [recordId]);
        void reply.send({ record });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
