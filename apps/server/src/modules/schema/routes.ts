/**
 * Tables + fields schema endpoints (CONTRACTS §4, workstream B).
 */
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { ApiError, handleRouteError, notFound } from "../../http/errors.js";
import { resolveBaseContext, resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { withBaseTx, type BaseMutationContext, type MutationActor } from "../../kernel/mutation.js";
import { bootstrapDefaultTable } from "../base/bootstrap-default-table.js";
import { LimitsService } from "../billing/limits-service.js";
import { fieldRowToDto, loadFieldNameMap, type FieldDto } from "./field-dto.js";
import {
  createFieldInTx,
  deleteFieldInTx,
  duplicateFieldInTx,
  reorderFieldsInTx,
  setPrimaryFieldInTx,
  updateFieldInTx,
  type SchemaOpContext,
} from "./field-ops.js";
import { deleteTableInTx, duplicateTableInTx, reorderTablesInTx } from "./table-ops.js";
import { loadFieldRow, loadTableFieldRows, loadTableRow, type Db } from "./table-schema.js";

const tableBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
});

const tablePatchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).nullable().optional(),
});

const fieldBody = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  description: z.string().max(20_000).nullable().optional(),
  inverseName: z.string().trim().min(1).max(255).optional(),
});

const fieldPatchBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(20_000).nullable().optional(),
  config: z.record(z.unknown()).optional(),
  type: z.string().min(1).optional(),
});

