import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { TabulaDb } from "@tabula/db";
import type { AppContext } from "../../lib/app-context.js";
import { pid } from "../../lib/public-ids.js";
import { signPayload, verifyPayload } from "../attachments/storage.js";
import { normalizeViewConfig, type ViewConfig } from "../views/config.js";
import { loadTableConfigInfo } from "../views/serialize.js";
import { hashShareToken, parseShareToken } from "./tokens.js";

export type ShareTargetType = "view" | "form" | "base";

export interface ShareLinkRow {
  id: string;
  workspace_id: string;
  base_id: string;
  table_id: string | null;
  target_type: ShareTargetType;
  target_id: string;
  token: string | null;
  token_hash: Buffer;
  access_mode: "public" | "password";
  password_hash: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  allow_copy: boolean;
  created_by: string | null;
  created_at: Date;
}

export const SHARE_COLUMNS = sql`
  id, workspace_id, base_id, table_id, target_type, target_id, token, token_hash,
  access_mode, password_hash, expires_at, revoked_at, allow_copy, created_by, created_at
`;

export function publicAppOrigin(): string {
  return (process.env["PUBLIC_APP_URL"] ?? "http://localhost:5174").replace(/\/+$/, "");
}

export function shareUrl(row: Pick<ShareLinkRow, "target_type" | "token">): string | null {
  if (!row.token) return null;
  const segment = row.target_type === "form" ? "f" : "s";
  return `${publicAppOrigin()}/${segment}/${encodeURIComponent(row.token)}`;
}

export function shareStatus(row: ShareLinkRow): "active" | "revoked" | "expired" {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return "expired";
  return "active";
}

export function shareToDto(row: ShareLinkRow) {
  return {
    id: pid("shr", row.id),
    token: row.token,
    url: shareUrl(row),
    targetType: row.target_type,
    targetId:
      row.target_type === "base" ? pid("bas", row.target_id) : pid("viw", row.target_id),
    viewId: row.target_type === "base" ? null : pid("viw", row.target_id),
    tableId: row.table_id ? pid("tbl", row.table_id) : null,
    baseId: pid("bas", row.base_id),
    accessMode: row.access_mode,
    hasPassword: row.access_mode === "password",
    expiresAt: row.expires_at?.toISOString() ?? null,
    allowCopy: row.allow_copy,
    status: shareStatus(row),
    createdBy: row.created_by ? pid("usr", row.created_by) : null,
    createdAt: row.created_at.toISOString(),
  };
}

// ── Public resolution ───────────────────────────────────────────────────────

export type ResolveFailure =
  | { ok: false; status: 404; reason: "not_found" }
  | { ok: false; status: 410; reason: "revoked" | "expired" | "target_deleted" }
  | { ok: false; status: 401; reason: "password_required" | "password_incorrect" };

export interface ResolvedShare {
  ok: true;
  link: ShareLinkRow;
  orgId: string;
}

/** Look up a share by its token. Does not check the password. */
export async function findShareByToken(
  db: TabulaDb,
  rawToken: string,
): Promise<ResolvedShare | ResolveFailure> {
  const parsed = parseShareToken(rawToken);
  if (!parsed) return { ok: false, status: 404, reason: "not_found" };

  const dir = await sql<{ share_link_id: string }>`
    SELECT share_link_id FROM core.public_link_directory
    WHERE token_prefix = ${parsed.prefix} LIMIT 1
  `.execute(db);
  const shareLinkId = dir.rows[0]?.share_link_id;
  if (!shareLinkId) return { ok: false, status: 404, reason: "not_found" };

  const res = await sql<ShareLinkRow & { org_id: string | null }>`
    SELECT ${SHARE_COLUMNS}, (
      SELECT bd.org_id FROM core.base_directory bd
      WHERE bd.base_id = s.base_id AND bd.status = 'active' AND bd.deleted_at IS NULL
      LIMIT 1
    ) AS org_id
    FROM data.share_links s
    WHERE id = ${shareLinkId}
    LIMIT 1
  `.execute(db);
  const row = res.rows[0];
  if (!row || !row.token_hash.equals(hashShareToken(parsed.token))) {
    return { ok: false, status: 404, reason: "not_found" };
  }
  if (row.revoked_at) return { ok: false, status: 410, reason: "revoked" };
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    return { ok: false, status: 410, reason: "expired" };
  }
  if (!row.org_id) return { ok: false, status: 410, reason: "target_deleted" };

  if (row.target_type !== "base") {
    const view = await sql<{ id: string }>`
      SELECT v.id FROM data.views v
      JOIN data.tables t ON t.id = v.table_id AND t.deleted_at IS NULL
      WHERE v.id = ${row.target_id} AND v.deleted_at IS NULL LIMIT 1
    `.execute(db);
    if (!view.rows[0]) return { ok: false, status: 410, reason: "target_deleted" };
  }
  return { ok: true, link: row, orgId: row.org_id };
}

