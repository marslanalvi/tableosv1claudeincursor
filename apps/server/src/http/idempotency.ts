import { createHash } from "node:crypto";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../lib/app-context.js";
import { parsePid } from "../lib/public-ids.js";
import { sendApiError } from "./errors.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TTL_HOURS = 24;
const LOCK_MS = 60_000;
/** POST endpoints that only read; replaying a cached page would return stale data. */
const READ_ONLY_POST = /\/records\/(query|group)$/;
/** Chunked CSV/XLSX import: large bodies + long writes must not be keyed. */
const SKIP_IDEMPOTENCY = /\/import(\/csv)?$/;

interface IdempotencyState {
  key: string;
  workspaceId: string;
  principalId: string;
  /** Captured in onSend, persisted in onResponse. */
  status?: number;
  body?: Buffer | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set when this request owns an idempotency record (handler will run). */
    idempotency?: IdempotencyState;
  }
}

function requestHash(method: string, path: string, body: unknown): Buffer {
  const payload = JSON.stringify({ method, path, body: body ?? null });
  return createHash("sha256").update(payload, "utf8").digest();
}

async function resolveWorkspaceId(
  db: TabulaDb,
  request: FastifyRequest,
): Promise<string | null> {
  const path = request.url.split("?")[0] ?? request.url;
  const wsp = path.match(/\/v1\/workspaces\/([^/]+)/)?.[1];
  if (wsp) {
    try {
      return parsePid(wsp, "wsp");
    } catch {
      return null;
    }
  }
  const bas = path.match(/\/v1\/bases\/([^/]+)/)?.[1];
  if (!bas) {
    return null;
  }
  try {
    const baseId = parsePid(bas, "bas");
    const row = await sql<{ workspace_id: string }>`
      SELECT workspace_id FROM core.base_directory WHERE base_id = ${baseId} LIMIT 1
    `.execute(db);
    return row.rows[0]?.workspace_id ?? null;
  } catch {
    return null;
  }
}

interface KeyRow {
  status: string;
  response_status: number | null;
  response_body: Buffer | null;
  request_hash: Buffer;
}

function payloadToBuffer(payload: unknown): Buffer | null {
  if (payload === null || payload === undefined || payload === "") return null;
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  if (Buffer.isBuffer(payload)) return payload;
  // Streams are not replayable; a replay returns the status only.
  return null;
}

