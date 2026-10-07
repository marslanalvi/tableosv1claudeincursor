import { hashPassword, verifyPassword } from "@tabula/auth";
import { decodePublicId, generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { notFound, validationProblem } from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { writeAuditEvent } from "../audit/write.js";
import { executeRecordQuery } from "../query/execute-record-query.js";
import {
  createPendingUpload,
  finalizeUpload,
  hydrateAttachments,
  attachmentIdsFromCell,
  loadAttachment,
  storeUploadBody,
} from "../attachments/service.js";
import { MAX_PUBLIC_UPLOAD_BYTES } from "../attachments/storage.js";
import { LimitsService } from "../billing/limits-service.js";
import {
  gone,
  handleWave4Error,
  passwordRequired,
  tooManyRequests,
} from "../wave4/problems.js";
import { createRecordsBySlot } from "../wave4/record-writer.js";
import { coerceFormValue, FormValueError, isEmptyInput } from "./form-values.js";
import {
  checkUnlockToken,
  findShareByToken,
  formFieldSpecs,
  hitRateLimit,
  issueUnlockToken,
  loadPublicFields,
  loadView,
  publicViewConfig,
  SHARE_COLUMNS,
  shareToDto,
  toPublicFieldDto,
  visibleFieldsForView,
  type LoadedView,
  type PublicFieldRow,
  type ResolvedShare,
  type ShareLinkRow,
} from "./service.js";
import { createShareToken } from "./tokens.js";

const createShareBody = z.object({
  targetType: z.enum(["view", "form", "base"]),
  targetId: z.string().optional(),
  password: z.string().min(4).max(200).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  allowCopy: z.boolean().optional(),
});

const patchShareBody = z.object({
  password: z.string().min(4).max(200).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  allowCopy: z.boolean().optional(),
});

const publicQueryBody = z.object({
  tableId: z.string().optional(),
  viewId: z.string().optional(),
  search: z.string().max(200).optional(),
  sort: z
    .array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }))
    .max(5)
    .optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().nullish(),
});

