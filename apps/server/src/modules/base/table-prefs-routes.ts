import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { conflictProblem, handleRouteError, notFound } from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";

const hiddenBody = z.object({ hidden: z.boolean() });

/** Raw uuids of the live tables `userId` has hidden in `baseId`. */
export async function loadHiddenTableIds(
  db: AppContext["db"],
  userId: string,
  baseId: string,
): Promise<string[]> {
  const res = await sql<{ table_id: string }>`
    SELECT h.table_id
    FROM data.user_hidden_tables h
    JOIN data.tables t ON t.id = h.table_id AND t.deleted_at IS NULL
    WHERE h.user_id = ${userId} AND h.base_id = ${baseId}
    ORDER BY t.order_key ASC
  `.execute(db);
  return res.rows.map((r) => r.table_id);
}

/**
 * Per-user table visibility (Airtable "Hide table"). Any user who can open the
 * base may hide tables for themselves; at least one table stays visible.
 */
export async function registerTablePrefsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { baseId: string } }>("/v1/bases/:baseId/hidden-tables", async (request, reply) => {
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
      const ids = await loadHiddenTableIds(ctx.db, user.id, baseId);
      void reply.send({ hiddenTableIds: ids.map((id) => pid("tbl", id)) });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.put<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/hidden",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = hiddenBody.parse(request.body ?? {});
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }
        const tables = await sql<{ id: string }>`
          SELECT id FROM data.tables WHERE base_id = ${baseId} AND deleted_at IS NULL
        `.execute(ctx.db);
        if (!tables.rows.some((t) => t.id === tableId)) {
          notFound(request, reply, "Table not found");
          return;
        }

        if (body.hidden) {
          const hidden = new Set(await loadHiddenTableIds(ctx.db, user.id, baseId));
          hidden.add(tableId);
          if (tables.rows.every((t) => hidden.has(t.id))) {
            conflictProblem(request, reply, "At least one table must stay visible.");
            return;
          }
          await sql`
            INSERT INTO data.user_hidden_tables (user_id, base_id, table_id)
            VALUES (${user.id}, ${baseId}, ${tableId})
            ON CONFLICT (user_id, table_id) DO NOTHING
          `.execute(ctx.db);
        } else {
          await sql`
            DELETE FROM data.user_hidden_tables
            WHERE user_id = ${user.id} AND table_id = ${tableId}
          `.execute(ctx.db);
        }

        const ids = await loadHiddenTableIds(ctx.db, user.id, baseId);
        void reply.send({
          tableId: pid("tbl", tableId),
          hidden: body.hidden,
          hiddenTableIds: ids.map((id) => pid("tbl", id)),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