function passwordVersion(row: ShareLinkRow): string {
  return createHash("sha256")
    .update(row.password_hash ?? "")
    .digest("base64url")
    .slice(0, 10);
}

export function issueUnlockToken(ctx: AppContext, row: ShareLinkRow): { token: string; expiresAt: string } {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  return {
    token: signPayload(ctx, { k: "unlock", s: row.id, v: passwordVersion(row), exp }),
    expiresAt: new Date(exp).toISOString(),
  };
}

export function checkUnlockToken(ctx: AppContext, row: ShareLinkRow, token: string | undefined): boolean {
  if (row.access_mode !== "password") return true;
  if (!token) return false;
  const payload = verifyPayload<{ k: string; s: string; v: string }>(ctx, token);
  return Boolean(payload && payload.k === "unlock" && payload.s === row.id && payload.v === passwordVersion(row));
}

// ── Schema exposure ─────────────────────────────────────────────────────────

export interface PublicFieldRow {
  id: string;
  table_id: string;
  name: string;
  type: string;
  slot: number;
  config: Record<string, unknown>;
  description: string;
  is_computed: boolean;
}

export interface PublicFieldDto {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  description: string | null;
  isPrimary: boolean;
  isComputed: boolean;
}

const SAFE_CONFIG_KEYS = [
  "options",
  "precision",
  "symbol",
  "max",
  "icon",
  "format",
  "timeFormat",
  "timeZone",
  "resultType",
  "allowMultiple",
];

export function toPublicFieldDto(row: PublicFieldRow, primaryFieldId: string | null): PublicFieldDto {
  const config: Record<string, unknown> = {};
  for (const key of SAFE_CONFIG_KEYS) {
    if (row.config && key in row.config) config[key] = row.config[key];
  }
  return {
    id: pid("fld", row.id),
    name: row.name,
    type: row.type,
    config,
    description: row.description ? row.description : null,
    isPrimary: row.id === primaryFieldId,
    isComputed: row.is_computed || COMPUTED_TYPES.has(row.type),
  };
}

const COMPUTED_TYPES = new Set([
  "formula",
  "lookup",
  "rollup",
  "count",
  "autonumber",
  "created_time",
  "modified_time",
  "created_by",
  "modified_by",
  "button",
  "ai_generated",
]);

/** Field types a public form can accept. */
export const FORM_INPUT_TYPES = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "number",
  "currency",
  "percent",
  "rating",
  "duration",
  "checkbox",
  "date",
  "datetime",
  "single_select",
  "multi_select",
  "attachment",
  "barcode",
]);

export async function loadPublicFields(db: TabulaDb, tableId: string): Promise<{
  rows: PublicFieldRow[];
  primaryFieldId: string | null;
  tableName: string;
}> {
  const t = await sql<{ name: string; primary_field_id: string | null }>`
    SELECT name, primary_field_id FROM data.tables WHERE id = ${tableId} LIMIT 1
  `.execute(db);
  const f = await sql<PublicFieldRow>`
    SELECT id, table_id, name, type, slot, config, description, is_computed
    FROM data.fields
    WHERE table_id = ${tableId} AND deleted_at IS NULL AND type <> 'button'
    ORDER BY order_key COLLATE "C" ASC, slot ASC
  `.execute(db);
  return {
    rows: f.rows,
    primaryFieldId: t.rows[0]?.primary_field_id ?? null,
    tableName: t.rows[0]?.name ?? "Table",
  };
}

