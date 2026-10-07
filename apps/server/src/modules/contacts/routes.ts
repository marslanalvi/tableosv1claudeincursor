import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { notFound, validationProblem } from "../../http/errors.js";
import { userCanAccessWorkspace } from "../access/helpers.js";
import { handleWave4Error } from "../wave4/problems.js";
import {
  createRecordsBySlot,
  softDeleteRecords,
  updateRecordBySlot,
  type WriteScope,
} from "../wave4/record-writer.js";
import {
  CONTACT_FIELDS,
  contactSlots,
  ensureContactDirectory,
  type ContactKey,
} from "./ensure-directory.js";

const contactInput = z.object({
  name: z.string().trim().max(500).optional(),
  email: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(100).optional().nullable(),
  company: z.string().trim().max(500).optional().nullable(),
  title: z.string().trim().max(500).optional().nullable(),
  notes: z.string().max(20000).optional().nullable(),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerContactsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  async function directoryScope(
    request: FastifyRequest<{ Params: { workspaceId: string } }>,
    reply: FastifyReply,
  ) {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return null;
    }
    const workspaceId = parsePid(request.params.workspaceId, "wsp");
    const access = await userCanAccessWorkspace(ctx.db, user.id, workspaceId);
    if (!access.ok) {
      notFound(request, reply, "Workspace not found");
      return null;
    }
    const shard = await sql<{ shard_id: string }>`
      SELECT shard_id FROM core.workspace_directory WHERE workspace_id = ${workspaceId} LIMIT 1
    `.execute(ctx.db);
    const directory = await ensureContactDirectory(ctx.db, {
      workspaceId,
      orgId: access.orgId,
      shardId: shard.rows[0]?.shard_id ?? ctx.defaultShardId,
      userId: user.id,
    });
    const slots = await contactSlots(ctx.db, directory.contactsTableId);
    const writeScope: WriteScope = {
      orgId: access.orgId,
      workspaceId,
      baseId: directory.baseId,
      tableId: directory.contactsTableId,
      actor: { actorType: "user", actorId: user.id, sessionId: user.sessionId, via: "api" },
      userId: user.id,
      via: "api",
    };
    return { user, workspaceId, directory, slots, writeScope };
  }

  function toCells(
    slots: Partial<Record<ContactKey, number>>,
    input: z.infer<typeof contactInput>,
  ): Record<string, unknown> {
    const cells: Record<string, unknown> = {};
    for (const f of CONTACT_FIELDS) {
      if (!(f.key in input)) continue;
      const slot = slots[f.key];
      if (!slot) continue;
      const v = input[f.key];
      cells[String(slot)] = v === undefined || v === null || v === "" ? null : v;
    }
    return cells;
  }

  function toDto(
    workspaceId: string,
    slots: Partial<Record<ContactKey, number>>,
    r: { id: string; cells: Record<string, unknown>; created_at: Date; updated_at: Date },
  ) {
    const get = (k: ContactKey) => {
      const slot = slots[k];
      const v = slot ? r.cells[String(slot)] : undefined;
      return typeof v === "string" ? v : v == null ? null : String(v);
    };
    return {
      id: pid("rec", r.id),
      workspaceId: pid("wsp", workspaceId),
      name: get("name") ?? "",
      email: get("email"),
      phone: get("phone"),
      company: get("company"),
      title: get("title"),
      notes: get("notes"),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  async function loadContact(tableId: string, recordId: string) {
    const r = await sql<{ id: string; cells: Record<string, unknown>; created_at: Date; updated_at: Date }>`
      SELECT id, cells, created_at, updated_at FROM data.records
      WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL LIMIT 1
    `.execute(ctx.db);
    return r.rows[0] ?? null;
  }

  app.get<{ Params: { workspaceId: string }; Querystring: { q?: string } }>(
    "/v1/workspaces/:workspaceId/contacts",
    async (request, reply) => {
      try {
        const scope = await directoryScope(request, reply);
        if (!scope) return;
        const { directory, slots, workspaceId } = scope;
        const q = request.query.q?.trim();
        const searchSlots = (["name", "email", "company", "phone"] as const)
          .map((k) => slots[k])
          .filter((s): s is number => Boolean(s))
          .map(String);
        const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
        const records = await sql<{ id: string; cells: Record<string, unknown>; created_at: Date; updated_at: Date }>`
          SELECT id, cells, created_at, updated_at
          FROM data.records r
          WHERE table_id = ${directory.contactsTableId} AND deleted_at IS NULL
            ${
              pattern && searchSlots.length
                ? sql`AND EXISTS (
                    SELECT 1 FROM unnest(${searchSlots}::text[]) s
                    WHERE r.cells ->> s ILIKE ${pattern}
                  )`
                : sql``
            }
          ORDER BY lower(COALESCE(r.cells ->> ${String(slots.name ?? 1)}, '')) ASC, created_at DESC
          LIMIT 1000
        `.execute(ctx.db);
        void reply.send({
          contactDirectoryBaseId: pid("bas", directory.baseId),
          contactsTableId: pid("tbl", directory.contactsTableId),
          contacts: records.rows.map((r) => toDto(workspaceId, slots, r)),
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/contacts",
    async (request, reply) => {
      try {
        const scope = await directoryScope(request, reply);
        if (!scope) return;
        const body = contactInput.parse(request.body);
        if (!body.name?.trim() && !body.email?.trim()) {
          validationProblem(request, reply, "A contact needs a name or an email");
          return;
        }
        if (body.email && !EMAIL_RE.test(body.email)) {
          validationProblem(request, reply, "Enter a valid email address", [
            { field: "email", message: "Enter a valid email address" },
          ]);
          return;
        }
        const cells = Object.fromEntries(
          Object.entries(toCells(scope.slots, body)).filter(([, v]) => v !== null),
        );
        const [id] = await createRecordsBySlot(ctx, scope.writeScope, [cells]);
        const row = id ? await loadContact(scope.directory.contactsTableId, id) : null;
        void reply.code(201).send({ contact: row ? toDto(scope.workspaceId, scope.slots, row) : null });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { workspaceId: string; contactId: string } }>(
    "/v1/workspaces/:workspaceId/contacts/:contactId",
    async (request, reply) => {
      try {
        const scope = await directoryScope(request, reply);
        if (!scope) return;
        const contactId = parsePid(request.params.contactId, "rec");
        const existing = await loadContact(scope.directory.contactsTableId, contactId);
        if (!existing) {
          notFound(request, reply, "Contact not found");
          return;
        }
        const body = contactInput.parse(request.body);
        if (body.email && !EMAIL_RE.test(body.email)) {
          validationProblem(request, reply, "Enter a valid email address", [
            { field: "email", message: "Enter a valid email address" },
          ]);
          return;
        }
        await updateRecordBySlot(ctx, scope.writeScope, contactId, toCells(scope.slots, body));
        const row = await loadContact(scope.directory.contactsTableId, contactId);
        void reply.send({ contact: row ? toDto(scope.workspaceId, scope.slots, row) : null });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { workspaceId: string; contactId: string } }>(
    "/v1/workspaces/:workspaceId/contacts/:contactId",
    async (request, reply) => {
      try {
        const scope = await directoryScope(request, reply);
        if (!scope) return;
        const contactId = parsePid(request.params.contactId, "rec");
        const n = await softDeleteRecords(ctx, scope.writeScope, [contactId]);
        if (n === 0) {
          notFound(request, reply, "Contact not found");
          return;
        }
        void reply.code(204).send();
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/contacts/merge",
    async (request, reply) => {
      try {
        const scope = await directoryScope(request, reply);
        if (!scope) return;
        const body = z
          .object({ survivorContactId: z.string(), mergedContactId: z.string() })
          .parse(request.body);
        const survivorId = parsePid(body.survivorContactId, "rec");
        const mergedId = parsePid(body.mergedContactId, "rec");
        if (survivorId === mergedId) {
          validationProblem(request, reply, "Pick two different contacts");
          return;
        }
        const tableId = scope.directory.contactsTableId;
        const survivor = await loadContact(tableId, survivorId);
        const merged = await loadContact(tableId, mergedId);
        if (!survivor || !merged) {
          notFound(request, reply, "Contact not found");
          return;
        }

        // Fill the survivor's empty cells from the merged contact.
        const patch: Record<string, unknown> = {};
        for (const [slot, v] of Object.entries(merged.cells)) {
          const cur = survivor.cells[slot];
          if ((cur === undefined || cur === null || cur === "") && v !== null && v !== "") patch[slot] = v;
        }
        if (Object.keys(patch).length) {
          await updateRecordBySlot(ctx, scope.writeScope, survivorId, patch);
        }

        // Re-point links (any relation) from the merged contact to the survivor.
        let relinked = 0;
        await ctx.db.transaction().execute(async (trx) => {
          const a = await sql`
            UPDATE data.record_links l SET a_record_id = ${survivorId}
            WHERE l.a_record_id = ${mergedId}
              AND NOT EXISTS (
                SELECT 1 FROM data.record_links x
                WHERE x.relation_id = l.relation_id AND x.a_record_id = ${survivorId} AND x.b_record_id = l.b_record_id
              )
          `.execute(trx);
          const b = await sql`
            UPDATE data.record_links l SET b_record_id = ${survivorId}
            WHERE l.b_record_id = ${mergedId}
              AND NOT EXISTS (
                SELECT 1 FROM data.record_links x
                WHERE x.relation_id = l.relation_id AND x.b_record_id = ${survivorId} AND x.a_record_id = l.a_record_id
              )
          `.execute(trx);
          relinked = Number(a.numAffectedRows ?? 0) + Number(b.numAffectedRows ?? 0);
          // Leftovers would be duplicates of existing survivor links.
          await sql`
            DELETE FROM data.record_links WHERE a_record_id = ${mergedId} OR b_record_id = ${mergedId}
          `.execute(trx);
          await sql`
            INSERT INTO data.contact_merge_events (
              id, workspace_id, survivor_contact_id, merged_contact_id, performed_by
            ) VALUES (
              ${generateUuidV7()}, ${scope.workspaceId}, ${survivorId}, ${mergedId}, ${scope.user.id}
            )
          `.execute(trx);
        });
        await softDeleteRecords(ctx, scope.writeScope, [mergedId]);

        const fresh = await loadContact(tableId, survivorId);
        void reply.send({
          ok: true,
          survivorContactId: pid("rec", survivorId),
          relinked,
          contact: fresh ? toDto(scope.workspaceId, scope.slots, fresh) : null,
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );
}