const TEXT_SEARCH_TYPES = new Set(["text", "long_text", "email", "url", "phone"]);

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export async function registerShareRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limits = new LimitsService(ctx.db);

  // ─────────────────────────── Admin (session) ───────────────────────────

  async function adminScope(request: FastifyRequest, reply: FastifyReply, baseParam: string) {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return null;
    }
    const baseId = parsePid(baseParam, "bas");
    const base = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!base.ok) {
      notFound(request, reply, "Base not found");
      return null;
    }
    const snapshot = await compileForUser(ctx.db, user.id, baseId);
    assertCan(snapshot, "base.read");
    return { user, baseId, base, snapshot };
  }

  async function loadShare(baseId: string, shareParam: string): Promise<ShareLinkRow | null> {
    const shareId = parsePid(shareParam, "shr");
    const r = await sql<ShareLinkRow>`
      SELECT ${SHARE_COLUMNS} FROM data.share_links
      WHERE id = ${shareId} AND base_id = ${baseId} LIMIT 1
    `.execute(ctx.db);
    return r.rows[0] ?? null;
  }

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/shares",
    async (request, reply) => {
      try {
        const scope = await adminScope(request, reply, request.params.baseId);
        if (!scope) return;
        const { user, baseId, base, snapshot } = scope;
        assertCan(snapshot, "record.update");
        const body = createShareBody.parse(request.body);

        let targetId: string;
        let tableId: string | null = null;
        if (body.targetType === "base") {
          if (body.targetId && parsePid(body.targetId, "bas") !== baseId) {
            validationProblem(request, reply, "targetId must be this base");
            return;
          }
          targetId = baseId;
        } else {
          if (!body.targetId) {
            validationProblem(request, reply, "targetId (a viw_ id) is required");
            return;
          }
          targetId = parsePid(body.targetId, "viw");
          const view = await sql<{ id: string; type: string; table_id: string; visibility: string }>`
            SELECT id, type, table_id, visibility FROM data.views
            WHERE id = ${targetId} AND base_id = ${baseId} AND deleted_at IS NULL
            LIMIT 1
          `.execute(ctx.db);
          const v = view.rows[0];
          if (!v) {
            validationProblem(request, reply, "Target view not found");
            return;
          }
          if (body.targetType === "form" && v.type !== "form") {
            validationProblem(request, reply, "Form shares must target a form view");
            return;
          }
          if (body.targetType === "view" && v.type === "form") {
            validationProblem(request, reply, "Use targetType \"form\" to share a form view");
            return;
          }
          tableId = v.table_id;
        }

        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
        if (expiresAt && expiresAt.getTime() <= Date.now()) {
          validationProblem(request, reply, "expiresAt must be in the future");
          return;
        }

        const { token, tokenPrefix, tokenHash } = createShareToken();
        const shareId = generateUuidV7();
        const accessMode = body.password ? "password" : "public";
        const passwordHash = body.password ? await hashPassword(body.password) : null;

        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            INSERT INTO data.share_links (
              id, workspace_id, base_id, table_id, target_type, target_id,
              token, token_hash, token_prefix, access_mode, password_hash,
              expires_at, allow_copy, created_by
            ) VALUES (
              ${shareId}, ${base.workspaceId}, ${baseId}, ${tableId}, ${body.targetType}, ${targetId},
              ${token}, ${tokenHash}, ${tokenPrefix}, ${accessMode}, ${passwordHash},
              ${expiresAt}, ${body.allowCopy ?? false}, ${user.id}
            )
          `.execute(trx);
          await sql`
            INSERT INTO core.public_link_directory (
              token_prefix, workspace_id, shard_id, share_link_id, kind
            ) VALUES (
              ${tokenPrefix}, ${base.workspaceId}, ${base.shardId}, ${shareId}, 'share_link'
            )
          `.execute(trx);
        });

        await writeAuditEvent(ctx.db, {
          orgId: base.orgId,
          workspaceId: base.workspaceId,
          actorUserId: user.id,
          action: "share.created",
          targetType: "share_link",
          targetId: shareId,
          metadata: { targetType: body.targetType, accessMode },
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        });

        const share = await loadShare(baseId, pid("shr", shareId));
        void reply.code(201).send({ share: share ? shareToDto(share) : null });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.get<{
    Params: { baseId: string };
    Querystring: { targetId?: string; targetType?: string; includeInactive?: string };
  }>("/v1/bases/:baseId/shares", async (request, reply) => {
    try {
      const scope = await adminScope(request, reply, request.params.baseId);
      if (!scope) return;
      const { baseId } = scope;
      let targetId: string | null = null;
      if (request.query.targetId) {
        targetId = request.query.targetId.startsWith("bas_")
          ? parsePid(request.query.targetId, "bas")
          : parsePid(request.query.targetId, "viw");
      }
      const includeInactive = request.query.includeInactive === "true";
      const r = await sql<ShareLinkRow>`
        SELECT ${SHARE_COLUMNS} FROM data.share_links
        WHERE base_id = ${baseId}
          ${targetId ? sql`AND target_id = ${targetId}` : sql``}
          ${request.query.targetType ? sql`AND target_type = ${request.query.targetType}` : sql``}
          ${includeInactive ? sql`` : sql`AND revoked_at IS NULL`}
        ORDER BY created_at DESC
        LIMIT 200
      `.execute(ctx.db);
      void reply.send({ shares: r.rows.map(shareToDto) });
    } catch (err) {
      handleWave4Error(request, reply, err);
    }
  });

  app.patch<{ Params: { baseId: string; shareId: string } }>(
    "/v1/bases/:baseId/shares/:shareId",
    async (request, reply) => {
      try {
        const scope = await adminScope(request, reply, request.params.baseId);
        if (!scope) return;
        assertCan(scope.snapshot, "record.update");
        const share = await loadShare(scope.baseId, request.params.shareId);
        if (!share || share.revoked_at) {
          notFound(request, reply, "Share not found");
          return;
        }
        const body = patchShareBody.parse(request.body);
        let accessMode = share.access_mode;
        let passwordHash = share.password_hash;
        if (body.password !== undefined) {
          passwordHash = body.password ? await hashPassword(body.password) : null;
          accessMode = body.password ? "password" : "public";
        }
        const expiresAt =
          body.expiresAt === undefined
            ? share.expires_at
            : body.expiresAt
              ? new Date(body.expiresAt)
              : null;
        await sql`
          UPDATE data.share_links
          SET access_mode = ${accessMode},
              password_hash = ${passwordHash},
              expires_at = ${expiresAt},
              allow_copy = ${body.allowCopy ?? share.allow_copy},
              updated_at = now()
          WHERE id = ${share.id}
        `.execute(ctx.db);
        const fresh = await loadShare(scope.baseId, pid("shr", share.id));
        void reply.send({ share: fresh ? shareToDto(fresh) : null });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; shareId: string } }>(
    "/v1/bases/:baseId/shares/:shareId",
    async (request, reply) => {
      try {
        const scope = await adminScope(request, reply, request.params.baseId);
        if (!scope) return;
        assertCan(scope.snapshot, "record.update");
        const share = await loadShare(scope.baseId, request.params.shareId);
        if (!share) {
          notFound(request, reply, "Share not found");
          return;
        }
        await sql`
          UPDATE data.share_links
          SET revoked_at = COALESCE(revoked_at, now()), revoked_by = ${scope.user.id}, updated_at = now()
          WHERE id = ${share.id}
        `.execute(ctx.db);
        await writeAuditEvent(ctx.db, {
          orgId: scope.base.orgId,
          workspaceId: scope.base.workspaceId,
          actorUserId: scope.user.id,
          action: "share.revoked",
          targetType: "share_link",
          targetId: share.id,
          metadata: {},
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        });
        void reply.code(204).send();
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; shareId: string } }>(
    "/v1/bases/:baseId/shares/:shareId/regenerate",
    async (request, reply) => {
      try {
        const scope = await adminScope(request, reply, request.params.baseId);
        if (!scope) return;
        assertCan(scope.snapshot, "record.update");
        const share = await loadShare(scope.baseId, request.params.shareId);
        if (!share || share.revoked_at) {
          notFound(request, reply, "Share not found");
          return;
        }
        const { token, tokenPrefix, tokenHash } = createShareToken();
        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            DELETE FROM core.public_link_directory WHERE share_link_id = ${share.id}
          `.execute(trx);
          await sql`
            UPDATE data.share_links
            SET token = ${token}, token_hash = ${tokenHash}, token_prefix = ${tokenPrefix},
                updated_at = now()
            WHERE id = ${share.id}
          `.execute(trx);
          await sql`
            INSERT INTO core.public_link_directory (
              token_prefix, workspace_id, shard_id, share_link_id, kind
            ) VALUES (
              ${tokenPrefix}, ${scope.base.workspaceId}, ${scope.base.shardId}, ${share.id}, 'share_link'
            )
          `.execute(trx);
        });
        const fresh = await loadShare(scope.baseId, pid("shr", share.id));
        void reply.send({ share: fresh ? shareToDto(fresh) : null });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  // ─────────────────────────── Public (token) ───────────────────────────

  /** Resolve + password gate. Sends the problem response on failure. */
  async function publicShare(
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
  ): Promise<ResolvedShare | null> {
    const res = await findShareByToken(ctx.db, token);
    if (!res.ok) {
      if (res.status === 410) {
        const msg =
          res.reason === "expired"
            ? "This link has expired"
            : res.reason === "revoked"
              ? "This link has been disabled"
              : "The shared content no longer exists";
        gone(request, reply, msg, res.reason);
      } else {
        notFound(request, reply, "Share link not found");
      }
      return null;
    }
    if (res.link.access_mode === "password") {
      const unlock = header(request, "x-share-unlock");
      if (checkUnlockToken(ctx, res.link, unlock)) return res;
      const password = header(request, "x-share-password");
      if (password && res.link.password_hash) {
        if (await verifyPassword(password, res.link.password_hash)) return res;
        passwordRequired(request, reply, true);
        return null;
      }
      passwordRequired(request, reply, false);
      return null;
    }
    return res;
  }

  /** Table + view the request addresses (base shares may pick any table/view). */
  async function targetOf(
    link: ShareLinkRow,
    tableParam?: string,
    viewParam?: string,
  ): Promise<{ tableId: string; view: LoadedView | null } | { error: string }> {
    if (link.target_type !== "base") {
      const view = await loadView(ctx.db, link.target_id);
      if (!view) return { error: "View not found" };
      return { tableId: view.tableId, view };
    }
    let tableId: string | null = null;
    if (tableParam) tableId = parsePid(tableParam, "tbl");
    let view: LoadedView | null = null;
    if (viewParam) {
      view = await loadView(ctx.db, parsePid(viewParam, "viw"));
      if (!view || view.type === "form") return { error: "View not found" };
      if (tableId && view.tableId !== tableId) return { error: "View not in table" };
      tableId = view.tableId;
    }
    if (!tableId) {
      const first = await sql<{ id: string }>`
        SELECT id FROM data.tables WHERE base_id = ${link.base_id} AND deleted_at IS NULL
        ORDER BY order_key COLLATE "C" ASC LIMIT 1
      `.execute(ctx.db);
      tableId = first.rows[0]?.id ?? null;
    }
    if (!tableId) return { error: "Table not found" };
    const ok = await sql<{ id: string }>`
      SELECT id FROM data.tables WHERE id = ${tableId} AND base_id = ${link.base_id} AND deleted_at IS NULL
    `.execute(ctx.db);
    if (!ok.rows[0]) return { error: "Table not found" };
    return { tableId, view };
  }

  app.get<{ Params: { token: string } }>(
    "/v1/public/shares/:token",
    async (request, reply) => {
      try {
        const resolved = await publicShare(request, reply, request.params.token);
        if (!resolved) return;
        const link = resolved.link;
        const baseRow = await sql<{ name: string }>`
          SELECT name FROM data.bases WHERE id = ${link.base_id} LIMIT 1
        `.execute(ctx.db);
        const baseName = baseRow.rows[0]?.name ?? "Base";
        const common = {
          share: {
            id: pid("shr", link.id),
            targetType: link.target_type,
            allowCopy: link.allow_copy,
            expiresAt: link.expires_at?.toISOString() ?? null,
          },
          base: { id: pid("bas", link.base_id), name: baseName },
        };

        if (link.target_type === "base") {
          const tables = await sql<{ id: string; name: string }>`
            SELECT id, name FROM data.tables WHERE base_id = ${link.base_id} AND deleted_at IS NULL
            ORDER BY order_key COLLATE "C" ASC
          `.execute(ctx.db);
          const out = [];
          for (const t of tables.rows) {
            const { rows, primaryFieldId } = await loadPublicFields(ctx.db, t.id);
            const views = await sql<{ id: string; name: string; type: string }>`
              SELECT id, name, type FROM data.views
              WHERE table_id = ${t.id} AND deleted_at IS NULL AND type <> 'form'
                AND visibility <> 'personal'
              ORDER BY order_key COLLATE "C" ASC
            `.execute(ctx.db);
            out.push({
              id: pid("tbl", t.id),
              name: t.name,
              primaryFieldId: primaryFieldId ? pid("fld", primaryFieldId) : null,
              fields: rows.map((r) => toPublicFieldDto(r, primaryFieldId)),
              views: views.rows.map((v) => ({ id: pid("viw", v.id), name: v.name, type: v.type })),
            });
          }
          const first = out[0];
          void reply.send({
            ...common,
            kind: "base",
            title: baseName,
            description: null,
            table: first ? { id: first.id, name: first.name } : null,
            fields: first?.fields ?? [],
            tables: out,
          });
          return;
        }

        const view = await loadView(ctx.db, link.target_id);
        if (!view) {
          gone(request, reply, "The shared content no longer exists", "target_deleted");
          return;
        }
        const { rows, primaryFieldId, tableName } = await loadPublicFields(ctx.db, view.tableId);

        if (link.target_type === "form") {
          const specs = formFieldSpecs(rows, primaryFieldId, view.config);
          const form = view.config.form;
          void reply.send({
            ...common,
            kind: "form",
            title: form?.title?.trim() || view.name,
            description: form?.description ?? view.description ?? null,
            table: { id: pid("tbl", view.tableId), name: tableName },
            view: { id: pid("viw", view.id), name: view.name, type: view.type },
            fields: specs.map((s) => toPublicFieldDto(s.field, primaryFieldId)),
            form: {
              title: form?.title?.trim() || view.name,
              description: form?.description ?? "",
              submitLabel: form?.submitLabel || "Submit",
              successMessage: form?.successMessage || "Thank you for submitting the form!",
              allowResubmit: form?.allowResubmit ?? true,
              fields: specs.map((s) => ({
                fieldId: pid("fld", s.field.id),
                required: s.required,
                label: s.label,
                help: s.help,
              })),
            },
          });
          return;
        }

        const visible = visibleFieldsForView(rows, primaryFieldId, view.config);
        void reply.send({
          ...common,
          kind: "view",
          title: view.name,
          description: view.description || null,
          table: { id: pid("tbl", view.tableId), name: tableName },
          view: {
            id: pid("viw", view.id),
            name: view.name,
            type: view.type,
            config: publicViewConfig(view.config),
          },
          primaryFieldId: primaryFieldId ? pid("fld", primaryFieldId) : null,
          fields: visible.map((r) => toPublicFieldDto(r, primaryFieldId)),
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.post<{ Params: { token: string } }>(
    "/v1/public/shares/:token/unlock",
    async (request, reply) => {
      try {
        const res = await findShareByToken(ctx.db, request.params.token);
        if (!res.ok) {
          if (res.status === 410) gone(request, reply, "This link is no longer available", res.reason);
          else notFound(request, reply, "Share link not found");
          return;
        }
        if (await hitRateLimit(ctx, `unlock:${res.link.id}:${request.ip}`, 10, 300)) {
          tooManyRequests(request, reply, "Too many attempts. Try again in a few minutes.");
          return;
        }
        const body = z.object({ password: z.string().max(200) }).parse(request.body);
        if (res.link.access_mode !== "password" || !res.link.password_hash) {
          const t = issueUnlockToken(ctx, res.link);
          void reply.send({ unlockToken: t.token, expiresAt: t.expiresAt });
          return;
        }
        if (!(await verifyPassword(body.password, res.link.password_hash))) {
          passwordRequired(request, reply, true);
          return;
        }
        const t = issueUnlockToken(ctx, res.link);
        void reply.send({ unlockToken: t.token, expiresAt: t.expiresAt });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  /** Re-hydrate attachment values with signed public URLs, strip hidden fields. */
  async function publicRecords(
    input: readonly object[],
    visible: PublicFieldRow[],
  ): Promise<Record<string, unknown>[]> {
    const records = input as unknown as Record<string, unknown>[];
    const visibleIds = new Set(visible.map((f) => pid("fld", f.id)));
    const attFields = visible.filter((f) => f.type === "attachment").map((f) => pid("fld", f.id));
    const attIds: string[] = [];
    for (const rec of records) {
      const fields = (rec["fields"] ?? {}) as Record<string, unknown>;
      for (const fid of attFields) attIds.push(...attachmentIdsFromCell(fields[fid]));
    }
    const atts = await hydrateAttachments(ctx.db, attIds);
    return records.map((rec) => {
      const fields = (rec["fields"] ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (!visibleIds.has(k)) continue;
        if (attFields.includes(k)) {
          const list = attachmentIdsFromCell(v)
            .map((id) => atts.get(id))
            .filter(Boolean);
          if (list.length) out[k] = list;
          continue;
        }
        out[k] = v;
      }
      const errors = rec["errors"] as Record<string, string> | undefined;
      const visibleErrors = errors
        ? Object.fromEntries(Object.entries(errors).filter(([k]) => visibleIds.has(k)))
        : undefined;
      return {
        id: rec["id"],
        createdAt: rec["createdAt"],
        rowNumber: rec["rowNumber"],
        fields: out,
        ...(visibleErrors && Object.keys(visibleErrors).length ? { errors: visibleErrors } : {}),
      };
    });
  }

  async function readableScope(link: ShareLinkRow, tableParam?: string, viewParam?: string) {
    if (link.target_type === "form") return { error: "Form shares do not expose records" } as const;
    const target = await targetOf(link, tableParam, viewParam);
    if ("error" in target) return target;
    const { rows, primaryFieldId } = await loadPublicFields(ctx.db, target.tableId);
    const visible =
      link.target_type === "base" && !target.view
        ? rows
        : visibleFieldsForView(rows, primaryFieldId, target.view?.config ?? null);
    return { ...target, visible, primaryFieldId } as const;
  }

  app.post<{ Params: { token: string } }>(
    "/v1/public/shares/:token/records/query",
    async (request, reply) => {
      try {
        const resolved = await publicShare(request, reply, request.params.token);
        if (!resolved) return;
        const body = publicQueryBody.parse(request.body ?? {});
        const scope = await readableScope(resolved.link, body.tableId, body.viewId);
        if ("error" in scope) {
          notFound(request, reply, scope.error);
          return;
        }
        const visiblePids = new Set(scope.visible.map((f) => pid("fld", f.id)));
        const parts: unknown[] = [];
        if (scope.view?.config.filter) parts.push(scope.view.config.filter);
        const q = body.search?.trim();
        if (q) {
          const searchable = scope.visible.filter((f) => TEXT_SEARCH_TYPES.has(f.type));
          if (searchable.length === 0) {
            void reply.send({ records: [], nextCursor: null });
            return;
          }
          parts.push({
            kind: "or",
            children: searchable.map((f) => ({
              kind: "condition",
              fieldId: pid("fld", f.id),
              op: "contains",
              value: q,
            })),
          });
        }
        const filter =
          parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { kind: "and", children: parts };
        const requestedSort = (body.sort ?? []).filter((s) => visiblePids.has(s.field));
        const sort =
          requestedSort.length > 0
            ? requestedSort.map((s) => ({ fieldId: s.field, direction: s.direction }))
            : (scope.view?.config.sorts ?? []).map((s) => ({ fieldId: s.fieldId, direction: s.direction }));

        const result = await executeRecordQuery(ctx.db, scope.tableId, {
          pageSize: body.pageSize ?? 100,
          ...(filter !== undefined ? { filter } : {}),
          ...(sort.length ? { sort } : {}),
          ...(body.cursor ? { cursor: body.cursor } : {}),
        });
        void reply.send({
          records: await publicRecords(result.records, scope.visible),
          nextCursor: result.nextCursor,
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.get<{ Params: { token: string; recordId: string }; Querystring: { tableId?: string; viewId?: string } }>(
    "/v1/public/shares/:token/records/:recordId",
    async (request, reply) => {
      try {
        const resolved = await publicShare(request, reply, request.params.token);
        if (!resolved) return;
        const scope = await readableScope(resolved.link, request.query.tableId, request.query.viewId);
        if ("error" in scope) {
          notFound(request, reply, scope.error);
          return;
        }
        const recordId = parsePid(request.params.recordId, "rec");
        // Must match the view filter: run the query restricted to this id.
        const parts: unknown[] = [];
        if (scope.view?.config.filter) parts.push(scope.view.config.filter);
        const result = await executeRecordQuery(ctx.db, scope.tableId, {
          pageSize: 500,
          ...(parts.length ? { filter: parts[0] } : {}),
        });
        const wantId = pid("rec", recordId);
        let found: object | undefined = result.records.find((r) => r.id === wantId);
        let cursor = result.nextCursor;
        while (!found && cursor) {
          const page = await executeRecordQuery(ctx.db, scope.tableId, {
            pageSize: 500,
            cursor,
            ...(parts.length ? { filter: parts[0] } : {}),
          });
          found = page.records.find((r) => r.id === wantId);
          cursor = page.nextCursor;
        }
        if (!found) {
          notFound(request, reply, "Record not found");
          return;
        }
        const [record] = await publicRecords([found], scope.visible);
        void reply.send({ record });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.post<{ Params: { token: string } }>(
    "/v1/public/shares/:token/submit",
    async (request, reply) => {
      try {
        const resolved = await publicShare(request, reply, request.params.token);
        if (!resolved) return;
        const link = resolved.link;
        if (link.target_type !== "form") {
          validationProblem(request, reply, "This share is not a form");
          return;
        }
        if (await hitRateLimit(ctx, `submit:${request.ip}`, 30, 600)) {
          tooManyRequests(request, reply, "Too many submissions. Please try again later.");
          return;
        }
        const body = z
          .object({ fields: z.record(z.unknown()) })
          .parse(request.body ?? {});
        const view = await loadView(ctx.db, link.target_id);
        if (!view) {
          gone(request, reply, "This form no longer exists", "target_deleted");
          return;
        }
        const { rows, primaryFieldId } = await loadPublicFields(ctx.db, view.tableId);
        const specs = formFieldSpecs(rows, primaryFieldId, view.config);

        // Attachments must have been uploaded through this share.
        const shareUploads = new Set<string>();
        const attInputs: string[] = [];
        for (const s of specs) {
          if (s.field.type !== "attachment") continue;
          const v = body.fields[pid("fld", s.field.id)];
          for (const item of Array.isArray(v) ? v : v ? [v] : []) {
            const id = typeof item === "string" ? item : (item as { id?: string })?.id;
            if (id) attInputs.push(id);
          }
        }
        if (attInputs.length) {
          const raw = attInputs
            .map((id) => {
              try {
                return String(decodePublicId(id, "att").uuid);
              } catch {
                return "";
              }
            })
            .filter((x) => x.length > 0);
          const ok = await sql<{ id: string }>`
            SELECT id FROM data.attachments
            WHERE id = ANY(${raw}::uuid[]) AND share_link_id = ${link.id} AND scan_status = 'clean'
          `.execute(ctx.db);
          for (const r of ok.rows) shareUploads.add(r.id);
        }
        const resolveAttachment = (id: string): string => {
          let raw: string;
          try {
            raw = String(decodePublicId(id, "att").uuid);
          } catch {
            throw new FormValueError("Invalid attachment");
          }
          if (!shareUploads.has(raw)) throw new FormValueError("Attachment upload not found");
          return raw;
        };

        const cells: Record<string, unknown> = {};
        const errors: { field: string; message: string }[] = [];
        for (const s of specs) {
          const key = pid("fld", s.field.id);
          const input = body.fields[key];
          if (isEmptyInput(input)) {
            if (s.required) errors.push({ field: key, message: `${s.label} is required` });
            continue;
          }
          try {
            const value = coerceFormValue(s.field, input, resolveAttachment);
            if (value !== undefined) cells[String(s.field.slot)] = value;
            else if (s.required) errors.push({ field: key, message: `${s.label} is required` });
          } catch (e) {
            errors.push({
              field: key,
              message: e instanceof FormValueError ? e.message : "Invalid value",
            });
          }
        }
        if (errors.length) {
          validationProblem(request, reply, "Please fix the highlighted fields", errors);
          return;
        }

        await limits.assertCanCreateRecord(resolved.orgId, link.base_id, 1);
        const [recordId] = await createRecordsBySlot(
          ctx,
          {
            orgId: resolved.orgId,
            workspaceId: link.workspace_id,
            baseId: link.base_id,
            tableId: view.tableId,
            actor: { actorType: "system", actorId: null, via: "api" },
            userId: null,
            via: "form",
          },
          [cells],
        );
        if (recordId) {
          await sql`
            UPDATE data.attachments SET record_id = ${recordId}, table_id = ${view.tableId}
            WHERE share_link_id = ${link.id} AND id = ANY(${[...shareUploads]}::uuid[])
          `.execute(ctx.db);
          await sql`
            INSERT INTO data.share_submissions (share_link_id, workspace_id, base_id, record_id, ip)
            VALUES (${link.id}, ${link.workspace_id}, ${link.base_id}, ${recordId}, ${request.ip})
          `.execute(ctx.db);
        }
        const form = view.config.form;
        void reply.code(201).send({
          ok: true,
          record: { id: recordId ? pid("rec", recordId) : null },
          successMessage: form?.successMessage || "Thank you for submitting the form!",
          allowResubmit: form?.allowResubmit ?? true,
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  // Public form attachment uploads (presign → PUT → complete).
  app.post<{ Params: { token: string } }>(
    "/v1/public/shares/:token/attachments/presign",
    async (request, reply) => {
      try {
        const resolved = await publicShare(request, reply, request.params.token);
        if (!resolved) return;
        const link = resolved.link;
        if (link.target_type !== "form") {
          validationProblem(request, reply, "Uploads are only allowed on forms");
          return;
        }
        if (await hitRateLimit(ctx, `upload:${request.ip}`, 60, 600)) {
          tooManyRequests(request, reply, "Too many uploads. Please try again later.");
          return;
        }
        const body = z
          .object({
            filename: z.string().min(1).max(255),
            mime: z.string().max(200).optional().default("application/octet-stream"),
            size: z.number().int().nonnegative(),
          })
          .parse(request.body);
        await limits.assertAttachmentBytes(resolved.orgId, link.base_id, body.size);
        const token = encodeURIComponent(request.params.token);
        const { attachmentId, upload } = await createPendingUpload(ctx, {
          workspaceId: link.workspace_id,
          baseId: link.base_id,
          userId: null,
          shareLinkId: link.id,
          filename: body.filename,
          mime: body.mime,
          size: body.size,
          maxBytes: MAX_PUBLIC_UPLOAD_BYTES,
          apiUploadUrl: (id) => `/v1/public/shares/${token}/attachments/${pid("att", id)}/upload`,
        });
        void reply.code(201).send({ attachmentId: pid("att", attachmentId), upload });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: MAX_PUBLIC_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );
    sub.put<{ Params: { token: string; attachmentId: string } }>(
      "/v1/public/shares/:token/attachments/:attachmentId/upload",
      { bodyLimit: MAX_PUBLIC_UPLOAD_BYTES },
      async (request, reply) => {
        try {
          const resolved = await publicShare(request, reply, request.params.token);
          if (!resolved) return;
          const attId = parsePid(request.params.attachmentId, "att");
          const row = await loadAttachment(ctx.db, attId, resolved.link.base_id);
          if (!row || row.share_link_id !== resolved.link.id) {
            notFound(request, reply, "Upload not found");
            return;
          }
          const buf = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
          await storeUploadBody(ctx, row, buf, MAX_PUBLIC_UPLOAD_BYTES);
          void reply.code(204).send();
        } catch (err) {
          handleWave4Error(request, reply, err);
        }
      },
    );
  });

  app.post<{ Params: { token: string } }>(
    "/v1/public/shares/:token/attachments/complete",
    async (request, reply) => {
      try {
        const resolved = await publicShare(request, reply, request.params.token);
        if (!resolved) return;
        const body = z.object({ attachmentId: z.string() }).parse(request.body);
        const attId = parsePid(body.attachmentId, "att");
        const row = await loadAttachment(ctx.db, attId, resolved.link.base_id);
        if (!row || row.share_link_id !== resolved.link.id) {
          notFound(request, reply, "Upload not found");
          return;
        }
        const attachment = await finalizeUpload(ctx, row, MAX_PUBLIC_UPLOAD_BYTES);
        void reply.send({ attachment });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );
}