export interface LoadedView {
  id: string;
  tableId: string;
  name: string;
  type: string;
  description: string;
  config: ViewConfig;
}

export async function loadView(db: TabulaDb, viewId: string): Promise<LoadedView | null> {
  const r = await sql<{
    id: string;
    table_id: string;
    name: string;
    type: string;
    description: string;
    config: unknown;
  }>`
    SELECT id, table_id, name, type, description, config FROM data.views
    WHERE id = ${viewId} AND deleted_at IS NULL LIMIT 1
  `.execute(db);
  const v = r.rows[0];
  if (!v) return null;
  const info = (await loadTableConfigInfo(db, [v.table_id])).get(v.table_id);
  return {
    id: v.id,
    tableId: v.table_id,
    name: v.name,
    type: v.type,
    description: v.description,
    config: normalizeViewConfig(v.config, v.type, info?.fields ?? [], info?.name),
  };
}

/** Visible fields of a (non-form) view, in view order. Primary is always visible. */
export function visibleFieldsForView(
  rows: PublicFieldRow[],
  primaryFieldId: string | null,
  config: ViewConfig | null,
): PublicFieldRow[] {
  const hidden = new Set(config?.hiddenFieldIds ?? []);
  const order = config?.fieldOrder ?? [];
  const pos = new Map(order.map((id, i) => [id, i]));
  const visible = rows.filter(
    (r) => r.id === primaryFieldId || !hidden.has(pid("fld", r.id)),
  );
  return visible
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.id === primaryFieldId) return -1;
      if (b.r.id === primaryFieldId) return 1;
      const pa = pos.get(pid("fld", a.r.id));
      const pb = pos.get(pid("fld", b.r.id));
      if (pa !== undefined && pb !== undefined) return pa - pb;
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

export interface FormFieldSpec {
  field: PublicFieldRow;
  required: boolean;
  label: string;
  help: string;
}

export function formFieldSpecs(
  rows: PublicFieldRow[],
  primaryFieldId: string | null,
  config: ViewConfig,
): FormFieldSpec[] {
  const byPid = new Map(rows.map((r) => [pid("fld", r.id), r]));
  const listed = config.form?.fields ?? [];
  const specs: FormFieldSpec[] = [];
  if (listed.length > 0) {
    for (const item of listed) {
      const field = byPid.get(item.fieldId);
      if (!field || !FORM_INPUT_TYPES.has(field.type)) continue;
      specs.push({
        field,
        required: Boolean(item.required),
        label: item.label?.trim() || field.name,
        help: item.help?.trim() || field.description || "",
      });
    }
    return specs;
  }
  for (const field of rows) {
    if (!FORM_INPUT_TYPES.has(field.type)) continue;
    specs.push({
      field,
      required: field.id === primaryFieldId,
      label: field.name,
      help: field.description || "",
    });
  }
  return specs;
}

/** Safe subset of a view config for public clients (no filter: it may leak hidden values). */
export function publicViewConfig(config: ViewConfig): Record<string, unknown> {
  return {
    sorts: config.sorts,
    groups: config.groups,
    hiddenFieldIds: config.hiddenFieldIds,
    fieldOrder: config.fieldOrder,
    fieldWidths: config.fieldWidths,
    frozenFieldCount: config.frozenFieldCount,
    rowHeight: config.rowHeight,
    color: config.color,
    ...(config.kanban ? { kanban: config.kanban } : {}),
    ...(config.gallery ? { gallery: config.gallery } : {}),
    ...(config.calendar ? { calendar: config.calendar } : {}),
    ...(config.timeline ? { timeline: config.timeline } : {}),
  };
}

// ── Rate limiting (Redis when available, memory otherwise) ──────────────────

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

export async function hitRateLimit(
  ctx: AppContext,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const fullKey = `tabula:rl:${key}`;
  if (ctx.redis) {
    try {
      const n = await ctx.redis.incr(fullKey);
      if (n === 1) await ctx.redis.expire(fullKey, windowSec);
      return n > limit;
    } catch {
      /* fall back to memory */
    }
  }
  const now = Date.now();
  const bucket = memoryBuckets.get(fullKey);
  if (!bucket || bucket.resetAt < now) {
    memoryBuckets.set(fullKey, { count: 1, resetAt: now + windowSec * 1000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}
