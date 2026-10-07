import { CommentEvents } from "@tabula/events";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { publishDomainEvent } from "../../lib/domain-event.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { forbidden, notFound, validationProblem } from "../../http/errors.js";
import { resolveBaseContext, resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { handleWave4Error } from "../wave4/problems.js";
import { createNotifications, recordLink, recordTitle, type NewNotification } from "../notifications/create.js";
import { parseMentions, plainTextBody } from "./mentions.js";

const commentBody = z.object({
  body: z.string().trim().min(1).max(10000),
  parentId: z.string().nullish(),
});

interface CommentRow {
  id: string;
  parent_id: string | null;
  body: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date | null;
  author_name: string | null;
  author_email: string | null;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export async function registerCommentsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  async function recordScope(
    request: FastifyRequest<{ Params: { baseId: string; tableId: string; recordId: string } }>,
    reply: FastifyReply,
  ) {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return null;
    }
    const baseId = parsePid(request.params.baseId, "bas");
    const tableId = parsePid(request.params.tableId, "tbl");
    const recordId = parsePid(request.params.recordId, "rec");
    const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
    if (!table.ok) {
      notFound(request, reply, "Table not found");
      return null;
    }
    const rec = await sql<{ id: string }>`
      SELECT id FROM data.records
      WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL LIMIT 1
    `.execute(ctx.db);
    if (!rec.rows[0]) {
      notFound(request, reply, "Record not found");
      return null;
    }
    const snapshot = await compileForUser(ctx.db, user.id, baseId);
    assertCan(snapshot, "record.read");
    return { user, baseId, tableId, recordId, table, snapshot };
  }

  async function serializeComments(rows: CommentRow[], viewerId: string) {
    const ids = rows.map((r) => r.id);
    const reactions = ids.length
      ? await sql<{ comment_id: string; emoji: string; user_id: string; name: string | null }>`
          SELECT cr.comment_id, cr.emoji, cr.user_id, u.display_name AS name
          FROM data.comment_reactions cr
          LEFT JOIN core.users u ON u.id = cr.user_id
          WHERE cr.comment_id = ANY(${ids}::uuid[])
          ORDER BY cr.created_at ASC
        `.execute(ctx.db)
      : { rows: [] };
    const mentions = ids.length
      ? await sql<{ comment_id: string; principal_id: string; name: string | null; email: string | null }>`
          SELECT m.comment_id, m.principal_id, u.display_name AS name, u.email
          FROM data.mentions m
          LEFT JOIN core.users u ON u.id = m.principal_id
          WHERE m.comment_id = ANY(${ids}::uuid[]) AND m.principal_type = 'user'
        `.execute(ctx.db)
      : { rows: [] };

    return rows.map((c) => {
      const byEmoji = new Map<string, { emoji: string; count: number; userIds: string[]; userNames: string[]; reactedByMe: boolean }>();
      for (const r of reactions.rows.filter((x) => x.comment_id === c.id)) {
        const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [], userNames: [], reactedByMe: false };
        entry.count += 1;
        entry.userIds.push(pid("usr", r.user_id));
        entry.userNames.push(r.name ?? "");
        if (r.user_id === viewerId) entry.reactedByMe = true;
        byEmoji.set(r.emoji, entry);
      }
      const authorName = c.author_name || c.author_email || "Unknown user";
      return {
        id: pid("cmt", c.id),
        parentId: c.parent_id ? pid("cmt", c.parent_id) : null,
        body: c.body,
        createdBy: c.created_by ? pid("usr", c.created_by) : null,
        author: c.created_by
          ? {
              id: pid("usr", c.created_by),
              name: authorName,
              email: c.author_email ?? "",
              initials: initials(authorName),
            }
          : null,
        authorName,
        createdAt: c.created_at.toISOString(),
        updatedAt: c.updated_at?.toISOString() ?? null,
        edited: Boolean(c.updated_at),
        isMine: c.created_by === viewerId,
        reactions: [...byEmoji.values()],
        mentions: mentions.rows
          .filter((m) => m.comment_id === c.id)
          .map((m) => ({ id: pid("usr", m.principal_id), name: m.name || m.email || "", email: m.email ?? "" })),
      };
    });
  }

  const COMMENT_SELECT = sql`
    SELECT c.id, c.parent_id, c.body, c.created_by, c.created_at, c.updated_at,
           u.display_name AS author_name, u.email AS author_email
    FROM data.comments c
    LEFT JOIN core.users u ON u.id = c.created_by
  `;

  app.get<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/comments",
    async (request, reply) => {
      try {
        const scope = await recordScope(request, reply);
        if (!scope) return;
        const rows = await sql<CommentRow>`
          ${COMMENT_SELECT}
          WHERE c.base_id = ${scope.baseId} AND c.table_id = ${scope.tableId}
            AND c.record_id = ${scope.recordId} AND c.deleted_at IS NULL
          ORDER BY c.created_at ASC, c.id ASC
        `.execute(ctx.db);
        void reply.send({ comments: await serializeComments(rows.rows, scope.user.id) });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/comments",
    async (request, reply) => {
      try {
        const scope = await recordScope(request, reply);
        if (!scope) return;
        const { user, baseId, tableId, recordId, table, snapshot } = scope;
        assertCan(snapshot, "record.comment");
        const body = commentBody.parse(request.body);
        const commentId = generateUuidV7();
        let parentId: string | null = null;
        let parentAuthor: string | null = null;
        if (body.parentId) {
          parentId = parsePid(body.parentId, "cmt");
          const parent = await sql<{ created_by: string | null }>`
            SELECT created_by FROM data.comments
            WHERE id = ${parentId} AND record_id = ${recordId} AND deleted_at IS NULL LIMIT 1
          `.execute(ctx.db);
          if (!parent.rows[0]) {
            validationProblem(request, reply, "Parent comment not found on this record");
            return;
          }
          parentAuthor = parent.rows[0].created_by;
        }

        // Only users in the base's organization can be mentioned.
        const parsed = parseMentions(body.body).filter((m) => m.principalType === "user");
        const mentionIds = parsed.length
          ? (
              await sql<{ user_id: string }>`
                SELECT m.user_id FROM core.organization_members m
                WHERE m.org_id = ${table.orgId} AND m.status = 'active'
                  AND m.user_id = ANY(${parsed.map((p) => p.principalId)}::uuid[])
              `.execute(ctx.db)
            ).rows.map((r) => r.user_id)
          : [];

        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            INSERT INTO data.comments (
              id, workspace_id, base_id, table_id, record_id, parent_id, body, created_by
            ) VALUES (
              ${commentId}, ${table.workspaceId}, ${baseId}, ${tableId}, ${recordId},
              ${parentId}, ${body.body}, ${user.id}
            )
          `.execute(trx);
          await sql`
            INSERT INTO data.record_subscriptions (workspace_id, base_id, table_id, record_id, user_id)
            VALUES (${table.workspaceId}, ${baseId}, ${tableId}, ${recordId}, ${user.id})
            ON CONFLICT DO NOTHING
          `.execute(trx);
          for (const id of mentionIds) {
            await sql`
              INSERT INTO data.mentions (id, comment_id, principal_type, principal_id)
              VALUES (${generateUuidV7()}, ${commentId}, 'user', ${id})
            `.execute(trx);
          }
        });

        // Notifications (inline: mentions > reply > subscribers; never the author).
        try {
          const title = await recordTitle(ctx.db, tableId, recordId);
          const actorName = user.displayName || user.email;
          const text = plainTextBody(body.body);
          const link = recordLink(baseId, tableId, recordId, { comment: pid("cmt", commentId) });
          const notified = new Set<string>([user.id]);
          const items: NewNotification[] = [];
          const add = (userId: string, category: NewNotification["category"], t: string) => {
            if (notified.has(userId)) return;
            notified.add(userId);
            items.push({
              userId,
              workspaceId: table.workspaceId,
              baseId,
              category,
              title: t,
              text,
              link,
              actorUserId: user.id,
              data: {
                commentId: pid("cmt", commentId),
                recordId: pid("rec", recordId),
                tableId: pid("tbl", tableId),
              },
            });
          };
          for (const id of mentionIds) add(id, "mention", `${actorName} mentioned you on “${title}”`);
          if (parentAuthor) add(parentAuthor, "reply", `${actorName} replied to your comment on “${title}”`);
          const subs = await sql<{ user_id: string }>`
            SELECT user_id FROM data.record_subscriptions
            WHERE base_id = ${baseId} AND table_id = ${tableId} AND record_id = ${recordId}
          `.execute(ctx.db);
          for (const s of subs.rows) add(s.user_id, "comment", `${actorName} commented on “${title}”`);
          await createNotifications(ctx.db, items);
        } catch (err) {
          request.log.warn({ err }, "comment notifications failed");
        }

        await publishDomainEvent(ctx.eventBus, {
          type: CommentEvents.CREATED,
          tenant: { orgId: table.orgId, workspaceId: table.workspaceId, baseId },
          actor: { type: "user", id: user.id, via: "api" },
          data: { commentId, recordId, tableId, notificationsCreated: true },
        }).catch(() => undefined);

        const rows = await sql<CommentRow>`${COMMENT_SELECT} WHERE c.id = ${commentId}`.execute(ctx.db);
        const [comment] = await serializeComments(rows.rows, user.id);
        void reply.code(201).send({ comment });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  async function commentScope(
    request: FastifyRequest<{ Params: { baseId: string; commentId: string } }>,
    reply: FastifyReply,
  ) {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return null;
    }
    const baseId = parsePid(request.params.baseId, "bas");
    const commentId = parsePid(request.params.commentId, "cmt");
    const base = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!base.ok) {
      notFound(request, reply, "Base not found");
      return null;
    }
    const snapshot = await compileForUser(ctx.db, user.id, baseId);
    assertCan(snapshot, "record.read");
    const c = await sql<{ id: string; created_by: string | null }>`
      SELECT id, created_by FROM data.comments
      WHERE id = ${commentId} AND base_id = ${baseId} AND deleted_at IS NULL LIMIT 1
    `.execute(ctx.db);
    const comment = c.rows[0];
    if (!comment) {
      notFound(request, reply, "Comment not found");
      return null;
    }
    return { user, baseId, commentId, comment, snapshot };
  }

  app.patch<{ Params: { baseId: string; commentId: string } }>(
    "/v1/bases/:baseId/comments/:commentId",
    async (request, reply) => {
      try {
        const scope = await commentScope(request, reply);
        if (!scope) return;
        if (scope.comment.created_by !== scope.user.id) {
          forbidden(request, reply, "You can only edit your own comments");
          return;
        }
        const body = z.object({ body: z.string().trim().min(1).max(10000) }).parse(request.body);
        const mentionIds = parseMentions(body.body)
          .filter((m) => m.principalType === "user")
          .map((m) => m.principalId);
        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            UPDATE data.comments SET body = ${body.body}, updated_at = now()
            WHERE id = ${scope.commentId}
          `.execute(trx);
          await sql`DELETE FROM data.mentions WHERE comment_id = ${scope.commentId}`.execute(trx);
          if (mentionIds.length) {
            await sql`
              INSERT INTO data.mentions (id, comment_id, principal_type, principal_id)
              SELECT uuidv7(), ${scope.commentId}, 'user', m.user_id
              FROM core.organization_members m
              JOIN core.base_directory bd ON bd.org_id = m.org_id AND bd.base_id = ${scope.baseId}
              WHERE m.status = 'active' AND m.user_id = ANY(${mentionIds}::uuid[])
            `.execute(trx);
          }
        });
        const rows = await sql<CommentRow>`${COMMENT_SELECT} WHERE c.id = ${scope.commentId}`.execute(ctx.db);
        const [comment] = await serializeComments(rows.rows, scope.user.id);
        void reply.send({ comment });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; commentId: string } }>(
    "/v1/bases/:baseId/comments/:commentId",
    async (request, reply) => {
      try {
        const scope = await commentScope(request, reply);
        if (!scope) return;
        if (scope.comment.created_by !== scope.user.id) {
          forbidden(request, reply, "You can only delete your own comments");
          return;
        }
        await sql`
          UPDATE data.comments SET deleted_at = now()
          WHERE id = ${scope.commentId} OR parent_id = ${scope.commentId}
        `.execute(ctx.db);
        void reply.code(204).send();
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  const reactionBody = z.object({ emoji: z.string().min(1).max(32), toggle: z.boolean().optional() });

  app.post<{ Params: { baseId: string; commentId: string } }>(
    "/v1/bases/:baseId/comments/:commentId/reactions",
    async (request, reply) => {
      try {
        const scope = await commentScope(request, reply);
        if (!scope) return;
        assertCan(scope.snapshot, "record.comment");
        const body = reactionBody.parse(request.body);
        let active = true;
        if (body.toggle) {
          const del = await sql`
            DELETE FROM data.comment_reactions
            WHERE comment_id = ${scope.commentId} AND user_id = ${scope.user.id} AND emoji = ${body.emoji}
          `.execute(ctx.db);
          if (Number(del.numAffectedRows ?? 0) > 0) active = false;
        }
        if (active) {
          await sql`
            INSERT INTO data.comment_reactions (comment_id, user_id, emoji)
            VALUES (${scope.commentId}, ${scope.user.id}, ${body.emoji})
            ON CONFLICT (comment_id, user_id, emoji) DO NOTHING
          `.execute(ctx.db);
        }
        void reply.code(active ? 201 : 200).send({ ok: true, active });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; commentId: string; emoji: string } }>(
    "/v1/bases/:baseId/comments/:commentId/reactions/:emoji",
    async (request, reply) => {
      try {
        const scope = await commentScope(request, reply);
        if (!scope) return;
        await sql`
          DELETE FROM data.comment_reactions
          WHERE comment_id = ${scope.commentId} AND user_id = ${scope.user.id}
            AND emoji = ${decodeURIComponent(request.params.emoji)}
        `.execute(ctx.db);
        void reply.code(204).send();
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );
}
