import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { writeRecordLinksInTx } from "./record-links.js";
import { runComputeInTx, type RecordChange } from "../compute/engine.js";
import { createFieldInTx } from "../schema/field-ops.js";
import { serializeField } from "../schema/routes.js";
import { serializeRecordsByIds } from "../records/serialize.js";
import { computeOps, touchedTableIds } from "../records/write.js";

const linkFieldPairBody = z.object({
  name: z.string().trim().min(1).max(255),
  linkedTableId: z.string(),
  inverseName: z.string().trim().min(1).max(255).optional(),
  allowMultiple: z.boolean().optional(),
});

const linkMutationBody = z.object({
  fieldId: z.string(),
  recordIds: z.array(z.string()).min(1),
});

function actor(user: NonNullable<FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

export async function registerLinksRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  /** Legacy convenience: equivalent to POST …/fields {type:"link"}. */
  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/link-fields",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = linkFieldPairBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }
        assertCan(await compileForUser(ctx.db, user.id, baseId), "base.manage_schema");

        let created: { fieldId: string; inverseFieldId: string | null; linkedTableId: string | null } | null = null;
        await withBaseTx(
          ctx.db,
          { orgId: table.orgId, workspaceId: table.workspaceId, baseId, actor: actor(user), redis: ctx.redis },
          async (mctx, trx) => {
            created = await createFieldInTx(
              { trx, baseId, workspaceId: table.workspaceId, userId: user.id, redis: ctx.redis, afterCommit: mctx.afterCommit },
              tableId,
              {
                name: body.name,
                type: "link",
                config: { linkedTableId: body.linkedTableId, allowMultiple: body.allowMultiple ?? true },
                ...(body.inverseName ? { inverseName: body.inverseName } : {}),
              },
            );
            const c = created!;
            return {
              kind: "schema" as const,
              ops: [
                { op: "field.created", tableId, fieldId: c.fieldId },
                ...(c.inverseFieldId ? [{ op: "field.created", tableId: c.linkedTableId, fieldId: c.inverseFieldId }] : []),
              ],
              inverseOps: [{ op: "field.deleted", tableId, fieldId: c.fieldId }],
              tableIds: [tableId, ...(c.linkedTableId && c.linkedTableId !== tableId ? [c.linkedTableId] : [])],
              eventType: "field.created",
              aggregateType: "field",
              aggregateId: c.fieldId,
              payload: { tableId, fieldId: c.fieldId },
            };
          },
        );
        const c = created! as { fieldId: string; inverseFieldId: string | null; linkedTableId: string | null };
        const field = await serializeField(ctx.db, baseId, tableId, c.fieldId);
        const inverse =
          c.inverseFieldId && c.linkedTableId ? await serializeField(ctx.db, baseId, c.linkedTableId, c.inverseFieldId) : null;
        void reply.code(201).send({
          field,
          inverseField: inverse,
          fields: [
            { id: pid("fld", c.fieldId), tableId: pid("tbl", tableId) },
            ...(c.inverseFieldId && c.linkedTableId
              ? [{ id: pid("fld", c.inverseFieldId), tableId: pid("tbl", c.linkedTableId) }]
              : []),
          ],
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  for (const method of ["post", "delete"] as const) {
    app[method]<{ Params: { baseId: string; tableId: string; recordId: string } }>(
      "/v1/bases/:baseId/tables/:tableId/records/:recordId/links",
      async (request, reply) => {
        try {
          const user = request.user;
          if (!user) {
            notFound(request, reply);
            return;
          }
          const baseId = parsePid(request.params.baseId, "bas");
          const tableId = parsePid(request.params.tableId, "tbl");
          const recordId = parsePid(request.params.recordId, "rec");
          const body = linkMutationBody.parse(request.body);
          const fieldId = parsePid(body.fieldId, "fld");
          const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
          if (!table.ok) {
            notFound(request, reply, "Table not found");
            return;
          }
          assertCan(await compileForUser(ctx.db, user.id, baseId), "record.update");

          await withBaseTx(
            ctx.db,
            { orgId: table.orgId, workspaceId: table.workspaceId, baseId, actor: actor(user), redis: ctx.redis },
            async (mctx, trx) => {
              const exists = await trx
                .selectFrom("data.records" as never)
                .select("id" as never)
                .where("table_id" as never, "=", tableId as never)
                .where("id" as never, "=", recordId as never)
                .where("deleted_at" as never, "is", null as never)
                .executeTakeFirst();
              if (!exists) throw Object.assign(new Error("RECORD_NOT_FOUND"), { code: "RECORD_NOT_FOUND" });
              const res = await writeRecordLinksInTx(trx, {
                workspaceId: table.workspaceId,
                baseId,
                fieldId,
                recordId,
                targetIds: body.recordIds,
                mode: method === "post" ? "add" : "remove",
              });
              const changes: RecordChange[] = [];
              if (res.changed) {
                changes.push({ tableId, recordIds: [recordId], fieldIds: [fieldId] });
                const peers = [...res.added, ...res.removed];
                if (peers.length && res.peerFieldId) {
                  changes.push({ tableId: res.peerTableId, recordIds: peers, fieldIds: [res.peerFieldId] });
                }
              }
              const compute = await runComputeInTx(
                trx,
                { baseId, workspaceId: table.workspaceId, redis: ctx.redis, afterCommit: mctx.afterCommit },
                { changes },
              );
              const outcome = { touched: compute.touched };
              return {
                kind: "links" as const,
                ops: [
                  { op: method === "post" ? "link.add" : "link.remove", tableId, recordId, fieldId, targets: res.next },
                  ...(res.added.length || res.removed.length
                    ? [{ op: "records.links_changed", tableId: res.peerTableId, recordIds: [...res.added, ...res.removed] }]
                    : []),
                  ...computeOps(outcome),
                ],
                tableIds: [...new Set([...touchedTableIds(tableId, outcome), res.peerTableId])],
                eventType: "record.links_changed",
                aggregateType: "record",
                aggregateId: recordId,
                payload: { tableId, recordId, fieldId },
              };
            },
          );
          const [record] = await serializeRecordsByIds(ctx.db, tableId, [recordId], { storage: ctx.storage });
          if (method === "delete") void reply.code(200).send({ record });
          else void reply.send({ ok: true, record });
        } catch (err) {
          handleRouteError(request, reply, err);
        }
      },
    );
  }
}
