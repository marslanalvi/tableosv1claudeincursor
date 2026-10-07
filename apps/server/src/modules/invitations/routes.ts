import { generateUuidV7 } from "@tabula/types";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  mapWorkspaceRoleToBase,
  type BaseRole,
  type WorkspaceRole,
} from "@tabula/permissions";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import {
  forbidden,
  handleRouteError,
  notFound,
  sendApiError,
  unauthorized,
  validationProblem,
} from "../../http/errors.js";
import { writeAuditEvent } from "../audit/write.js";
import { compileForUser, invalidateUserSnapshotCache } from "../access/compile.js";
import {
  BASE_ROLE_RANK,
  WORKSPACE_ROLE_RANK,
  getWorkspaceAccess,
  workspaceRoleCanManageMembers,
} from "../access/workspace-access.js";
import { sendEmail } from "../automations/mailer.js";

const WORKSPACE_ROLES = ["owner", "creator", "editor", "commenter", "viewer"] as const;
const BASE_ROLES = ["creator", "editor", "commenter", "viewer"] as const;

const createInviteBody = z
  .object({
    email: z.string().email().max(320),
    workspaceId: z.string().optional(),
    baseId: z.string().optional(),
    role: z.enum(WORKSPACE_ROLES),
  })
  .refine((b) => Boolean(b.workspaceId) !== Boolean(b.baseId), {
    message: "Provide exactly one of workspaceId or baseId",
  });

const acceptBody = z.object({
  token: z.string().min(16).max(512),
});

function hashInviteToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

interface InviteRow {
  id: string;
  org_id: string;
  workspace_id: string | null;
  base_id: string | null;
  email: string;
  email_normalized: string;
  role: string;
  status: string;
  expires_at: Date;
  invited_by: string | null;
  created_at: Date;
}

