import { keyBetween } from "@tabula/types";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound, validationProblem } from "../../http/errors.js";
import { resolveBaseContext, resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { nextOrderKey } from "../../lib/order-key.js";

/**
 * Fallback implementations of the table routes promised in CONTRACTS §4
 * (`POST …/tables/:t/duplicate`, `POST …/tables/reorder`). They are only
 * registered when the schema module (workstream B) does not provide them,
 * so B can take them over without a route conflict.
 */

/** Field types that depend on link relations; not copied by table duplicate. */
const LINK_FAMILY = new Set(["link", "contact", "lookup", "rollup", "count"]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PUBLIC_RE = /\bfld_[0-9A-Za-z]+/g;

function actor(user: NonNullable<import("fastify").FastifyRequest["user"]>): MutationActor {
  return { actorType: "user", actorId: user.id, sessionId: user.sessionId, via: "api" };
}

export function registerTableFallbackRoutes(app: FastifyInstance, ctx: AppContext): void {
  const dupUrl = "/v1/bases/:baseId/tables/:tableId/duplicate";
  if (!app.hasRoute({ method: "POST", url: dupUrl })) {
    app.post<{ Params: { baseId: string; tableId: string } }>(dupUrl, async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = z
          .object({ withRecords: z.boolean().optional(), name: z.string().min(1).max(200).optional() })
          .parse(request.body ?? {});
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }
        assertCan(await compileForUser(ctx.db, user.id, baseId), "base.manage_schema");

        const newTableId = generateUuidV7();
        let newName = body.name ?? `${table.tableName} copy`;

        await withBaseTx(
          ctx.db,
          {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            for (let i = 2; i < 50; i++) {
              const clash = await sql<{ id: string }>`
                SELECT id FROM data.tables WHERE base_id = ${baseId}
                  AND lower(name) = lower(${newName}) AND deleted_at IS NULL LIMIT 1
              `.execute(trx);
              if (clash.rows.length === 0) break;
              newName = `${body.name ?? `${table.tableName} copy`} ${i}`;
            }
            const src = await sql<{ primary_field_id: string | null; next_field_slot: number; next_row_number: string; description: string; settings: unknown }>`
              SELECT primary_field_id, next_field_slot, next_row_number, description, settings
              FROM data.tables WHERE id = ${tableId}
            `.execute(trx);
            const s = src.rows[0]!;
            const fields = await sql<{ id: string; slot: number; name: string; description: string; type: string; config: unknown; order_key: string; is_computed: boolean }>`
              SELECT id, slot, name, description, type, config, order_key, is_computed
              FROM data.fields WHERE table_id = ${tableId} AND deleted_at IS NULL
            `.execute(trx);
            const map = new Map<string, string>();
            const kept = fields.rows.filter((f) => !LINK_FAMILY.has(f.type));
            for (const f of kept) map.set(f.id, generateUuidV7());
            const remap = (v: unknown): string =>
              JSON.stringify(v ?? {})
                .replace(UUID_RE, (m) => map.get(m.toLowerCase()) ?? m)
                .replace(PUBLIC_RE, (m) => {
                  for (const [o, n] of map) if (pid("fld", o) === m) return pid("fld", n);
                  return m;
                });
            const keptSlots = new Set(kept.map((f) => String(f.slot)));

            await sql`
              INSERT INTO data.tables (id, workspace_id, base_id, name, description, primary_field_id,
                order_key, next_field_slot, next_row_number, record_count, settings, created_by)
              VALUES (${newTableId}, ${table.workspaceId}, ${baseId}, ${newName}, ${s.description},
                ${s.primary_field_id ? (map.get(s.primary_field_id) ?? null) : null},
                ${nextOrderKey()}, ${s.next_field_slot}, ${body.withRecords ? s.next_row_number : "1"},
                0, ${JSON.stringify(s.settings ?? {})}::jsonb, ${user.id})
            `.execute(trx);
            for (const f of kept) {
              await sql`
                INSERT INTO data.fields (id, workspace_id, base_id, table_id, slot, name, description,
                  type, config, order_key, is_computed, created_by)
                VALUES (${map.get(f.id)!}, ${table.workspaceId}, ${baseId}, ${newTableId}, ${f.slot},
                  ${f.name}, ${f.description}, ${f.type}, ${remap(f.config)}::jsonb, ${f.order_key},
                  ${f.is_computed}, ${user.id})
              `.execute(trx);
            }
            if (map.size > 0) {
              const deps = await sql<{ dependent_field_id: string; depends_on_field_id: string }>`
                SELECT dependent_field_id, depends_on_field_id FROM data.field_dependencies
                WHERE dependent_field_id = ANY(${[...map.keys()]}::uuid[])
                  AND via_link_field_id IS NULL
              `.execute(trx);
              for (const d of deps.rows) {
                const dep = map.get(d.dependent_field_id);
                const on = map.get(d.depends_on_field_id);
                if (!dep || !on) continue;
                await sql`
                  INSERT INTO data.field_dependencies
                    (dependent_field_id, depends_on_field_id, via_link_field_id, workspace_id, base_id)
                  VALUES (${dep}, ${on}, NULL, ${table.workspaceId}, ${baseId})
                  ON CONFLICT DO NOTHING
                `.execute(trx);
              }
            }

            const views = await sql<{ id: string; type: string; name: string; description: string; visibility: string; owner_user_id: string | null; config: unknown; order_key: string; is_default: boolean }>`
              SELECT id, type, name, description, visibility, owner_user_id, config, order_key, is_default
              FROM data.views WHERE table_id = ${tableId} AND deleted_at IS NULL
                AND (visibility <> 'personal' OR owner_user_id = ${user.id})
            `.execute(trx);
            for (const v of views.rows) {
              await sql`
                INSERT INTO data.views (id, workspace_id, base_id, table_id, type, name, description,
                  visibility, owner_user_id, config, order_key, is_default, created_by)
                VALUES (${generateUuidV7()}, ${table.workspaceId}, ${baseId}, ${newTableId}, ${v.type},
                  ${v.name}, ${v.description}, ${v.visibility}, ${v.owner_user_id}, ${remap(v.config)}::jsonb,
                  ${v.order_key}, ${v.is_default}, ${user.id})
              `.execute(trx);
            }

            let copied = 0;
            if (body.withRecords) {
              const rows = await sql<{ id: string; row_number: string; manual_order: string; cells: Record<string, unknown> }>`
                SELECT id, row_number, manual_order, cells FROM data.records
                WHERE table_id = ${tableId} AND deleted_at IS NULL
              `.execute(trx);
              for (const r of rows.rows) {
                const cells: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(r.cells ?? {})) if (keptSlots.has(k)) cells[k] = v;
                await sql`
                  INSERT INTO data.records (table_id, id, workspace_id, base_id, row_number, manual_order,
                    cells, created_by, created_via, last_change_seq)
                  VALUES (${newTableId}, ${generateUuidV7()}, ${table.workspaceId}, ${baseId}, ${r.row_number},
                    ${r.manual_order}, ${JSON.stringify(cells)}::jsonb, ${user.id}, 'api', ${mctx.changeSeq})
                `.execute(trx);
              }
              copied = rows.rows.length;
              await sql`UPDATE data.tables SET record_count = ${copied} WHERE id = ${newTableId}`.execute(trx);
              await sql`
                UPDATE data.base_runtime SET record_count = record_count + ${copied}, updated_at = now()
                WHERE base_id = ${baseId}
              `.execute(trx);
            }
            return {
              kind: "schema" as const,
              ops: [{ op: "table.created", tableId: newTableId, duplicatedFrom: tableId }],
              inverseOps: [{ op: "table.deleted", tableId: newTableId }],
              tableIds: [newTableId],
              eventType: "table.created",
              aggregateType: "table",
              aggregateId: newTableId,
              payload: { duplicatedFrom: tableId, records: copied },
            };
          },
        );
        void reply.code(201).send({ table: { id: pid("tbl", newTableId), name: newName } });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    });
  }

  const reorderUrl = "/v1/bases/:baseId/tables/reorder";
  if (!app.hasRoute({ method: "POST", url: reorderUrl })) {
    app.post<{ Params: { baseId: string } }>(reorderUrl, async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const body = z.object({ tableIds: z.array(z.string()).min(1).max(500) }).parse(request.body);
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }
        assertCan(await compileForUser(ctx.db, user.id, baseId), "base.manage_schema");
        const ids = body.tableIds.map((t) => parsePid(t, "tbl"));
        const existing = await sql<{ id: string }>`
          SELECT id FROM data.tables WHERE base_id = ${baseId} AND deleted_at IS NULL
          ORDER BY order_key ASC
        `.execute(ctx.db);
        const known = new Set(existing.rows.map((r) => r.id));
        if (ids.some((id) => !known.has(id))) {
          validationProblem(request, reply, "Unknown table id in tableIds");
          return;
        }
        // Tables not listed keep their relative order after the listed ones.
        const ordered = [...ids, ...existing.rows.map((r) => r.id).filter((id) => !ids.includes(id))];
        await withBaseTx(
          ctx.db,
          { orgId: base.orgId, workspaceId: base.workspaceId, baseId, actor: actor(user), redis: ctx.redis },
          async (_mctx, trx) => {
            let prev: string | null = null;
            for (const id of ordered) {
              const key = keyBetween(prev, null);
              prev = key;
              await sql`UPDATE data.tables SET order_key = ${key}, updated_at = now() WHERE id = ${id}`.execute(trx);
            }
            return {
              kind: "schema" as const,
              ops: [{ op: "tables.reordered", tableIds: ordered }],
              inverseOps: null,
              tableIds: ordered,
              eventType: "tables.reordered",
              aggregateType: "base",
              aggregateId: baseId,
              payload: {},
            };
          },
        );
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    });
  }
}
