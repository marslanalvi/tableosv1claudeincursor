import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { authorize, type PermissionSnapshot } from "@tabula/permissions";
import { isFilterError } from "@tabula/filter";
import { generateUuidV7, keyBetween } from "@tabula/types";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { ApiError, handleRouteError, notFound, validationProblem } from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";
import { compileForUser } from "../access/compile.js";
import { executeRecordQuery, QueryNotFoundError } from "../query/execute-record-query.js";
import { executeGroupQuery, type AggregateOp } from "../query/group-query.js";
import { loadUserQueryContext } from "../query/context.js";
import type { FilterAstJson } from "../views/config.js";
import {
  EMPTY_LAYOUT,
  PAGE_KINDS,
  pageLayoutSchema,
  readLayout,
  sourceOf,
  validatePages,
  type AggFn,
  type InterfaceElement,
  type PageLayout,
  type SchemaIndex,
} from "./model.js";

/* ───────────────────────── rows & DTOs ───────────────────────── */

interface InterfaceRow {
  id: string;
  workspace_id: string;
  base_id: string;
  name: string;
  description: string;
  icon: string;
  theme: Record<string, unknown>;
  navigation: Record<string, unknown>;
  draft_revision: number;
  published_version_id: string | null;
  published_revision: number | null;
  published_at: Date | null;
  status: "draft_only" | "published" | "unpublished";
  order_key: string;
  created_at: Date;
  updated_at: Date;
}

interface PageRow {
  id: string;
  interface_id: string;
  name: string;
  kind: string;
  layout: unknown;
  page_revision: number;
  order_key: string;
  updated_at: Date;
}

interface Snapshot {
  interface: { name: string; description: string; icon: string; theme: Record<string, unknown> };
  pages: Array<{ id: string; name: string; kind: string; layout: PageLayout }>;
  draftRevision: number;
}

function interfaceDto(r: InterfaceRow, extra: { pageCount?: number; versionNo?: number | null } = {}) {
  return {
    id: pid("itf", r.id),
    name: r.name,
    description: r.description,
    icon: r.icon,
    status: r.status,
    draftRevision: r.draft_revision,
    publishedRevision: r.published_revision,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    publishedVersionNo: extra.versionNo ?? null,
    hasUnpublishedChanges: r.status === "draft_only" || r.published_revision !== r.draft_revision,
    pageCount: extra.pageCount ?? 0,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function pageDto(p: PageRow) {
  return {
    id: pid("pag", p.id),
    name: p.name,
    kind: p.kind,
    layout: readLayout(p.layout),
    pageRevision: p.page_revision,
    updatedAt: new Date(p.updated_at).toISOString(),
  };
}

/* ───────────────────────── bodies ───────────────────────── */

const createBody = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  icon: z.string().max(8).optional(),
  pages: z
    .array(z.object({ name: z.string().trim().min(1).max(255), kind: z.enum(PAGE_KINDS).default("dashboard"), layout: pageLayoutSchema.optional() }))
    .max(20)
    .optional(),
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(8).optional(),
});

const pageCreateBody = z.object({
  name: z.string().trim().min(1).max(255),
  kind: z.enum(PAGE_KINDS).default("dashboard"),
  layout: pageLayoutSchema.optional(),
});

const pagePatchBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  kind: z.enum(PAGE_KINDS).optional(),
  layout: pageLayoutSchema.optional(),
  /** Optimistic concurrency (architecture 13 §15.2): 409 when someone else saved first. */
  expectedRevision: z.number().int().optional(),
});

const elementQueryBody = z.object({
  draft: z.boolean().optional(),
  search: z.string().max(500).optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().nullish(),
  context: z.object({ selections: z.record(z.string(), z.string()).optional() }).optional(),
});

/* ───────────────────────── helpers ───────────────────────── */

const AGG_OP: Record<AggFn, AggregateOp> = {
  count: "count",
  sum: "sum",
  avg: "avg",
  min: "min",
  max: "max",
  count_unique: "unique",
};

