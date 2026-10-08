import {
  SESSION_COOKIE_NAME,
  hashSessionToken,
} from "@tabula/auth";
import { sql } from "kysely";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../lib/app-context.js";
import { currentRequestContext } from "../kernel/request-context.js";
import { blockedOrgsForDevice, ensureDeviceKey } from "../modules/access/devices.js";
import { requiredScope, resolveApiToken } from "../modules/access/api-tokens.js";
import { sendApiError, unauthorized } from "./errors.js";

export interface RequestUser {
  id: string;
  email: string;
  displayName: string;
  /** Empty for API-token requests. */
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: RequestUser;
    /** Set when the request authenticated with an API token instead of a session. */
    apiTokenId?: string;
  }
}

const PUBLIC_PREFIXES = [
  "/health",
  "/v1/openapi.json",
  "/v1/auth/signup",
  "/v1/auth/login",
  "/v1/auth/google",
  "/v1/auth/google/callback",
  "/v1/auth/mfa/verify",
  "/v1/auth/logout",
];

export function isPublicRoute(url: string, method?: string): boolean {
  const path = url.split("?")[0] ?? url;
  if (path.startsWith("/v1/public/") || path.startsWith("/v1/hooks/")) {
    return true;
  }
  if (method === "PUT" && path.startsWith("/v1/uploads/")) {
    return true;
  }
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}?`));
}

function bearerToken(request: FastifyRequest): string | null {
  const h = request.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

export async function authHook(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const path = request.url.split("?")[0] ?? request.url;
  const bearer = bearerToken(request);
  // Browsers get a device key before signing in so the login itself is tied to a device.
  const deviceKey = bearer ? null : ensureDeviceKey(request, reply, ctx.env);
  if (isPublicRoute(path, request.method)) {
    return;
  }

  if (bearer) {
    try {
      const token = await resolveApiToken(ctx.db, bearer, request.ip ?? null);
      if (!token) {
        unauthorized(request, reply);
        return;
      }
      const scope = requiredScope(request.method, path);
      if (!scope) {
        sendApiError(request, reply, 403, "FORBIDDEN", "API tokens can only call the record API (see Help → API)");
        return;
      }
      if (!token.scopes.includes(scope)) {
        sendApiError(request, reply, 403, "FORBIDDEN", `This token doesn't have the "${scope}" permission`);
        return;
      }
      request.user = { id: token.userId, email: token.email, displayName: token.displayName, sessionId: "" };
      request.apiTokenId = token.id;
      const store = currentRequestContext();
      if (store) {
        store.access = {
          blockedOrgs: new Set(),
          token: {
            id: token.id,
            orgId: token.orgId,
            scopes: new Set(token.scopes),
            baseIds: token.baseIds ? new Set(token.baseIds) : null,
          },
        };
      }
    } catch (err) {
      request.log.error({ err }, "api token lookup failed");
      unauthorized(request, reply);
    }
    return;
  }

  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    unauthorized(request, reply);
    return;
  }

  const tokenHash = hashSessionToken(token);
  try {
    const result = await sql<{
      session_id: string;
      user_id: string;
      email: string;
      display_name: string;
      auth_method: string;
    }>`
      SELECT s.id AS session_id, u.id AS user_id, u.email, u.display_name, s.auth_method
      FROM core.sessions s
      INNER JOIN core.users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.idle_expires_at > now()
        AND u.status = 'active'
      LIMIT 1
    `.execute(ctx.db);

    const row = result.rows[0];
    if (!row) {
      unauthorized(request, reply);
      return;
    }

    await sql`
      UPDATE core.sessions
      SET last_seen_at = now(),
          idle_expires_at = LEAST(expires_at, now() + interval '24 hours')
      WHERE id = ${row.session_id}
    `.execute(ctx.db);

    request.user = {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      sessionId: row.session_id,
    };

    // Automation runs use cookie-less service sessions and act for the automation owner.
    if (deviceKey && row.auth_method !== "automation") {
      const blockedOrgs = await blockedOrgsForDevice(ctx.db, row.user_id, deviceKey, {
        ip: request.ip ?? null,
        userAgent: request.headers["user-agent"] ?? null,
      });
      const store = currentRequestContext();
      if (store) store.access = { blockedOrgs };
    }
  } catch (err) {
    request.log.error({ err }, "auth session lookup failed");
    unauthorized(request, reply);
  }
}