export async function registerIdempotency(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (reply.sent || !MUTATING.has(request.method)) {
      return;
    }
    const rawKey = request.headers["idempotency-key"];
    if (typeof rawKey !== "string" || rawKey.length === 0) {
      return;
    }
    // Anonymous endpoints (login, public shares) authenticate themselves.
    if (!request.user) {
      return;
    }
    const path = request.url.split("?")[0] ?? request.url;
    if (READ_ONLY_POST.test(path) || SKIP_IDEMPOTENCY.test(path)) {
      return;
    }
    if (rawKey.length > 255) {
      sendApiError(request, reply, 422, "VALIDATION_FAILED", "Idempotency-Key is too long");
      return reply;
    }

    const workspaceId = await resolveWorkspaceId(ctx.db, request);
    if (!workspaceId) {
      return;
    }

    const userId = request.user.id;
    const hash = requestHash(request.method, path, request.body);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);
    const lockedUntil = new Date(Date.now() + LOCK_MS);

    // Expired keys behave as if absent.
    await sql`
      DELETE FROM data.idempotency_keys
      WHERE workspace_id = ${workspaceId} AND principal_id = ${userId}
        AND key = ${rawKey} AND expires_at <= now()
    `.execute(ctx.db);

    const inserted = await sql<{ key: string }>`
      INSERT INTO data.idempotency_keys (
        workspace_id, principal_id, key, request_hash, method, path,
        status, locked_until, expires_at
      ) VALUES (
        ${workspaceId}, ${userId}, ${rawKey}, ${hash},
        ${request.method}, ${path}, 'in_progress', ${lockedUntil}, ${expiresAt}
      )
      ON CONFLICT (workspace_id, principal_id, key) DO NOTHING
      RETURNING key
    `.execute(ctx.db);

    if (inserted.rows.length === 0) {
      // A previous attempt or a concurrent request owns this key.
      const existing = await sql<KeyRow>`
        SELECT status, response_status, response_body, request_hash
        FROM data.idempotency_keys
        WHERE workspace_id = ${workspaceId} AND principal_id = ${userId} AND key = ${rawKey}
        LIMIT 1
      `.execute(ctx.db);
      const row = existing.rows[0];
      if (!row) {
        sendApiError(request, reply, 409, "IDEMPOTENCY_CONFLICT", "Request in progress; retry shortly");
        return reply;
      }
      if (!Buffer.from(row.request_hash).equals(hash)) {
        sendApiError(request, reply, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key reused with a different request");
        return reply;
      }
      if (row.status === "completed" && row.response_status !== null) {
        const status = row.response_status;
        const bodyText = row.response_body ? Buffer.from(row.response_body).toString("utf8") : "";
        void reply.header("idempotent-replayed", "true");
        void reply.code(status);
        if (status === 204 || status === 304 || bodyText.length === 0) {
          void reply.send();
          return reply;
        }
        let isJson = true;
        try {
          JSON.parse(bodyText);
        } catch {
          isJson = false;
        }
        void reply.header(
          "content-type",
          isJson
            ? status >= 400
              ? "application/problem+json; charset=utf-8"
              : "application/json; charset=utf-8"
            : "text/plain; charset=utf-8",
        );
        // Send the stored bytes verbatim (already serialized).
        void reply.send(bodyText);
        return reply;
      }
      // in_progress: take over only when the previous attempt's lock expired.
      const takeover = await sql<{ key: string }>`
        UPDATE data.idempotency_keys
        SET locked_until = ${lockedUntil}
        WHERE workspace_id = ${workspaceId} AND principal_id = ${userId} AND key = ${rawKey}
          AND status = 'in_progress' AND locked_until <= now()
        RETURNING key
      `.execute(ctx.db);
      if (takeover.rows.length === 0) {
        sendApiError(request, reply, 409, "IDEMPOTENCY_CONFLICT", "Request in progress; retry shortly");
        return reply;
      }
    }

    request.idempotency = { key: rawKey, workspaceId, principalId: userId };
    return;
  });

  // Synchronous on purpose: an async onSend hook defers the write, and route
  // handlers that `void reply.send(x)` without returning `reply` then get a
  // second, empty send from Fastify ("Reply was already sent").
  app.addHook("onSend", (request, reply, payload, done) => {
    const state = request.idempotency;
    if (state && state.status === undefined) {
      state.status = reply.statusCode;
      state.body = payloadToBuffer(payload);
    }
    done(null, payload);
  });

  app.addHook("onResponse", async (request) => {
    const state = request.idempotency;
    if (!state) return;
    delete request.idempotency;
    try {
      if (state.status === undefined || state.status >= 500) {
        // Never cache server errors (or a response we never saw): release the key.
        await sql`
          DELETE FROM data.idempotency_keys
          WHERE workspace_id = ${state.workspaceId} AND principal_id = ${state.principalId}
            AND key = ${state.key} AND status = 'in_progress'
        `.execute(ctx.db);
        return;
      }
      await sql`
        UPDATE data.idempotency_keys
        SET status = 'completed',
            response_status = ${state.status},
            response_body = ${state.body ?? null},
            locked_until = now()
        WHERE workspace_id = ${state.workspaceId}
          AND principal_id = ${state.principalId}
          AND key = ${state.key}
      `.execute(ctx.db);
    } catch (err) {
      request.log.error({ err }, "idempotency record update failed");
    }
  });
}