async function nextKey(db: AppContext["db"], table: "interfaces" | "interface_pages", scopeCol: string, scopeId: string): Promise<string> {
  const r = await sql<{ order_key: string }>`
    SELECT order_key FROM ${sql.table(`data.${table}`)}
    WHERE ${sql.ref(scopeCol)} = ${scopeId} AND deleted_at IS NULL
    ORDER BY order_key DESC LIMIT 1
  `.execute(db);
  try {
    return keyBetween(r.rows[0]?.order_key ?? null, null);
  } catch {
    return keyBetween(null, null);
  }
}

async function loadSchemaIndex(db: AppContext["db"], baseId: string): Promise<SchemaIndex> {
  const tables = await sql<{ id: string; name: string }>`
    SELECT id, name FROM data.tables WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db);
  const fields = await sql<{ id: string; table_id: string; name: string; type: string }>`
    SELECT id, table_id, name, type FROM data.fields WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db);
  const views = await sql<{ id: string; table_id: string }>`
    SELECT id, table_id FROM data.views WHERE base_id = ${baseId} AND deleted_at IS NULL AND visibility <> 'personal'
  `.execute(db);
  const index: SchemaIndex = { tables: new Map() };
  for (const t of tables.rows) index.tables.set(pid("tbl", t.id), { name: t.name, fields: new Map(), views: new Set() });
  for (const f of fields.rows) index.tables.get(pid("tbl", f.table_id))?.fields.set(pid("fld", f.id), { name: f.name, type: f.type });
  for (const v of views.rows) index.tables.get(pid("tbl", v.table_id))?.views.add(pid("viw", v.id));
  return index;
}

function and(...nodes: Array<FilterAstJson | null | undefined>): FilterAstJson | null {
  const kids = nodes.filter((n): n is FilterAstJson => !!n);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0]!;
  return { kind: "and", children: kids };
}

/* ───────────────────────── routes ───────────────────────── */

