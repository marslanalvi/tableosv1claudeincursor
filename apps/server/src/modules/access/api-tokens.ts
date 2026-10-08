import { createHash, randomBytes } from "node:crypto";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";

/** Personal access tokens issued by an org owner (`Authorization: Bearer tos_…`). */
export const API_TOKEN_PREFIX = "tos_";

export type TokenScope = "read" | "write" | "delete";
export const TOKEN_SCOPES: readonly TokenScope[] = ["read", "write", "delete"];

export function generateApiToken(): { token: string; prefix: string; hash: Buffer } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(30).toString("base64url")}`;
  return { token, prefix: token.slice(0, 10), hash: hashApiToken(token) };
}

export function hashApiToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export interface ResolvedApiToken {
  id: string;
  orgId: string;
  userId: string;
  email: string;
  displayName: string;
  scopes: TokenScope[];
  baseIds: string[] | null;
}

/** Valid only while unrevoked, unexpired, and its creator is still an active owner of the org. */
export async function resolveApiToken(db: TabulaDb, raw: string, ip: string | null): Promise<ResolvedApiToken | null> {
  if (!raw.startsWith(API_TOKEN_PREFIX) || raw.length > 200) return null;
  const res = await sql<{
    id: string;
    org_id: string;
    user_id: string;
    email: string;
    display_name: string;
    scopes: TokenScope[];
    base_ids: string[] | null;
    last_used_at: Date | null;
  }>`
    SELECT t.id, t.org_id, t.user_id, u.email, u.display_name, t.scopes, t.base_ids, t.last_used_at
    FROM core.api_tokens t
    INNER JOIN core.users u ON u.id = t.user_id AND u.status = 'active'
    INNER JOIN core.organization_members m
      ON m.org_id = t.org_id AND m.user_id = t.user_id AND m.status = 'active' AND m.role = 'owner'
    WHERE t.token_hash = ${hashApiToken(raw)}
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > now())
    LIMIT 1
  `.execute(db);
  const row = res.rows[0];
  if (!row) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    await sql`UPDATE core.api_tokens SET last_used_at = now(), last_used_ip = ${ip}::inet WHERE id = ${row.id}`.execute(db);
  }
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    scopes: row.scopes,
    baseIds: row.base_ids,
  };
}

const RECORDS = /^\/v1\/(?:bases\/[^/]+\/)?tables\/[^/]+\/records(\/.*)?$/;

/**
 * The scope an API-token request needs, or null when tokens may not call this
 * route at all. Tokens are limited to the record API and schema reads.
 */
export function requiredScope(method: string, path: string): TokenScope | null {
  if (path === "/v1/api" || path.startsWith("/v1/api/")) return method === "GET" ? "read" : null;
  if (method === "GET" && /^\/v1\/bases\/[^/]+(?:\/tables)?$/.test(path)) return "read";
  if (method === "GET" && /^\/v1\/(?:bases\/[^/]+\/)?tables\/[^/]+$/.test(path)) return "read";
  const m = RECORDS.exec(path);
  if (!m) return null;
  const rest = m[1] ?? "";
  switch (method) {
    case "GET":
      return "read";
    case "POST":
      if (rest === "/query" || rest === "/group") return "read";
      if (rest === "/batch-delete") return "delete";
      return "write";
    case "PATCH":
    case "PUT":
      return "write";
    case "DELETE":
      return /\/links$/.test(rest) ? "write" : "delete";
    default:
      return null;
  }
}
