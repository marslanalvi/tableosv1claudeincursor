import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isFilterError } from "@tabula/filter";
import { InvalidCursorError } from "@tabula/query";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid } from "../../lib/public-ids.js";
import { handleRouteError, notFound, validationProblem } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { executeRecordQuery, QueryNotFoundError, resolveProjection } from "./execute-record-query.js";
import { executeGroupQuery } from "./group-query.js";
import { loadQueryFields, loadUserQueryContext } from "./context.js";
import { serializeRecordsByIds } from "../records/serialize.js";

const sortItem = z
  .object({
    field: z.string().min(1).optional(),
    fieldId: z.string().min(1).optional(),
    direction: z.enum(["asc", "desc"]).default("asc"),
  })
  .refine((s) => !!(s.field ?? s.fieldId), "sort item needs field or fieldId");

const queryBody = z.object({
  filter: z.unknown().optional(),
  sort: z.array(sortItem).max(20).optional(),
  search: z.string().max(500).optional(),
  viewId: z.string().min(1).nullish(),
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().nullish(),
  fields: z.array(z.string()).max(500).optional(),
  includeTotalCount: z.boolean().optional(),
});

const groupBody = z.object({
  filter: z.unknown().optional(),
  search: z.string().max(500).optional(),
  viewId: z.string().min(1).nullish(),
  groupBy: z
    .array(z.object({ fieldId: z.string().min(1), direction: z.enum(["asc", "desc"]).optional() }))
    .max(3)
    .optional(),
  aggregates: z
    .array(
      z.object({
        op: z.enum(["count", "sum", "avg", "min", "max", "filled", "empty", "unique"]),
        fieldId: z.string().optional(),
      }),
    )
    .max(50)
    .optional(),
});

/** Query-specific errors → 4xx problem+json; everything else → shared handler. */
function handleQueryError(request: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (isFilterError(err)) {
    validationProblem(request, reply, err.message, [
      { field: err.fieldId ? `filter:${err.fieldId}` : "filter", message: err.code },
    ]);
    return;
  }
  if (err instanceof InvalidCursorError || (err instanceof Error && err.message === "INVALID_CURSOR")) {
    validationProblem(request, reply, err.message === "INVALID_CURSOR" ? "Invalid cursor" : err.message, [
      { field: "cursor", message: "INVALID_CURSOR" },
    ]);
    return;
  }
  if (err instanceof QueryNotFoundError) {
    notFound(request, reply, err.message);
    return;
  }
  handleRouteError(request, reply, err);
}

export async function registerQueryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  async function authorize(
    request: FastifyRequest<{ Params: { baseId: string; tableId: string } }>,
    reply: FastifyReply,
  ): Promise<{ baseId: string; tableId: string; userId: string } | null> {
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
    assertCan(snapshot, "record.read");
    return { baseId, tableId, userId: user.id };
  }

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/query",
    async (request, reply) => {
      try {
        const body = queryBody.parse(request.body ?? {});
        const auth = await authorize(request, reply);
        if (!auth) return;
        const userCtx = await loadUserQueryContext(ctx.db, auth.userId);
        const result = await executeRecordQuery(
          ctx.db,
          auth.tableId,
          {
            filter: body.filter,
            sort: body.sort?.map((s) => ({ fieldId: (s.field ?? s.fieldId) as string, direction: s.direction })),
            search: body.search,
            viewId: body.viewId ?? undefined,
            pageSize: body.pageSize,
            cursor: body.cursor ?? null,
            fields: body.fields,
            includeTotalCount: body.includeTotalCount,
          },
          { user: userCtx, storage: ctx.storage },
        );
        void reply.send(result);
      } catch (err) {
        handleQueryError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string; tableId: string; recordId: string }; Querystring: { fields?: string | string[] } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId",
    async (request, reply) => {
      try {
        const auth = await authorize(request, reply);
        if (!auth) return;
        const recordId = parsePid(request.params.recordId, "rec");
        const fieldsQ = request.query.fields;
        const wanted = fieldsQ === undefined ? undefined : (Array.isArray(fieldsQ) ? fieldsQ : fieldsQ.split(",")).filter((x) => x !== "");
        const fieldRows = await loadQueryFields(ctx.db, auth.tableId);
        const projection = resolveProjection(fieldRows, wanted);
        const [record] = await serializeRecordsByIds(ctx.db, auth.tableId, [recordId], {
          fields: fieldRows,
          fieldIds: projection,
          storage: ctx.storage,
        });
        if (!record) {
          notFound(request, reply, "Record not found");
          return;
        }
        void reply.send({ record });
      } catch (err) {
        handleQueryError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/group",
    async (request, reply) => {
      try {
        const body = groupBody.parse(request.body ?? {});
        const auth = await authorize(request, reply);
        if (!auth) return;
        const userCtx = await loadUserQueryContext(ctx.db, auth.userId);
        const result = await executeGroupQuery(
          ctx.db,
          auth.tableId,
          {
            filter: body.filter,
            search: body.search,
            viewId: body.viewId ?? undefined,
            groupBy: body.groupBy,
            aggregates: body.aggregates,
          },
          { user: userCtx },
        );
        void reply.send(result);
      } catch (err) {
        handleQueryError(request, reply, err);
      }
    },
  );
}