export async function registerInterfaceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  type Scope = { userId: string; baseId: string; workspaceId: string; snapshot: PermissionSnapshot; canBuild: boolean };

  async function scope(request: FastifyRequest<{ Params: { baseId: string } }>, reply: FastifyReply, needBuild = false): Promise<Scope | null> {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return null;
    }
    const baseId = parsePid(request.params.baseId, "bas");
    const base = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!base.ok) {
      notFound(request, reply, "Base not found");
      return null;
    }
    const snapshot = await compileForUser(ctx.db, user.id, baseId);
    const canBuild = authorize(snapshot, "base.manage_schema");
    if (needBuild && !canBuild) throw new ApiError(403, "FORBIDDEN", "Only base creators can edit interfaces");
    return { userId: user.id, baseId, workspaceId: base.workspaceId, snapshot, canBuild };
  }

  async function loadInterface(s: Scope, itfPid: string): Promise<InterfaceRow> {
    const id = parsePid(itfPid, "itf");
    const r = await sql<InterfaceRow>`
      SELECT * FROM data.interfaces WHERE id = ${id} AND base_id = ${s.baseId} AND deleted_at IS NULL
    `.execute(ctx.db);
    const row = r.rows[0];
    if (!row || (!s.canBuild && row.status !== "published")) throw new ApiError(404, "NOT_FOUND", "Interface not found");
    return row;
  }

  async function loadPages(interfaceId: string): Promise<PageRow[]> {
    const r = await sql<PageRow>`
      SELECT id, interface_id, name, kind, layout, page_revision, order_key, updated_at
      FROM data.interface_pages WHERE interface_id = ${interfaceId} AND deleted_at IS NULL
      ORDER BY order_key ASC
    `.execute(ctx.db);
    return r.rows;
  }

  async function loadSnapshot(row: InterfaceRow): Promise<{ versionNo: number; snapshot: Snapshot } | null> {
    if (!row.published_version_id) return null;
    const r = await sql<{ version_no: number; snapshot: Snapshot }>`
      SELECT version_no, snapshot FROM data.interface_versions WHERE id = ${row.published_version_id}
    `.execute(ctx.db);
    const v = r.rows[0];
    return v ? { versionNo: v.version_no, snapshot: v.snapshot } : null;
  }

  async function touch(interfaceId: string): Promise<void> {
    await sql`
      UPDATE data.interfaces SET draft_revision = draft_revision + 1, updated_at = now() WHERE id = ${interfaceId}
    `.execute(ctx.db);
  }

  async function insertPage(s: Scope, interfaceId: string, p: { name: string; kind: string; layout?: PageLayout }): Promise<PageRow> {
    const key = await nextKey(ctx.db, "interface_pages", "interface_id", interfaceId);
    const r = await sql<PageRow>`
      INSERT INTO data.interface_pages (id, interface_id, workspace_id, base_id, name, kind, layout, order_key, created_by, updated_by)
      VALUES (${generateUuidV7()}, ${interfaceId}, ${s.workspaceId}, ${s.baseId}, ${p.name}, ${p.kind},
              ${JSON.stringify(p.layout ?? EMPTY_LAYOUT)}::jsonb, ${key}, ${s.userId}, ${s.userId})
      RETURNING id, interface_id, name, kind, layout, page_revision, order_key, updated_at
    `.execute(ctx.db);
    return r.rows[0]!;
  }

  function wrap<P>(fn: (request: FastifyRequest<{ Params: P }>, reply: FastifyReply) => Promise<void>) {
    return async (request: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
      try {
        await fn(request, reply);
      } catch (err) {
        if (isFilterError(err)) {
          validationProblem(request, reply, err.message, [{ field: err.fieldId ? `filter:${err.fieldId}` : "filter", message: err.code }]);
          return;
        }
        if (err instanceof QueryNotFoundError) {
          notFound(request, reply, err.message);
          return;
        }
        handleRouteError(request, reply, err);
      }
    };
  }

  type B = { baseId: string };
  type I = B & { interfaceId: string };
  type P = I & { pageId: string };
  type E = P & { elementId: string };

  /* list / create */

  app.get<{ Params: B }>(
    "/v1/bases/:baseId/interfaces",
    wrap<B>(async (request, reply) => {
      const s = await scope(request, reply);
      if (!s) return;
      const rows = await sql<InterfaceRow & { page_count: number; version_no: number | null }>`
        SELECT i.*,
          (SELECT count(*)::int FROM data.interface_pages p WHERE p.interface_id = i.id AND p.deleted_at IS NULL) AS page_count,
          (SELECT v.version_no FROM data.interface_versions v WHERE v.id = i.published_version_id) AS version_no
        FROM data.interfaces i
        WHERE i.base_id = ${s.baseId} AND i.deleted_at IS NULL
          AND (${s.canBuild} OR i.status = 'published')
        ORDER BY i.order_key ASC
      `.execute(ctx.db);
      void reply.send({
        canBuild: s.canBuild,
        interfaces: rows.rows.map((r) => interfaceDto(r, { pageCount: r.page_count, versionNo: r.version_no })),
      });
    }),
  );

  app.post<{ Params: B }>(
    "/v1/bases/:baseId/interfaces",
    wrap<B>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const body = createBody.parse(request.body ?? {});
      const key = await nextKey(ctx.db, "interfaces", "base_id", s.baseId);
      const id = generateUuidV7();
      const r = await sql<InterfaceRow>`
        INSERT INTO data.interfaces (id, workspace_id, base_id, name, description, icon, order_key, created_by)
        VALUES (${id}, ${s.workspaceId}, ${s.baseId}, ${body.name}, ${body.description ?? ""}, ${body.icon ?? "◧"}, ${key}, ${s.userId})
        RETURNING *
      `.execute(ctx.db);
      const pages = body.pages?.length ? body.pages : [{ name: "Page 1", kind: "dashboard" as const }];
      const made: PageRow[] = [];
      for (const p of pages) made.push(await insertPage(s, id, { name: p.name, kind: p.kind, ...(p.layout ? { layout: p.layout } : {}) }));
      void reply.code(201).send({ interface: interfaceDto(r.rows[0]!, { pageCount: made.length }), pages: made.map(pageDto) });
    }),
  );

  /* one interface (draft for builders, published manifest otherwise) */

  app.get<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const published = await loadSnapshot(row);
      if (!s.canBuild) {
        void reply.send({
          canBuild: false,
          interface: interfaceDto(row, { pageCount: published?.snapshot.pages.length ?? 0, versionNo: published?.versionNo ?? null }),
          pages: [],
        });
        return;
      }
      const pages = await loadPages(row.id);
      void reply.send({
        canBuild: true,
        interface: interfaceDto(row, { pageCount: pages.length, versionNo: published?.versionNo ?? null }),
        pages: pages.map(pageDto),
      });
    }),
  );

  app.patch<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const body = patchBody.parse(request.body ?? {});
      const r = await sql<InterfaceRow>`
        UPDATE data.interfaces SET
          name = ${body.name ?? row.name},
          description = ${body.description ?? row.description},
          icon = ${body.icon ?? row.icon},
          draft_revision = draft_revision + 1,
          updated_at = now()
        WHERE id = ${row.id}
        RETURNING *
      `.execute(ctx.db);
      void reply.send({ interface: interfaceDto(r.rows[0]!) });
    }),
  );

  app.delete<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      await sql`
        UPDATE data.interfaces SET deleted_at = now(), deleted_by = ${s.userId}, updated_at = now() WHERE id = ${row.id}
      `.execute(ctx.db);
      void reply.code(204).send();
    }),
  );

  /* pages */

  app.post<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/pages",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const body = pageCreateBody.parse(request.body ?? {});
      const page = await insertPage(s, row.id, { name: body.name, kind: body.kind, ...(body.layout ? { layout: body.layout } : {}) });
      await touch(row.id);
      void reply.code(201).send({ page: pageDto(page) });
    }),
  );

  app.patch<{ Params: P }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/pages/:pageId",
    wrap<P>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const pageId = parsePid(request.params.pageId, "pag");
      const body = pagePatchBody.parse(request.body ?? {});
      const cur = (await loadPages(row.id)).find((p) => p.id === pageId);
      if (!cur) throw new ApiError(404, "NOT_FOUND", "Page not found");
      if (body.expectedRevision !== undefined && body.expectedRevision !== cur.page_revision) {
        throw new ApiError(409, "PAGE_REVISION_CONFLICT", "Someone else changed this page. Reload to see their changes.", {
          currentRevision: cur.page_revision,
        });
      }
      const r = await sql<PageRow>`
        UPDATE data.interface_pages SET
          name = ${body.name ?? cur.name},
          kind = ${body.kind ?? cur.kind},
          layout = ${JSON.stringify(body.layout ?? readLayout(cur.layout))}::jsonb,
          page_revision = page_revision + 1,
          updated_by = ${s.userId},
          updated_at = now()
        WHERE id = ${pageId}
        RETURNING id, interface_id, name, kind, layout, page_revision, order_key, updated_at
      `.execute(ctx.db);
      await touch(row.id);
      void reply.send({ page: pageDto(r.rows[0]!) });
    }),
  );

  app.delete<{ Params: P }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/pages/:pageId",
    wrap<P>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const pageId = parsePid(request.params.pageId, "pag");
      const pages = await loadPages(row.id);
      if (!pages.some((p) => p.id === pageId)) throw new ApiError(404, "NOT_FOUND", "Page not found");
      if (pages.length <= 1) throw new ApiError(409, "LAST_PAGE", "An interface needs at least one page");
      await sql`UPDATE data.interface_pages SET deleted_at = now() WHERE id = ${pageId}`.execute(ctx.db);
      await touch(row.id);
      void reply.code(204).send();
    }),
  );

  app.post<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/pages/reorder",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const body = z.object({ pageIds: z.array(z.string()).min(1).max(100) }).parse(request.body ?? {});
      let prev: string | null = null;
      for (const p of body.pageIds) {
        const key = keyBetween(prev, null);
        await sql`
          UPDATE data.interface_pages SET order_key = ${key}
          WHERE id = ${parsePid(p, "pag")} AND interface_id = ${row.id}
        `.execute(ctx.db);
        prev = key;
      }
      await touch(row.id);
      void reply.code(204).send();
    }),
  );

  /* publishing (architecture 13 §13.2) */

  app.post<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/publish",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const body = z.object({ releaseNote: z.string().max(1000).optional() }).parse(request.body ?? {});
      const pages = (await loadPages(row.id)).map((p) => ({ id: pid("pag", p.id), name: p.name, kind: p.kind, layout: readLayout(p.layout) }));
      const diagnostics = validatePages(pages, await loadSchemaIndex(ctx.db, s.baseId));
      if (diagnostics.some((d) => d.severity === "error")) {
        throw new ApiError(422, "INTERFACE_INVALID", "Fix the problems on these pages before publishing", { diagnostics });
      }
      const snapshot: Snapshot = {
        interface: { name: row.name, description: row.description, icon: row.icon, theme: row.theme },
        pages,
        draftRevision: row.draft_revision,
      };
      const versionId = generateUuidV7();
      const result = await ctx.db.transaction().execute(async (trx) => {
        await sql`SELECT 1 FROM data.interfaces WHERE id = ${row.id} FOR UPDATE`.execute(trx);
        const n = await sql<{ n: number }>`
          SELECT COALESCE(max(version_no), 0)::int + 1 AS n FROM data.interface_versions WHERE interface_id = ${row.id}
        `.execute(trx);
        const versionNo = n.rows[0]!.n;
        await sql`
          INSERT INTO data.interface_versions (id, interface_id, workspace_id, base_id, version_no, snapshot, published_by, release_note)
          VALUES (${versionId}, ${row.id}, ${s.workspaceId}, ${s.baseId}, ${versionNo}, ${JSON.stringify(snapshot)}::jsonb,
                  ${s.userId}, ${body.releaseNote ?? ""})
        `.execute(trx);
        const u = await sql<InterfaceRow>`
          UPDATE data.interfaces SET published_version_id = ${versionId}, published_revision = draft_revision,
            published_at = now(), status = 'published', updated_at = now()
          WHERE id = ${row.id} RETURNING *
        `.execute(trx);
        return { versionNo, row: u.rows[0]! };
      });
      void reply.send({
        interface: interfaceDto(result.row, { pageCount: pages.length, versionNo: result.versionNo }),
        versionNo: result.versionNo,
        diagnostics,
      });
    }),
  );

  app.post<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/unpublish",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const u = await sql<InterfaceRow>`
        UPDATE data.interfaces SET status = CASE WHEN published_version_id IS NULL THEN 'draft_only' ELSE 'unpublished' END,
          updated_at = now()
        WHERE id = ${row.id} RETURNING *
      `.execute(ctx.db);
      void reply.send({ interface: interfaceDto(u.rows[0]!) });
    }),
  );

  app.get<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/versions",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const r = await sql<{ id: string; version_no: number; published_at: Date; release_note: string; published_by_name: string | null }>`
        SELECT v.id, v.version_no, v.published_at, v.release_note, u.display_name AS published_by_name
        FROM data.interface_versions v LEFT JOIN core.users u ON u.id = v.published_by
        WHERE v.interface_id = ${row.id}
        ORDER BY v.version_no DESC LIMIT 50
      `.execute(ctx.db);
      void reply.send({
        versions: r.rows.map((v) => ({
          versionNo: v.version_no,
          publishedAt: new Date(v.published_at).toISOString(),
          publishedBy: v.published_by_name,
          releaseNote: v.release_note,
          current: v.id === row.published_version_id,
        })),
      });
    }),
  );

  /** Revert copies a version's pages back into the draft; it does not republish (13 §13.3). */
  app.post<{ Params: I & { versionNo: string } }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/versions/:versionNo/revert",
    wrap<I & { versionNo: string }>(async (request, reply) => {
      const s = await scope(request, reply, true);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      const v = await sql<{ snapshot: Snapshot }>`
        SELECT snapshot FROM data.interface_versions WHERE interface_id = ${row.id} AND version_no = ${Number(request.params.versionNo)}
      `.execute(ctx.db);
      const snap = v.rows[0]?.snapshot;
      if (!snap) throw new ApiError(404, "NOT_FOUND", "Version not found");
      await ctx.db.transaction().execute(async (trx) => {
        await sql`UPDATE data.interface_pages SET deleted_at = now() WHERE interface_id = ${row.id} AND deleted_at IS NULL`.execute(trx);
        let prev: string | null = null;
        for (const p of snap.pages) {
          const key = keyBetween(prev, null);
          prev = key;
          const id = parsePid(p.id, "pag");
          await sql`
            INSERT INTO data.interface_pages (id, interface_id, workspace_id, base_id, name, kind, layout, order_key, created_by, updated_by)
            VALUES (${id}, ${row.id}, ${s.workspaceId}, ${s.baseId}, ${p.name}, ${p.kind}, ${JSON.stringify(p.layout)}::jsonb, ${key}, ${s.userId}, ${s.userId})
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, layout = EXCLUDED.layout,
              order_key = EXCLUDED.order_key, deleted_at = NULL, page_revision = data.interface_pages.page_revision + 1,
              updated_by = EXCLUDED.updated_by, updated_at = now()
          `.execute(trx);
        }
        await sql`UPDATE data.interfaces SET draft_revision = draft_revision + 1, updated_at = now() WHERE id = ${row.id}`.execute(trx);
      });
      const pages = await loadPages(row.id);
      void reply.send({ pages: pages.map(pageDto) });
    }),
  );

  /* runtime (architecture 13 §11) */

  app.get<{ Params: I }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/runtime",
    wrap<I>(async (request, reply) => {
      const s = await scope(request, reply);
      if (!s) return;
      const row = await loadInterface(s, request.params.interfaceId);
      if (row.status !== "published") throw new ApiError(410, "INTERFACE_UNPUBLISHED", "This interface isn't published");
      const published = await loadSnapshot(row);
      if (!published) throw new ApiError(410, "INTERFACE_UNPUBLISHED", "This interface isn't published");
      void reply.send({
        interface: interfaceDto(row, { pageCount: published.snapshot.pages.length, versionNo: published.versionNo }),
        versionNo: published.versionNo,
        pages: published.snapshot.pages,
      });
    }),
  );

  async function resolveElement(s: Scope, request: FastifyRequest<{ Params: E }>, draft: boolean): Promise<{ el: InterfaceElement; page: PageLayout }> {
    const row = await loadInterface(s, request.params.interfaceId);
    const pagePid = request.params.pageId;
    let layout: PageLayout | undefined;
    if (draft) {
      if (!s.canBuild) throw new ApiError(403, "FORBIDDEN", "Only base creators can preview drafts");
      const pageId = parsePid(pagePid, "pag");
      const p = (await loadPages(row.id)).find((x) => x.id === pageId);
      layout = p ? readLayout(p.layout) : undefined;
    } else {
      if (row.status !== "published") throw new ApiError(410, "INTERFACE_UNPUBLISHED", "This interface isn't published");
      layout = (await loadSnapshot(row))?.snapshot.pages.find((p) => p.id === pagePid)?.layout;
    }
    const el = layout?.elements.find((e) => e.id === request.params.elementId);
    if (!layout || !el) throw new ApiError(404, "ELEMENT_NOT_FOUND", "Element not found");
    return { el, page: layout };
  }

  function tableUuid(tableId: string): string {
    return parsePid(tableId, "tbl");
  }

  /** Records for record elements; only the element's fields are returned (13 §11.2). */
  app.post<{ Params: E }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/pages/:pageId/elements/:elementId/query",
    wrap<E>(async (request, reply) => {
      const s = await scope(request, reply);
      if (!s) return;
      if (!authorize(s.snapshot, "record.read")) throw new ApiError(403, "FORBIDDEN", "You can't read records in this base");
      const body = elementQueryBody.parse(request.body ?? {});
      const { el, page } = await resolveElement(s, request, body.draft === true);
      const user = await loadUserQueryContext(ctx.db, s.userId);

      if (el.type === "table" || el.type === "record_list" || el.type === "gallery") {
        const src = el.config.dataSource;
        const fields = [...new Set([...el.config.fields.map((f) => f.fieldId), ...(el.config.titleFieldId ? [el.config.titleFieldId] : [])])];
        const limit = src.limit ?? 1000;
        const result = await executeRecordQuery(
          ctx.db,
          tableUuid(src.tableId),
          {
            filter: src.filter ?? undefined,
            viewId: src.baseViewId ?? undefined,
            sort: src.sorts,
            search: el.config.searchable ? body.search : undefined,
            pageSize: Math.min(body.pageSize ?? 100, limit),
            cursor: body.cursor ?? null,
            fields,
          },
          { user, storage: ctx.storage },
        );
        void reply.send(result);
        return;
      }

      if (el.type === "record_detail") {
        const srcId = el.config.dataSource.recordContext.elementId;
        const selected = body.context?.selections?.[srcId];
        if (!selected) {
          void reply.send({ records: [], nextCursor: null, totalCount: 0 });
          return;
        }
        const srcEl = page.elements.find((e) => e.id === srcId);
        const src = srcEl ? sourceOf(srcEl) : null;
        if (!src || src.tableId !== el.config.dataSource.tableId) throw new ApiError(404, "RECORD_NOT_IN_SCOPE", "Record not found");
        // The selected record must be visible through the source element (13 §6.2 chain verification).
        const result = await executeRecordQuery(
          ctx.db,
          tableUuid(src.tableId),
          {
            filter: and(src.filter ?? null, { kind: "condition", fieldId: "__record_id__", op: "eq", value: selected }),
            viewId: src.baseViewId ?? undefined,
            pageSize: 1,
            fields: el.config.fields.map((f) => f.fieldId),
          },
          { user, storage: ctx.storage },
        );
        if (result.records.length === 0) throw new ApiError(404, "RECORD_NOT_IN_SCOPE", "Record not found");
        void reply.send(result);
        return;
      }

      throw new ApiError(422, "VALIDATION_FAILED", `Element type ${el.type} has no records`);
    }),
  );

  /** Chart / metric aggregation, computed server-side with the element's filter (13 §10). */
  app.post<{ Params: E }>(
    "/v1/bases/:baseId/interfaces/:interfaceId/pages/:pageId/elements/:elementId/aggregate",
    wrap<E>(async (request, reply) => {
      const s = await scope(request, reply);
      if (!s) return;
      if (!authorize(s.snapshot, "record.read")) throw new ApiError(403, "FORBIDDEN", "You can't read records in this base");
      const body = elementQueryBody.parse(request.body ?? {});
      const { el } = await resolveElement(s, request, body.draft === true);
      const user = await loadUserQueryContext(ctx.db, s.userId);
      if (el.type !== "metric" && el.type !== "chart") {
        throw new ApiError(422, "VALIDATION_FAILED", `Element type ${el.type} has no aggregates`);
      }
      const src = el.config.source;
      const measures = el.type === "metric" ? [el.config.measure] : el.config.measures;
      const aggregates = measures.map((m) => ({ op: AGG_OP[m.agg], ...(m.fieldId ? { fieldId: m.fieldId } : {}) }));
      const { groups } = await executeGroupQuery(
        ctx.db,
        tableUuid(src.tableId),
        {
          filter: src.filter ?? undefined,
          viewId: src.baseViewId ?? undefined,
          groupBy: el.type === "chart" ? [{ fieldId: el.config.x.fieldId }] : [],
          aggregates,
        },
        { user },
      );
      const keyOf = (m: (typeof aggregates)[number]) => (m.fieldId ? `${m.op}:${m.fieldId}` : m.op);
      if (el.type === "metric") {
        const g = groups[0];
        const m = aggregates[0]!;
        void reply.send({ value: g ? (m.op === "count" ? g.count : g.aggregates[keyOf(m)] ?? null) : 0, count: g?.count ?? 0 });
        return;
      }
      let points = groups.map((g) => ({
        key: g.key,
        label: g.value,
        values: aggregates.map((m) => (m.op === "count" ? g.count : g.aggregates[keyOf(m)] ?? null)),
        count: g.count,
      }));
      const sort = el.config.x.sort;
      if (sort === "value_desc") points.sort((a, b) => Number(b.values[0] ?? 0) - Number(a.values[0] ?? 0));
      if (sort === "value_asc") points.sort((a, b) => Number(a.values[0] ?? 0) - Number(b.values[0] ?? 0));
      const truncated = points.length > el.config.x.limit;
      points = points.slice(0, el.config.x.limit);
      void reply.send({ points, truncated, measures: measures.map((m) => ({ agg: m.agg, fieldId: m.fieldId ?? null, label: m.label ?? null })) });
    }),
  );
}
