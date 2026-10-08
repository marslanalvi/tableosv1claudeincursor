import { createHash, randomBytes } from "node:crypto";
import type { Env } from "@tabula/config";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Device approval (replaces MAC-address allowlists, which browsers can't read).
 * Every browser gets a random key in a long-lived httpOnly cookie. In an org
 * that requires approval, a non-owner member's device starts `pending` and the
 * org owner approves or revokes it; until then that org's data is unreachable.
 */
export const DEVICE_COOKIE = "tableos_device";
const DEVICE_COOKIE_MAX_AGE = 5 * 365 * 24 * 3600;
const CACHE_TTL_MS = 15_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;

export function hashDeviceKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

/** Read the device cookie, minting one when absent. */
export function ensureDeviceKey(request: FastifyRequest, reply: FastifyReply, env: Env): string {
  const existing = request.cookies[DEVICE_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{32,64}$/.test(existing)) return existing;
  const key = randomBytes(32).toString("base64url");
  reply.setCookie(DEVICE_COOKIE, key, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });
  request.cookies[DEVICE_COOKIE] = key;
  return key;
}

/** Org setting; approval is required unless the owner turned it off. */
export function requiresDeviceApproval(settings: unknown): boolean {
  const sec = (settings as { security?: { requireDeviceApproval?: unknown } } | null)?.security;
  return sec?.requireDeviceApproval !== false;
}

/** Friendly default label from the user agent, e.g. "Chrome on Windows". */
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua ?? "";
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\//.test(s)
      ? "Opera"
      : /Chrome\//.test(s)
        ? "Chrome"
        : /Firefox\//.test(s)
          ? "Firefox"
          : /Safari\//.test(s)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(s)
    ? "Windows"
    : /Android/.test(s)
      ? "Android"
      : /iPhone|iPad/.test(s)
        ? "iOS"
        : /Mac OS X/.test(s)
          ? "macOS"
          : /Linux/.test(s)
            ? "Linux"
            : "unknown OS";
  return `${browser} on ${os}`;
}

const cache = new Map<string, { blocked: Set<string>; at: number }>();
const lastTouch = new Map<string, number>();

export function invalidateDeviceCache(userId?: string): void {
  if (!userId) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}

/**
 * Orgs this user may not reach from this device. Registers unknown devices as
 * `pending` in every org that requires approval (owners are always exempt so
 * they can never lock themselves out).
 */
export async function blockedOrgsForDevice(
  db: TabulaDb,
  userId: string,
  deviceKey: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<Set<string>> {
  const hash = hashDeviceKey(deviceKey);
  const key = `${userId}:${hash.toString("hex")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.blocked;

  const rows = await sql<{ org_id: string; role: string; settings: unknown; device_id: string | null; status: string | null }>`
    SELECT m.org_id, m.role, o.settings, d.id AS device_id, d.status
    FROM core.organization_members m
    INNER JOIN core.organizations o ON o.id = m.org_id
    LEFT JOIN core.org_devices d
      ON d.org_id = m.org_id AND d.user_id = m.user_id AND d.device_hash = ${hash}
    WHERE m.user_id = ${userId} AND m.status = 'active'
  `.execute(db);

  const blocked = new Set<string>();
  const touch = Date.now() - (lastTouch.get(key) ?? 0) > TOUCH_INTERVAL_MS;
  for (const r of rows.rows) {
    const exempt = r.role === "owner" || !requiresDeviceApproval(r.settings);
    if (!r.device_id) {
      if (exempt) continue;
      await sql`
        INSERT INTO core.org_devices (org_id, user_id, device_hash, label, user_agent, first_ip, last_ip)
        VALUES (${r.org_id}, ${userId}, ${hash}, ${deviceLabel(meta.userAgent)},
                ${meta.userAgent?.slice(0, 500) ?? null}, ${meta.ip}::inet, ${meta.ip}::inet)
        ON CONFLICT (org_id, user_id, device_hash) DO NOTHING
      `.execute(db);
      blocked.add(r.org_id);
      continue;
    }
    if (touch) {
      await sql`
        UPDATE core.org_devices SET last_seen_at = now(), last_ip = ${meta.ip}::inet WHERE id = ${r.device_id}
      `.execute(db);
    }
    // An explicit revoke blocks even when the org no longer requires approval.
    if (r.role !== "owner" && (r.status === "revoked" || (!exempt && r.status !== "approved"))) {
      blocked.add(r.org_id);
    }
  }
  if (touch) lastTouch.set(key, Date.now());
  cache.set(key, { blocked, at: Date.now() });
  return blocked;
}