function inviteDto(row: InviteRow) {
  return {
    id: pid("inv", row.id),
    email: row.email,
    workspaceId: row.workspace_id ? pid("wsp", row.workspace_id) : null,
    baseId: row.base_id ? pid("bas", row.base_id) : null,
    role: row.role,
    status: row.status === "pending" && row.expires_at < new Date() ? "expired" : row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export async function registerInvitationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  /**
   * Invite someone to a workspace (role ∈ workspace roles) or a base
   * (role ∈ creator/editor/commenter/viewer). The inviter must be able to
   * manage members there and cannot grant a role above their own.
   */
  app.post("/v1/invitations", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        unauthorized(request, reply);
        return;
      }
      const body = createInviteBody.parse(request.body);

      let orgId: string;
      let workspaceId: string;
      let baseId: string | null = null;
      let targetName: string;

      if (body.baseId) {
        baseId = parsePid(body.baseId, "bas");
        const dir = await sql<{ workspace_id: string; org_id: string; name: string }>`
          SELECT workspace_id, org_id, name FROM core.base_directory
          WHERE base_id = ${baseId} AND status = 'active' AND deleted_at IS NULL LIMIT 1
        `.execute(ctx.db);
        const d = dir.rows[0];
        const snap = d ? await compileForUser(ctx.db, user.id, baseId) : null;
        if (!d || !snap?.effectiveBaseRole) {
          notFound(request, reply, "Base not found");
          return;
        }
        if (!(BASE_ROLES as readonly string[]).includes(body.role)) {
          validationProblem(request, reply, `Role "${body.role}" is not a base role`);
          return;
        }
        const mine = snap.effectiveBaseRole;
        if (mine !== "creator") {
          forbidden(request, reply, "Only base creators can invite collaborators");
          return;
        }
        if (BASE_ROLE_RANK[body.role as BaseRole] > BASE_ROLE_RANK[mine]) {
          forbidden(request, reply, "You cannot grant a role above your own");
          return;
        }
        orgId = d.org_id;
        workspaceId = d.workspace_id;
        targetName = d.name;
      } else {
        workspaceId = parsePid(body.workspaceId!, "wsp");
        const access = await getWorkspaceAccess(ctx.db, user.id, workspaceId);
        if (!access || !access.workspaceRole) {
          notFound(request, reply, "Workspace not found");
          return;
        }
        if (!workspaceRoleCanManageMembers(access.workspaceRole)) {
          forbidden(request, reply, "Only workspace owners and creators can invite members");
          return;
        }
        if (WORKSPACE_ROLE_RANK[body.role as WorkspaceRole] > WORKSPACE_ROLE_RANK[access.workspaceRole]) {
          forbidden(request, reply, "You cannot grant a role above your own");
          return;
        }
        orgId = access.orgId;
        const ws = await sql<{ name: string }>`
          SELECT name FROM core.workspaces WHERE id = ${workspaceId}
        `.execute(ctx.db);
        targetName = ws.rows[0]?.name ?? "a workspace";
      }

      const emailNormalized = body.email.toLowerCase();
      const pending = await sql<{ id: string }>`
        SELECT id FROM core.invitations
        WHERE email_normalized = ${emailNormalized} AND status = 'pending' AND expires_at > now()
          AND workspace_id = ${workspaceId}
          AND base_id IS NOT DISTINCT FROM ${baseId}::uuid
        LIMIT 1
      `.execute(ctx.db);
      if (pending.rows[0]) {
        // Re-inviting replaces the previous pending invitation.
        await sql`
          UPDATE core.invitations SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE id = ${pending.rows[0].id}
        `.execute(ctx.db);
      }

      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashInviteToken(token);
      const inviteId = generateUuidV7();
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

      await sql`
        INSERT INTO core.invitations (
          id, org_id, workspace_id, base_id, email, email_normalized, role,
          resource_type, resource_id, token_hash, invited_by, expires_at
        ) VALUES (
          ${inviteId}, ${orgId}, ${workspaceId}, ${baseId}, ${body.email}, ${emailNormalized},
          ${body.role}, ${baseId ? "base" : "workspace"}, ${baseId ?? workspaceId},
          ${tokenHash}, ${user.id}, ${expiresAt}
        )
      `.execute(ctx.db);

      const acceptUrl = `${ctx.env.APP_URL}/invite/${token}`;
      try {
        await sendEmail(ctx.db, {
          to: [body.email],
          subject: `${user.displayName} invited you to ${targetName} on TableOS`,
          text: `${user.displayName} (${user.email}) invited you to join "${targetName}" as ${body.role}.\n\nAccept the invitation: ${acceptUrl}\n\nThis link expires on ${expiresAt.toUTCString()}.`,
          orgId,
          workspaceId,
          source: "invitation",
          sourceId: inviteId,
        });
      } catch (err) {
        request.log.warn({ err }, "invitation email not stored");
      }

      await writeAuditEvent(ctx.db, {
        orgId,
        workspaceId,
        actorUserId: user.id,
        action: "invite.created",
        targetType: "invitation",
        targetId: inviteId,
        metadata: { email: emailNormalized, role: body.role, baseId },
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      void reply.code(201).send({
        invitation: {
          id: pid("inv", inviteId),
          email: body.email,
          workspaceId: pid("wsp", workspaceId),
          baseId: baseId ? pid("bas", baseId) : null,
          role: body.role,
          status: "pending",
          expiresAt: expiresAt.toISOString(),
          acceptToken: token,
          acceptUrl,
        },
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  /** Pending/past invitations of a workspace (or base) — members managers only. */
  app.get<{ Querystring: { workspaceId?: string; baseId?: string } }>(
    "/v1/invitations",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          unauthorized(request, reply);
          return;
        }
        let rows: InviteRow[];
        if (request.query.baseId) {
          const baseId = parsePid(request.query.baseId, "bas");
          const snap = await compileForUser(ctx.db, user.id, baseId);
          if (!snap.effectiveBaseRole) {
            notFound(request, reply, "Base not found");
            return;
          }
          if (snap.effectiveBaseRole !== "creator") {
            forbidden(request, reply, "Missing permission: base.manage_members");
            return;
          }
          rows = (
            await sql<InviteRow>`
              SELECT id, org_id, workspace_id, base_id, email, email_normalized, role, status,
                     expires_at, invited_by, created_at
              FROM core.invitations WHERE base_id = ${baseId}
              ORDER BY created_at DESC LIMIT 200
            `.execute(ctx.db)
          ).rows;
        } else if (request.query.workspaceId) {
          const workspaceId = parsePid(request.query.workspaceId, "wsp");
          const access = await getWorkspaceAccess(ctx.db, user.id, workspaceId);
          if (!access?.workspaceRole) {
            notFound(request, reply, "Workspace not found");
            return;
          }
          if (!workspaceRoleCanManageMembers(access.workspaceRole)) {
            forbidden(request, reply, "Only workspace owners and creators can view invitations");
            return;
          }
          rows = (
            await sql<InviteRow>`
              SELECT id, org_id, workspace_id, base_id, email, email_normalized, role, status,
                     expires_at, invited_by, created_at
              FROM core.invitations WHERE workspace_id = ${workspaceId}
              ORDER BY created_at DESC LIMIT 200
            `.execute(ctx.db)
          ).rows;
        } else {
          validationProblem(request, reply, "workspaceId or baseId is required");
          return;
        }
        void reply.send({ invitations: rows.map(inviteDto) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  /** Revoke a pending invitation. */
  app.delete<{ Params: { invitationId: string } }>(
    "/v1/invitations/:invitationId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          unauthorized(request, reply);
          return;
        }
        const id = parsePid(request.params.invitationId, "inv");
        const res = await sql<InviteRow>`
          SELECT id, org_id, workspace_id, base_id, email, email_normalized, role, status,
                 expires_at, invited_by, created_at
          FROM core.invitations WHERE id = ${id} LIMIT 1
        `.execute(ctx.db);
        const row = res.rows[0];
        if (!row) {
          notFound(request, reply, "Invitation not found");
          return;
        }
        let allowed = row.invited_by === user.id;
        if (!allowed && row.base_id) {
          const snap = await compileForUser(ctx.db, user.id, row.base_id);
          allowed = snap.effectiveBaseRole === "creator";
        }
        if (!allowed && row.workspace_id) {
          const access = await getWorkspaceAccess(ctx.db, user.id, row.workspace_id);
          allowed = workspaceRoleCanManageMembers(access?.workspaceRole ?? null);
        }
        if (!allowed) {
          notFound(request, reply, "Invitation not found");
          return;
        }
        await sql`
          UPDATE core.invitations SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE id = ${id} AND status = 'pending'
        `.execute(ctx.db);
        await writeAuditEvent(ctx.db, {
          orgId: row.org_id,
          workspaceId: row.workspace_id,
          actorUserId: user.id,
          action: "invite.revoked",
          targetType: "invitation",
          targetId: id,
          ip: request.ip,
        });
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  /** Public preview of an invitation (for the accept page, before sign-in). */
  app.get<{ Params: { token: string } }>(
    "/v1/public/invitations/:token",
    async (request, reply) => {
      try {
        const token = request.params.token;
        if (token.length < 16 || token.length > 512) {
          notFound(request, reply, "Invitation not found");
          return;
        }
        const res = await sql<InviteRow & { workspace_name: string | null; base_name: string | null; inviter_name: string | null }>`
          SELECT i.id, i.org_id, i.workspace_id, i.base_id, i.email, i.email_normalized, i.role,
                 i.status, i.expires_at, i.invited_by, i.created_at,
                 w.name AS workspace_name, bd.name AS base_name, u.display_name AS inviter_name
          FROM core.invitations i
          LEFT JOIN core.workspaces w ON w.id = i.workspace_id
          LEFT JOIN core.base_directory bd ON bd.base_id = i.base_id
          LEFT JOIN core.users u ON u.id = i.invited_by
          WHERE i.token_hash = ${hashInviteToken(token)}
          LIMIT 1
        `.execute(ctx.db);
        const row = res.rows[0];
        if (!row) {
          notFound(request, reply, "Invitation not found");
          return;
        }
        const dto = inviteDto(row);
        void reply.send({
          invitation: {
            ...dto,
            workspaceName: row.workspace_name,
            baseName: row.base_name,
            inviterName: row.inviter_name,
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post("/v1/invitations/accept", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        unauthorized(request, reply);
        return;
      }
      const body = acceptBody.parse(request.body);
      const tokenHash = hashInviteToken(body.token);

      const invite = await sql<InviteRow>`
        SELECT id, org_id, workspace_id, base_id, email, email_normalized, role, status,
               expires_at, invited_by, created_at
        FROM core.invitations
        WHERE token_hash = ${tokenHash}
        LIMIT 1
      `.execute(ctx.db);

      const row = invite.rows[0];
      if (!row) {
        notFound(request, reply, "Invitation not found");
        return;
      }
      if (row.status === "accepted") {
        sendApiError(request, reply, 409, "CONFLICT", "This invitation has already been accepted");
        return;
      }
      if (row.status !== "pending" || row.expires_at < new Date()) {
        sendApiError(request, reply, 410, "INVITATION_EXPIRED", "This invitation has expired or was revoked");
        return;
      }
      if (row.email_normalized !== user.email.toLowerCase()) {
        forbidden(
          request,
          reply,
          `This invitation was sent to ${row.email}. Sign in with that email to accept it.`,
        );
        return;
      }

      await ctx.db.transaction().execute(async (trx) => {
        await sql`
          INSERT INTO core.organization_members (org_id, user_id, role, source)
          VALUES (${row.org_id}, ${user.id}, 'member', 'invite')
          ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active', updated_at = now()
        `.execute(trx);

        if (row.base_id) {
          const baseRole = row.role as BaseRole;
          const existing = await sql<{ id: string; role: string }>`
            SELECT id, role FROM core.access_grants
            WHERE resource_type = 'base' AND resource_id = ${row.base_id}
              AND principal_type = 'user' AND principal_id = ${user.id}
            LIMIT 1
          `.execute(trx);
          const cur = existing.rows[0];
          if (!cur) {
            await sql`
              INSERT INTO core.access_grants (
                id, org_id, resource_type, resource_id, workspace_id, base_id,
                principal_type, principal_id, role, source, granted_by
              ) VALUES (
                ${generateUuidV7()}, ${row.org_id}, 'base', ${row.base_id}, ${row.workspace_id}, ${row.base_id},
                'user', ${user.id}, ${baseRole}, 'invite', ${row.invited_by}
              )
            `.execute(trx);
          } else if (BASE_ROLE_RANK[baseRole] > (BASE_ROLE_RANK[cur.role as BaseRole] ?? 0)) {
            await sql`
              UPDATE core.access_grants SET role = ${baseRole}, updated_at = now() WHERE id = ${cur.id}
            `.execute(trx);
          }
          await sql`
            UPDATE data.base_runtime SET perm_epoch = perm_epoch + 1, updated_at = now()
            WHERE base_id = ${row.base_id}
          `.execute(trx);
        } else if (row.workspace_id) {
          const wsRole = row.role as WorkspaceRole;
          const existing = await sql<{ id: string; role: string }>`
            SELECT id, role FROM core.access_grants
            WHERE resource_type = 'workspace' AND resource_id = ${row.workspace_id}
              AND principal_type = 'user' AND principal_id = ${user.id}
            LIMIT 1
          `.execute(trx);
          const cur = existing.rows[0];
          if (!cur) {
            await sql`
              INSERT INTO core.access_grants (
                id, org_id, resource_type, resource_id, workspace_id,
                principal_type, principal_id, role, source, granted_by
              ) VALUES (
                ${generateUuidV7()}, ${row.org_id}, 'workspace', ${row.workspace_id}, ${row.workspace_id},
                'user', ${user.id}, ${wsRole}, 'invite', ${row.invited_by}
              )
            `.execute(trx);
          } else if (WORKSPACE_ROLE_RANK[wsRole] > (WORKSPACE_ROLE_RANK[cur.role as WorkspaceRole] ?? 0)) {
            await sql`
              UPDATE core.access_grants SET role = ${wsRole}, updated_at = now() WHERE id = ${cur.id}
            `.execute(trx);
          }
          await sql`
            UPDATE data.base_runtime SET perm_epoch = perm_epoch + 1, updated_at = now()
            WHERE base_id IN (
              SELECT base_id FROM core.base_directory WHERE workspace_id = ${row.workspace_id}
            )
          `.execute(trx);
        }

        await sql`
          UPDATE core.invitations
          SET status = 'accepted', accepted_at = now(), accepted_by = ${user.id}, updated_at = now()
          WHERE id = ${row.id}
        `.execute(trx);
      });
      invalidateUserSnapshotCache(user.id);

      await writeAuditEvent(ctx.db, {
        orgId: row.org_id,
        workspaceId: row.workspace_id,
        actorUserId: user.id,
        action: "invite.accepted",
        targetType: "invitation",
        targetId: row.id,
        metadata: { role: row.role, baseId: row.base_id },
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      void reply.send({
        ok: true,
        workspaceId: row.workspace_id ? pid("wsp", row.workspace_id) : null,
        baseId: row.base_id ? pid("bas", row.base_id) : null,
        role: row.role,
        effectiveBaseRole: row.base_id ? row.role : mapWorkspaceRoleToBase(row.role as WorkspaceRole),
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });
}