function actor(user: NonNullable<FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

function opCtx(
  ctx: AppContext,
  mctx: BaseMutationContext,
  trx: SchemaOpContext["trx"],
  workspaceId: string,
  userId: string,
): SchemaOpContext {
  return {
    trx,
    baseId: mctx.baseId,
    workspaceId,
    userId,
    redis: ctx.redis,
    afterCommit: mctx.afterCommit,
  };
}

export async function serializeField(db: Db, baseId: string, tableId: string, fieldId: string): Promise<FieldDto | null> {
  const row = await loadFieldRow(db, tableId, fieldId);
  if (!row) return null;
  const table = await loadTableRow(db, tableId);
  const names = await loadFieldNameMap(db, baseId);
  return fieldRowToDto(row, { primaryFieldId: table?.primaryFieldId ?? null, nameById: names });
}

export async function serializeTableFields(db: Db, baseId: string, tableId: string): Promise<FieldDto[]> {
  const table = await loadTableRow(db, tableId);
  const rows = await loadTableFieldRows(db, tableId);
  const names = await loadFieldNameMap(db, baseId);
  return rows.map((r) => fieldRowToDto(r, { primaryFieldId: table?.primaryFieldId ?? null, nameById: names }));
}

async function tableDto(db: Db, baseId: string, tableId: string): Promise<Record<string, unknown> | null> {
  const t = await loadTableRow(db, tableId);
  if (!t) return null;
  const views = await sql<{ id: string; name: string; type: string }>`
    SELECT id, name, type FROM data.views WHERE table_id = ${tableId} AND deleted_at IS NULL ORDER BY order_key
  `.execute(db as never);
  return {
    id: pid("tbl", t.id),
    name: t.name,
    description: t.description || null,
    primaryFieldId: t.primaryFieldId ? pid("fld", t.primaryFieldId) : null,
    recordCount: t.recordCount,
    fields: await serializeTableFields(db, baseId, tableId),
    views: views.rows.map((v) => ({ id: pid("viw", v.id), name: v.name, type: v.type })),
  };
}

export async function registerSchemaRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limits = new LimitsService(ctx.db);

  async function baseScope(
    request: FastifyRequest<{ Params: { baseId: string } }>,
    reply: FastifyReply,
    manage: boolean,
  ) {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return null;
    }
    const baseId = parsePid(request.params.baseId, "bas");
    const base = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!base.ok) {
      notFound(request, reply, "Base not found");
      return null;
    }
    const snapshot = await compileForUser(ctx.db, user.id, baseId);
    assertCan(snapshot, manage ? "base.manage_schema" : "base.read");
    return { user, baseId, orgId: base.orgId, workspaceId: base.workspaceId };
  }

  async function tableScope(
    request: FastifyRequest<{ Params: { baseId: string; tableId: string } }>,
    reply: FastifyReply,
    manage: boolean,
  ) {
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
    assertCan(snapshot, manage ? "base.manage_schema" : "base.read");
    return { user, baseId, tableId, orgId: table.orgId, workspaceId: table.workspaceId, tableName: table.tableName };
  }

  const txParams = (s: { orgId: string; workspaceId: string; baseId: string; user: NonNullable<FastifyRequest["user"]> }) => ({
    orgId: s.orgId,
    workspaceId: s.workspaceId,
    baseId: s.baseId,
    actor: actor(s.user),
    redis: ctx.redis,
  });

  // ------------------------------------------------------------------ tables

  app.get<{ Params: { baseId: string } }>("/v1/bases/:baseId/tables", async (request, reply) => {
    try {
      const s = await baseScope(request, reply, false);
      if (!s) return;
      const result = await sql<{ id: string }>`
        SELECT id FROM data.tables WHERE base_id = ${s.baseId} AND deleted_at IS NULL ORDER BY order_key ASC
      `.execute(ctx.db);
      const tables = [];
      for (const r of result.rows) tables.push(await tableDto(ctx.db, s.baseId, r.id));
      void reply.send({ tables });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post<{ Params: { baseId: string } }>("/v1/bases/:baseId/tables", async (request, reply) => {
    try {
      const s = await baseScope(request, reply, true);
      if (!s) return;
      const body = tableBody.parse(request.body ?? {});
      const plan = await limits.getOrgPlan(s.orgId);
      const maxTables = plan.limits.tablesPerBase;
      const count = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM data.tables WHERE base_id = ${s.baseId} AND deleted_at IS NULL
      `.execute(ctx.db);
      const current = Number(count.rows[0]?.n ?? 0);
      if (typeof maxTables === "number" && current + 1 > maxTables) {
        throw new ApiError(402, "PLAN_LIMIT_EXCEEDED", `Table limit for this base is ${maxTables} on the ${plan.planName} plan`, {
          metric: "tablesPerBase",
          limit: maxTables,
          current,
          plan: plan.planCode,
        });
      }
      const dupe = await sql<{ id: string }>`
        SELECT id FROM data.tables WHERE base_id = ${s.baseId} AND deleted_at IS NULL AND lower(name) = lower(${body.name})
      `.execute(ctx.db);
      if (dupe.rows.length) throw new ApiError(409, "CONFLICT", `A table named "${body.name}" already exists`);

      let createdTableId = "";
      await withBaseTx(ctx.db, txParams(s), async (_mctx, trx) => {
        const boot = await bootstrapDefaultTable(trx, {
          workspaceId: s.workspaceId,
          baseId: s.baseId,
          userId: s.user.id,
          tableName: body.name,
        });
        createdTableId = boot.tableId;
        if (body.description) {
          await sql`UPDATE data.tables SET description = ${body.description} WHERE id = ${boot.tableId}`.execute(trx);
        }
        return {
          kind: "schema" as const,
          ops: [{ op: "table.created", tableId: boot.tableId, name: body.name }],
          inverseOps: [{ op: "table.deleted", tableId: boot.tableId }],
          tableIds: [boot.tableId],
          eventType: "table.created",
          aggregateType: "table",
          aggregateId: boot.tableId,
          payload: { tableId: boot.tableId, name: body.name },
        };
      });
      void reply.code(201).send({ table: await tableDto(ctx.db, s.baseId, createdTableId) });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post<{ Params: { baseId: string } }>("/v1/bases/:baseId/tables/reorder", async (request, reply) => {
    try {
      const s = await baseScope(request, reply, true);
      if (!s) return;
      const body = z.object({ tableIds: z.array(z.string()).min(1) }).parse(request.body ?? {});
      const ids = body.tableIds.map((t) => parsePid(t, "tbl"));
      await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
        await reorderTablesInTx(opCtx(ctx, mctx, trx, s.workspaceId, s.user.id), ids);
        return {
          kind: "schema" as const,
          ops: [{ op: "tables.reordered", tableIds: ids }],
          tableIds: ids,
          eventType: "tables.reordered",
          aggregateType: "base",
          aggregateId: s.baseId,
          payload: { tableIds: ids },
        };
      });
      void reply.code(204).send();
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.patch<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        const body = tablePatchBody.parse(request.body ?? {});
        if (body.name && body.name.toLowerCase() !== s.tableName.toLowerCase()) {
          const dupe = await sql<{ id: string }>`
            SELECT id FROM data.tables WHERE base_id = ${s.baseId} AND deleted_at IS NULL
              AND lower(name) = lower(${body.name}) AND id <> ${s.tableId}
          `.execute(ctx.db);
          if (dupe.rows.length) throw new ApiError(409, "CONFLICT", `A table named "${body.name}" already exists`);
        }
        if (body.name !== undefined || body.description !== undefined) {
          await withBaseTx(ctx.db, txParams(s), async (_mctx, trx) => {
            if (body.name !== undefined) {
              await sql`
                UPDATE data.tables SET name = ${body.name}, updated_by = ${s.user.id}, updated_at = now()
                WHERE id = ${s.tableId}
              `.execute(trx);
            }
            if (body.description !== undefined) {
              await sql`
                UPDATE data.tables SET description = ${body.description ?? ""}, updated_at = now() WHERE id = ${s.tableId}
              `.execute(trx);
            }
            return {
              kind: "schema" as const,
              ops: [{ op: "table.renamed", tableId: s.tableId, name: body.name ?? s.tableName }],
              inverseOps: [{ op: "table.renamed", tableId: s.tableId, name: s.tableName }],
              tableIds: [s.tableId],
              eventType: "table.updated",
              aggregateType: "table",
              aggregateId: s.tableId,
              payload: { tableId: s.tableId, ...body },
            };
          });
        }
        void reply.send({ table: await tableDto(ctx.db, s.baseId, s.tableId) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
          const touched = await deleteTableInTx(opCtx(ctx, mctx, trx, s.workspaceId, s.user.id), s.tableId);
          return {
            kind: "schema" as const,
            ops: [{ op: "table.soft_deleted", tableId: s.tableId }],
            inverseOps: [{ op: "table.restored", tableId: s.tableId }],
            tableIds: [s.tableId, ...touched],
            eventType: "table.deleted",
            aggregateType: "table",
            aggregateId: s.tableId,
            payload: { tableId: s.tableId },
          };
        });
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/duplicate",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        const body = z
          .object({ withRecords: z.boolean().optional(), name: z.string().trim().min(1).max(200).optional() })
          .parse(request.body ?? {});
        const plan = await limits.getOrgPlan(s.orgId);
        const maxTables = plan.limits.tablesPerBase;
        if (typeof maxTables === "number") {
          const c = await sql<{ n: string }>`
            SELECT count(*)::text AS n FROM data.tables WHERE base_id = ${s.baseId} AND deleted_at IS NULL
          `.execute(ctx.db);
          if (Number(c.rows[0]?.n ?? 0) + 1 > maxTables) {
            throw new ApiError(402, "PLAN_LIMIT_EXCEEDED", `Table limit for this base is ${maxTables}`);
          }
        }
        if (body.withRecords) {
          const t = await loadTableRow(ctx.db, s.tableId);
          await limits.assertCanCreateRecord(s.orgId, s.baseId, t?.recordCount ?? 0);
        }
        let newId = "";
        await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
          const res = await duplicateTableInTx(opCtx(ctx, mctx, trx, s.workspaceId, s.user.id), s.tableId, {
            withRecords: body.withRecords === true,
            ...(body.name ? { name: body.name } : {}),
          });
          newId = res.tableId;
          return {
            kind: "schema" as const,
            ops: [{ op: "table.created", tableId: newId, duplicatedFrom: s.tableId }],
            inverseOps: [{ op: "table.deleted", tableId: newId }],
            tableIds: [newId, ...res.touchedTableIds],
            eventType: "table.created",
            aggregateType: "table",
            aggregateId: newId,
            payload: { tableId: newId, duplicatedFrom: s.tableId },
          };
        });
        void reply.code(201).send({ table: await tableDto(ctx.db, s.baseId, newId) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/primary-field",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        const body = z.object({ fieldId: z.string() }).parse(request.body ?? {});
        const fieldId = parsePid(body.fieldId, "fld");
        await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
          await setPrimaryFieldInTx(opCtx(ctx, mctx, trx, s.workspaceId, s.user.id), s.tableId, fieldId);
          return {
            kind: "schema" as const,
            ops: [{ op: "table.primary_field_set", tableId: s.tableId, fieldId }],
            tableIds: [s.tableId],
            eventType: "table.updated",
            aggregateType: "table",
            aggregateId: s.tableId,
            payload: { tableId: s.tableId, primaryFieldId: fieldId },
          };
        });
        void reply.send({ table: await tableDto(ctx.db, s.baseId, s.tableId) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // ------------------------------------------------------------------ fields

  app.get<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, false);
        if (!s) return;
        void reply.send({ fields: await serializeTableFields(ctx.db, s.baseId, s.tableId) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        const body = fieldBody.parse(request.body ?? {});
        let fieldId = "";
        await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
          const res = await createFieldInTx(opCtx(ctx, mctx, trx, s.workspaceId, s.user.id), s.tableId, {
            name: body.name,
            type: body.type,
            ...(body.config ? { config: body.config } : {}),
            ...(body.description ? { description: body.description } : {}),
            ...(body.inverseName ? { inverseName: body.inverseName } : {}),
          });
          fieldId = res.fieldId;
          const tableIds = [s.tableId, ...(res.linkedTableId && res.linkedTableId !== s.tableId ? [res.linkedTableId] : [])];
          return {
            kind: "schema" as const,
            ops: [
              { op: "field.created", tableId: s.tableId, fieldId },
              ...(res.inverseFieldId ? [{ op: "field.created", tableId: res.linkedTableId, fieldId: res.inverseFieldId }] : []),
            ],
            inverseOps: [{ op: "field.deleted", tableId: s.tableId, fieldId }],
            tableIds,
            eventType: "field.created",
            aggregateType: "field",
            aggregateId: fieldId,
            payload: { tableId: s.tableId, fieldId, name: body.name, type: body.type },
          };
        });
        void reply.code(201).send({ field: await serializeField(ctx.db, s.baseId, s.tableId, fieldId) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields/reorder",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        const body = z.object({ fieldIds: z.array(z.string()).min(1) }).parse(request.body ?? {});
        const ids = body.fieldIds.map((f) => parsePid(f, "fld"));
        await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
          await reorderFieldsInTx(opCtx(ctx, mctx, trx, s.workspaceId, s.user.id), s.tableId, ids);
          return {
            kind: "schema" as const,
            ops: [{ op: "fields.reordered", tableId: s.tableId, fieldIds: ids }],
            tableIds: [s.tableId],
            eventType: "fields.reordered",
            aggregateType: "table",
            aggregateId: s.tableId,
            payload: { tableId: s.tableId },
          };
        });
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { baseId: string; tableId: string; fieldId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields/:fieldId",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        const fieldId = parsePid(request.params.fieldId, "fld");
        const body = fieldPatchBody.parse(request.body ?? {});
        const before = await loadFieldRow(ctx.db, s.tableId, fieldId);
        if (!before) throw new ApiError(404, "FIELD_NOT_FOUND", "Field not found");
        await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
          const res = await updateFieldInTx(opCtx(ctx, mctx, trx, s.workspaceId, s.user.id), s.tableId, fieldId, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.config !== undefined ? { config: body.config } : {}),
            ...(body.type !== undefined ? { type: body.type } : {}),
          });
          return {
            kind: "schema" as const,
            ops: [{ op: "field.updated", tableId: s.tableId, fieldId, typeChanged: body.type !== undefined && body.type !== before.type }],
            inverseOps: [
              {
                op: "field.updated",
                tableId: s.tableId,
                fieldId,
                name: before.name,
                type: before.type,
                config: before.config,
                description: before.description,
              },
            ],
            tableIds: res.tableIds,
            eventType: "field.updated",
            aggregateType: "field",
            aggregateId: fieldId,
            payload: { tableId: s.tableId, fieldId, converted: res.converted },
          };
        });
        void reply.send({ field: await serializeField(ctx.db, s.baseId, s.tableId, fieldId) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; tableId: string; fieldId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields/:fieldId",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        const fieldId = parsePid(request.params.fieldId, "fld");
        await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
          const res = await deleteFieldInTx(opCtx(ctx, mctx, trx, s.workspaceId, s.user.id), s.tableId, fieldId);
          return {
            kind: "schema" as const,
            ops: [
              { op: "field.soft_deleted", tableId: s.tableId, fieldId },
              ...(res.inverseFieldId ? [{ op: "field.soft_deleted", fieldId: res.inverseFieldId }] : []),
            ],
            inverseOps: [{ op: "field.restored", tableId: s.tableId, fieldId }],
            tableIds: res.tableIds,
            eventType: "field.deleted",
            aggregateType: "field",
            aggregateId: fieldId,
            payload: { tableId: s.tableId, fieldId },
          };
        });
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string; fieldId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields/:fieldId/duplicate",
    async (request, reply) => {
      try {
        const s = await tableScope(request, reply, true);
        if (!s) return;
        const fieldId = parsePid(request.params.fieldId, "fld");
        const body = z.object({ withValues: z.boolean().optional() }).parse(request.body ?? {});
        let newId = "";
        await withBaseTx(ctx.db, txParams(s), async (mctx, trx) => {
          const res = await duplicateFieldInTx(
            opCtx(ctx, mctx, trx, s.workspaceId, s.user.id),
            s.tableId,
            fieldId,
            body.withValues === true,
          );
          newId = res.fieldId;
          return {
            kind: "schema" as const,
            ops: [{ op: "field.created", tableId: s.tableId, fieldId: newId, duplicatedFrom: fieldId }],
            inverseOps: [{ op: "field.deleted", tableId: s.tableId, fieldId: newId }],
            tableIds: res.tableIds,
            eventType: "field.created",
            aggregateType: "field",
            aggregateId: newId,
            payload: { tableId: s.tableId, fieldId: newId },
          };
        });
        void reply.code(201).send({ field: await serializeField(ctx.db, s.baseId, s.tableId, newId) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
