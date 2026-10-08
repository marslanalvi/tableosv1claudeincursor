import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { ApiError, handleRouteError } from "../../http/errors.js";
import { withBaseTx } from "../../kernel/mutation.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { resolveBaseContext } from "../access/helpers.js";
import { writeAuditEvent } from "../audit/write.js";
import { bootstrapDefaultTable } from "../base/bootstrap-default-table.js";
import { loadSync, mapSourceField, runTableSync, sourceFieldsInOrder, type SyncRow } from "./engine.js";

const createBody = z.object({
  sourceTableId: z.string(),
  name: z.string().trim().min(1).max(255).optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional(),
});
const patchBody = z.object({
  status: z.enum(["active", "paused"]).optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional(),
});

type BaseParams = { baseId: string };
type TableParams = { baseId: string; tableId: string };

export function syncDto(s: SyncRow, names: { baseName: string; tableName: string } | null) {
  return {
    id: s.id,
    sourceBaseId: pid("bas", s.source_base_id),
    sourceTableId: pid("tbl", s.source_table_id),
    sourceBaseName: names?.baseName ?? null,
    sourceTableName: names?.tableName ?? null,
    status: s.status,
    intervalMinutes: s.interval_minutes,
    lastSyncedAt: s.last_synced_at ? new Date(s.last_synced_at).toISOString() : null,
    lastError: s.last_error,
    recordCount: s.last_record_count,
    syncedFieldIds: Object.values(s.field_map ?? {}).map((f) => pid("fld", f)),
  };
}

export async function sourceNames(db: AppContext["db"], s: Pick<SyncRow, "source_base_id" | "source_table_id">) {
  const r = await sql<{ base_name: string; table_name: string }>`
    SELECT b.name AS base_name, t.name AS table_name
    FROM data.tables t INNER JOIN core.base_directory b ON b.base_id = t.base_id
    WHERE t.id = ${s.source_table_id}
  `.execute(db);
  const row = r.rows[0];
  return row ? { baseName: row.base_name, tableName: row.table_name } : null;
}

