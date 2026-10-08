import type { TabulaDb } from "@tabula/db";
import {
  maxWorkspaceRole,
  type BaseRole,
  type WorkspaceRole,
} from "@tabula/permissions";
import { sql } from "kysely";
import { requestMayAccess } from "../../kernel/request-context.js";

export type OrgRole = "owner" | "admin" | "billing_admin" | "member" | "guest";

export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 50,
  creator: 40,
  editor: 30,
  commenter: 20,
  viewer: 10,
};

export const BASE_ROLE_RANK: Record<BaseRole, number> = {
  creator: 40,
  editor: 30,
  commenter: 20,
  viewer: 10,
  interface_only: 5,
};

/** Org owners/admins manage every workspace in their org. */
export function orgRoleGrantsWorkspaceOwner(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export interface WorkspaceAccess {
  orgId: string;
  orgRole: OrgRole;
  /** Effective workspace role (explicit grant, or `owner` for org owner/admin). Null = no workspace access. */
  workspaceRole: WorkspaceRole | null;
}

/**
 * Resolve a user's effective role on a workspace. Org membership alone does
 * NOT grant workspace access: the user needs a workspace grant, or must be an
 * org owner/admin.
 */
export async function getWorkspaceAccess(
  db: TabulaDb,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceAccess | null> {
  const res = await sql<{ org_id: string; org_role: string; grant_role: string | null }>`
    SELECT w.org_id, m.role AS org_role,
           (SELECT g.role FROM core.access_grants g
             WHERE g.principal_type = 'user' AND g.principal_id = ${userId}
               AND g.resource_type = 'workspace' AND g.resource_id = w.id
               AND (g.expires_at IS NULL OR g.expires_at > now())
             ORDER BY CASE g.role WHEN 'owner' THEN 5 WHEN 'creator' THEN 4 WHEN 'editor' THEN 3
                                  WHEN 'commenter' THEN 2 ELSE 1 END DESC
             LIMIT 1) AS grant_role
    FROM core.workspaces w
    INNER JOIN core.organization_members m
      ON m.org_id = w.org_id AND m.user_id = ${userId} AND m.status = 'active'
    WHERE w.id = ${workspaceId} AND w.deleted_at IS NULL AND w.status = 'active'
    LIMIT 1
  `.execute(db);
  const row = res.rows[0];
  if (!row || !requestMayAccess(row.org_id)) return null;
  let role: WorkspaceRole | null = (row.grant_role as WorkspaceRole | null) ?? null;
  if (orgRoleGrantsWorkspaceOwner(row.org_role)) {
    role = role ? maxWorkspaceRole(role, "owner") : "owner";
  }
  return { orgId: row.org_id, orgRole: row.org_role as OrgRole, workspaceRole: role };
}

/** Org role of the user, or null when not an active member. */
export async function getOrgRole(
  db: TabulaDb,
  userId: string,
  orgId: string,
): Promise<OrgRole | null> {
  const res = await sql<{ role: string }>`
    SELECT role FROM core.organization_members
    WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'active'
    LIMIT 1
  `.execute(db);
  return (res.rows[0]?.role as OrgRole | undefined) ?? null;
}

/**
 * Only the organization owner invites people, changes their roles, approves
 * devices and issues API tokens.
 */
export async function isOrgOwner(db: TabulaDb, userId: string, orgId: string): Promise<boolean> {
  return requestMayAccess(orgId) && (await getOrgRole(db, userId, orgId)) === "owner";
}

/** Workspace roles can manage members when they are owner or creator. */
export function workspaceRoleCanManageMembers(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "creator";
}
