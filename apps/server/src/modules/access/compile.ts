import {
  compileSnapshot,
  type AccessGrantRow,
  type PermissionSnapshot,
} from "@tabula/permissions";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { requestMayAccess } from "../../kernel/request-context.js";
import { orgRoleGrantsWorkspaceOwner } from "./workspace-access.js";

/**
 * Snapshot cache keyed by user+base. Entries are validated against the base's
 * `perm_epoch` (bumped on grant/invite changes) and expire after a short TTL so
 * org/workspace-level changes that do not bump a base epoch still propagate.
 */
const SNAPSHOT_TTL_MS = 30_000;
const snapshotCache = new Map<string, { snapshot: PermissionSnapshot; at: number }>();

function cacheKey(userId: string, baseId: string): string {
  return `${userId}:${baseId}`;
}

async function loadGrantsForUser(
  db: TabulaDb,
  userId: string,
  workspaceId: string,
  baseId: string,
): Promise<AccessGrantRow[]> {
  const result = await sql<AccessGrantRow>`
    SELECT resource_type, resource_id, workspace_id, base_id, role
    FROM core.access_grants
    WHERE principal_type = 'user'
      AND principal_id = ${userId}
      AND (expires_at IS NULL OR expires_at > now())
      AND (
        (resource_type = 'workspace' AND resource_id = ${workspaceId})
        OR (resource_type = 'base' AND base_id = ${baseId})
      )
  `.execute(db);
  return result.rows.map((g) =>
    g.resource_type === "workspace" ? { ...g, workspace_id: g.workspace_id ?? workspaceId } : g,
  );
}

/** Org owners/admins get an implicit workspace `owner` grant. */
async function orgOwnerGrant(
  db: TabulaDb,
  userId: string,
  orgId: string,
  workspaceId: string,
): Promise<AccessGrantRow | null> {
  const res = await sql<{ role: string }>`
    SELECT role FROM core.organization_members
    WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'active'
    LIMIT 1
  `.execute(db);
  if (!orgRoleGrantsWorkspaceOwner(res.rows[0]?.role)) return null;
  return {
    resource_type: "workspace",
    resource_id: workspaceId,
    workspace_id: workspaceId,
    base_id: null,
    role: "owner",
  };
}

/** Invalidate cached snapshots for a base (after perm_epoch bump). */
export function invalidateBaseSnapshotCache(baseId: string): void {
  for (const key of snapshotCache.keys()) {
    if (key.endsWith(`:${baseId}`)) {
      snapshotCache.delete(key);
    }
  }
}

/** Invalidate every cached snapshot of a user (after workspace/org grant changes). */
export function invalidateUserSnapshotCache(userId: string): void {
  for (const key of snapshotCache.keys()) {
    if (key.startsWith(`${userId}:`)) {
      snapshotCache.delete(key);
    }
  }
}

/**
 * Compile (and cache) effective permissions for a user on a base.
 * Sources: base grants, workspace grants, and org owner/admin membership.
 * Org membership alone grants nothing (effectiveBaseRole = null).
 */
export async function compileForUser(
  db: TabulaDb,
  userId: string,
  baseId: string,
): Promise<PermissionSnapshot> {
  const key = cacheKey(userId, baseId);
  const cached = snapshotCache.get(key);

  const dir = await sql<{ workspace_id: string; org_id: string; perm_epoch: string | null }>`
    SELECT bd.workspace_id, bd.org_id,
           (SELECT perm_epoch FROM data.base_runtime WHERE base_id = bd.base_id) AS perm_epoch
    FROM core.base_directory bd
    WHERE bd.base_id = ${baseId} AND bd.status = 'active' AND bd.deleted_at IS NULL
    LIMIT 1
  `.execute(db);
  const row = dir.rows[0];
  if (!row) {
    return {
      baseId,
      workspaceId: "",
      effectiveBaseRole: null,
      permEpoch: 1,
    };
  }
  const workspaceId = row.workspace_id;
  const permEpoch = Number(row.perm_epoch ?? 1);
  if (!requestMayAccess(row.org_id, baseId)) {
    return { baseId, workspaceId, effectiveBaseRole: null, permEpoch };
  }

  if (
    cached &&
    cached.snapshot.permEpoch === permEpoch &&
    Date.now() - cached.at < SNAPSHOT_TTL_MS
  ) {
    return cached.snapshot;
  }

  const grants = await loadGrantsForUser(db, userId, workspaceId, baseId);
  const orgGrant = await orgOwnerGrant(db, userId, row.org_id, workspaceId);
  if (orgGrant) grants.push(orgGrant);

  // Grants only count while the user is still an active org member.
  const member = await sql<{ n: number }>`
    SELECT 1 AS n FROM core.organization_members
    WHERE org_id = ${row.org_id} AND user_id = ${userId} AND status = 'active'
    LIMIT 1
  `.execute(db);
  const effectiveGrants = member.rows.length > 0 ? grants : [];

  const snapshot = compileSnapshot(
    { baseId, workspaceId, grants: effectiveGrants },
    permEpoch,
  );
  snapshotCache.set(key, { snapshot, at: Date.now() });
  return snapshot;
}

/** Workspace-scoped snapshot (e.g. before a base exists). */
export async function compileForWorkspace(
  db: TabulaDb,
  userId: string,
  workspaceId: string,
): Promise<PermissionSnapshot> {
  const grants = await sql<AccessGrantRow>`
    SELECT g.resource_type, g.resource_id, g.workspace_id, g.base_id, g.role
    FROM core.access_grants g
    INNER JOIN core.workspaces w ON w.id = ${workspaceId}
    INNER JOIN core.organization_members m
      ON m.org_id = w.org_id AND m.user_id = ${userId} AND m.status = 'active'
    WHERE g.principal_type = 'user'
      AND g.principal_id = ${userId}
      AND (g.expires_at IS NULL OR g.expires_at > now())
      AND g.resource_type = 'workspace' AND g.resource_id = ${workspaceId}
  `.execute(db);
  const rows: AccessGrantRow[] = grants.rows.map((g) => ({ ...g, workspace_id: g.workspace_id ?? workspaceId }));

  const org = await sql<{ org_id: string }>`
    SELECT org_id FROM core.workspaces WHERE id = ${workspaceId} LIMIT 1
  `.execute(db);
  const orgId = org.rows[0]?.org_id;
  if (orgId && !requestMayAccess(orgId)) {
    return compileSnapshot([], { baseId: "", workspaceId }, 1);
  }
  if (orgId) {
    const orgGrant = await orgOwnerGrant(db, userId, orgId, workspaceId);
    if (orgGrant) rows.push(orgGrant);
  }

  return compileSnapshot(rows, { baseId: "", workspaceId }, 1);
}