export async function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const deps = { db: ctx.db, redis: ctx.redis, storage: ctx.storage };

  function wrap<P>(fn: (request: FastifyRequest<{ Params: P }>, reply: FastifyReply) => Promise<void>) {
    return async (request: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
      try {
        await fn(request, reply);
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    };
  }

  async function base(request: FastifyRequest<{ Params: BaseParams }>, action: "base.read" | "base.manage_schema" | "record.update") {
    const user = request.user;
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in first");
    const baseId = parsePid(request.params.baseId, "bas");
    const b = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!b.ok) throw new ApiError(404, "NOT_FOUND", "Base not found");
    assertCan(await compileForUser(ctx.db, user.id, baseId), action);
    return { user, baseId, orgId: b.orgId, workspaceId: b.workspaceId };
  }

  async function tableSync(request: FastifyRequest<{ Params: TableParams }>, action: "base.read" | "base.manage_schema" | "record.update") {
    const s = await base(request, action);
    const tableId = parsePid(request.params.tableId, "tbl");
    const sync = await loadSync(ctx.db, { tableId });
    if (!sync || sync.base_id !== s.baseId) throw new ApiError(404, "NOT_FOUND", "This table isn't synced");
    return { ...s, tableId, sync };
  }

  /** Tables in the organization's other bases that this person can read. */
  app.get<{ Params: BaseParams }>(
    "/v1/bases/:baseId/sync-sources",
    wrap<BaseParams>(async (request, reply) => {
      const s = await base(request, "base.read");
      const bases = await sql<{ base_id: string; name: string; workspace_name: string }>`
        SELECT b.base_id, b.name, w.name AS workspace_name
        FROM core.base_directory b INNER JOIN core.workspaces w ON w.id = b.workspace_id
        WHERE b.org_id = ${s.orgId} AND b.base_id <> ${s.baseId} AND b.status = 'active' AND b.deleted_at IS NULL AND w.deleted_at IS NULL
        ORDER BY w.name, b.order_key
      `.execute(ctx.db);
      const readable: typeof bases.rows = [];
      for (const b of bases.rows) {
        const snap = await compileForUser(ctx.db, s.user.id, b.base_id);
        if (snap.effectiveBaseRole) readable.push(b);
      }
      const ids = readable.map((b) => b.base_id);
      const tables = ids.length
        ? (
            await sql<{ id: string; base_id: string; name: string; record_count: number }>`
              SELECT id, base_id, name, record_count FROM data.tables
              WHERE base_id = ANY(${ids}::uuid[]) AND deleted_at IS NULL ORDER BY order_key
            `.execute(ctx.db)
          ).rows
        : [];
      void reply.send({
        bases: readable.map((b) => ({
          id: pid("bas", b.base_id),
          name: b.name,
          workspaceName: b.workspace_name,
          tables: tables
            .filter((t) => t.base_id === b.base_id)
            .map((t) => ({ id: pid("tbl", t.id), name: t.name, recordCount: Number(t.record_count) })),
        })),
      });
    }),
  );

  /** Create a synced copy of a table from another base, then fill it. */
  app.post<{ Params: BaseParams }>(
    "/v1/bases/:baseId/synced-tables",
    wrap<BaseParams>(async (request, reply) => {
      const s = await base(request, "base.manage_schema");
      const body = createBody.parse(request.body ?? {});
      const sourceTableId = parsePid(body.sourceTableId, "tbl");
      const src = await sql<{ base_id: string; name: string; org_id: string }>`
        SELECT t.base_id, t.name, b.org_id FROM data.tables t INNER JOIN core.base_directory b ON b.base_id = t.base_id
        WHERE t.id = ${sourceTableId} AND t.deleted_at IS NULL AND b.deleted_at IS NULL
      `.execute(ctx.db);
      const source = src.rows[0];
      if (!source) throw new ApiError(404, "NOT_FOUND", "Source table not found");
      if (source.org_id !== s.orgId) throw new ApiError(422, "VALIDATION_FAILED", "You can only sync tables from bases in the same organization");
      if (source.base_id === s.baseId) throw new ApiError(422, "VALIDATION_FAILED", "That table is already in this base — link to it directly");
      const srcSnap = await compileForUser(ctx.db, s.user.id, source.base_id);
      if (!srcSnap.effectiveBaseRole) throw new ApiError(404, "NOT_FOUND", "Source table not found");

      const existing = await sql<{ table_id: string }>`
        SELECT s.table_id FROM data.table_syncs s INNER JOIN data.tables t ON t.id = s.table_id AND t.deleted_at IS NULL
        WHERE s.base_id = ${s.baseId} AND s.source_table_id = ${sourceTableId}
      `.execute(ctx.db);
      if (existing.rows[0]) {
        void reply.send({ tableId: pid("tbl", existing.rows[0].table_id), existing: true });
        return;
      }

      const baseName = (await sql<{ name: string }>`SELECT name FROM core.base_directory WHERE base_id = ${source.base_id}`.execute(ctx.db)).rows[0]?.name ?? "";
      const taken = await sql<{ name: string }>`SELECT name FROM data.tables WHERE base_id = ${s.baseId} AND deleted_at IS NULL`.execute(ctx.db);
      const takenSet = new Set(taken.rows.map((r) => r.name.toLowerCase()));
      let name = body.name ?? source.name;
      if (takenSet.has(name.toLowerCase())) name = `${source.name} (${baseName})`;
      for (let i = 2; takenSet.has(name.toLowerCase()); i++) name = `${source.name} (${baseName}) ${i}`;

      const srcFields = await sourceFieldsInOrder(ctx.db, sourceTableId);
      const srcPrimary = srcFields[0];
      const primaryMapped = srcPrimary ? mapSourceField(srcPrimary) : null;
      const primaryType = primaryMapped && !["checkbox", "attachment", "long_text"].includes(primaryMapped.type) ? primaryMapped : { type: "text", config: {}, conv: "text" as const };

      let tableId = "";
      await withBaseTx(
        ctx.db,
        { orgId: s.orgId, workspaceId: s.workspaceId, baseId: s.baseId, actor: { actorType: "user", actorId: s.user.id, via: "api" }, redis: ctx.redis },
        async (_m, trx) => {
          const boot = await bootstrapDefaultTable(trx, {
            workspaceId: s.workspaceId,
            baseId: s.baseId,
            userId: s.user.id,
            tableName: name,
            emptyRecords: 0,
            fields: [
              { name: srcPrimary?.name ?? "Name", type: primaryType.type, config: primaryType.config },
              { name: "Record ID", type: "record_id", config: {} },
            ],
          });
          tableId = boot.tableId;
          const fieldMap = srcPrimary ? { [srcPrimary.id]: boot.fieldId } : {};
          await sql`
            INSERT INTO data.table_syncs (workspace_id, base_id, table_id, source_base_id, source_table_id, owner_user_id, field_map, interval_minutes)
            VALUES (${s.workspaceId}, ${s.baseId}, ${tableId}, ${source.base_id}, ${sourceTableId}, ${s.user.id},
                    ${JSON.stringify(fieldMap)}::jsonb, ${body.intervalMinutes ?? 5})
          `.execute(trx);
          return {
            kind: "schema" as const,
            ops: [{ op: "table.created", tableId, name }],
            tableIds: [tableId],
            eventType: "table.created",
            aggregateType: "table",
            aggregateId: tableId,
            payload: { tableId, name, syncedFrom: sourceTableId },
          };
        },
      );
      const sync = await loadSync(ctx.db, { tableId });
      let result = null;
      let error: string | null = null;
      try {
        result = await runTableSync(deps, sync!.id);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await writeAuditEvent(ctx.db, {
        orgId: s.orgId,
        workspaceId: s.workspaceId,
        actorUserId: s.user.id,
        action: "table.sync_created",
        targetType: "table",
        targetId: tableId,
        metadata: { sourceTableId, sourceBaseId: source.base_id },
        ip: request.ip,
      });
      void reply.code(201).send({ tableId: pid("tbl", tableId), result, error });
    }),
  );

  app.get<{ Params: TableParams }>(
    "/v1/bases/:baseId/tables/:tableId/sync",
    wrap<TableParams>(async (request, reply) => {
      const { sync } = await tableSync(request, "base.read");
      void reply.send({ sync: syncDto(sync, await sourceNames(ctx.db, sync)) });
    }),
  );

  app.post<{ Params: TableParams }>(
    "/v1/bases/:baseId/tables/:tableId/sync/run",
    wrap<TableParams>(async (request, reply) => {
      const { sync } = await tableSync(request, "record.update");
      let result = null;
      try {
        result = await runTableSync(deps, sync.id);
      } catch {
        // Stored on the sync row; returned below.
      }
      const fresh = (await loadSync(ctx.db, { id: sync.id }))!;
      void reply.send({ result, sync: syncDto(fresh, await sourceNames(ctx.db, fresh)) });
    }),
  );

  app.patch<{ Params: TableParams }>(
    "/v1/bases/:baseId/tables/:tableId/sync",
    wrap<TableParams>(async (request, reply) => {
      const { sync } = await tableSync(request, "base.manage_schema");
      const body = patchBody.parse(request.body ?? {});
      await sql`
        UPDATE data.table_syncs
        SET status = coalesce(${body.status ?? null}, status),
            interval_minutes = coalesce(${body.intervalMinutes ?? null}, interval_minutes),
            updated_at = now()
        WHERE id = ${sync.id}
      `.execute(ctx.db);
      const fresh = (await loadSync(ctx.db, { id: sync.id }))!;
      void reply.send({ sync: syncDto(fresh, await sourceNames(ctx.db, fresh)) });
    }),
  );

  /** Stop syncing: the table keeps its data and becomes a normal, editable table. */
  app.delete<{ Params: TableParams }>(
    "/v1/bases/:baseId/tables/:tableId/sync",
    wrap<TableParams>(async (request, reply) => {
      const s = await tableSync(request, "base.manage_schema");
      await sql`DELETE FROM data.table_syncs WHERE id = ${s.sync.id}`.execute(ctx.db);
      await writeAuditEvent(ctx.db, { orgId: s.orgId, workspaceId: s.workspaceId, actorUserId: s.user.id, action: "table.sync_removed", targetType: "table", targetId: s.tableId, ip: request.ip });
      void reply.code(204).send();
    }),
  );
}
