/**
 * `GET /v1/bases/:b/tables/:t/records/:r/history?cursor=&limit=` — record
 * revision history (newest first), built from the change log. Deleted records
 * keep their history. Entries older than the plan's `revisionRetentionDays`
 * are not returned.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { LimitsService } from "../billing/limits-service.js";
import { loadRecordHistory } from "../history/record-history.js";

const querySchema = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,18}$/, "Invalid cursor")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function registerRecordHistoryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const limits = new LimitsService(ctx.db);

  app.get<{
    Params: { baseId: string; tableId: string; recordId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/v1/bases/:baseId/tables/:tableId/records/:recordId/history", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }
      const baseId = parsePid(request.params.baseId, "bas");
      const tableId = parsePid(request.params.tableId, "tbl");
      const recordId = parsePid(request.params.recordId, "rec");
      const q = querySchema.parse(request.query ?? {});
      const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
      if (!table.ok) {
        notFound(request, reply, "Table not found");
        return;
      }
      assertCan(await compileForUser(ctx.db, user.id, baseId), "base.read");
      const exists = await sql<{ id: string }>`
        SELECT id FROM data.records WHERE table_id = ${tableId} AND id = ${recordId}
      `.execute(ctx.db);
      if (exists.rows.length === 0) {
        notFound(request, reply, "Record not found");
        return;
      }
      const plan = await limits.getOrgPlan(table.orgId);
      const days = plan.limits["revisionRetentionDays"];
      const retentionDays = typeof days === "number" && Number.isFinite(days) && days > 0 ? days : null;
      const history = await loadRecordHistory(ctx.db, {
        baseId,
        tableId,
        recordId,
        beforeSeq: q.cursor ? Number(q.cursor) : null,
        limit: q.limit,
        retentionDays,
        storage: ctx.storage,
      });
      void reply.send(history);
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });
}
