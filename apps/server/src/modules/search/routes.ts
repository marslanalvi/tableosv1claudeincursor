import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { notFound } from "../../http/errors.js";
import { handleWave4Error } from "../wave4/problems.js";
import { compileForUser } from "../access/compile.js";

const TEXT_TYPES = ["text", "long_text", "email", "url", "phone"];

export interface SearchResult {
  kind: "base" | "table" | "record";
  id: string;
  title: string;
  subtitle: string;
  baseId: string;
  tableId: string | null;
  recordId: string | null;
  href: string;
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 80);
  const start = Math.max(0, i - 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, i + q.length + 50)}`;
}

/**
 * Global search (Cmd/Ctrl+K). Queries live data directly (base/table names and
 * text cells), so results never depend on the async search index being current.
 */
export async function registerSearchRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Querystring: { q?: string; workspaceId?: string; baseId?: string; limit?: string } }>(
    "/v1/search",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const q = (request.query.q ?? "").trim().slice(0, 200);
        if (!q) {
          void reply.send({ results: [], hits: [] });
          return;
        }
        const limit = Math.min(Math.max(Number(request.query.limit ?? 20) || 20, 1), 50);
        const workspaceFilter = request.query.workspaceId
          ? parsePid(request.query.workspaceId, "wsp")
          : null;
        const baseFilter = request.query.baseId ? parsePid(request.query.baseId, "bas") : null;

        const candidates = await sql<{ base_id: string; name: string; kind: string | null }>`
          SELECT DISTINCT bd.base_id, bd.name, bd.kind
          FROM core.base_directory bd
          INNER JOIN core.organization_members m
            ON m.org_id = bd.org_id AND m.user_id = ${user.id} AND m.status = 'active'
          WHERE bd.status = 'active' AND bd.deleted_at IS NULL
            ${workspaceFilter ? sql`AND bd.workspace_id = ${workspaceFilter}` : sql``}
            ${baseFilter ? sql`AND bd.base_id = ${baseFilter}` : sql``}
        `.execute(ctx.db);
        const accessible = { rows: [] as typeof candidates.rows };
        for (const r of candidates.rows) {
          if ((await compileForUser(ctx.db, user.id, r.base_id)).effectiveBaseRole) accessible.rows.push(r);
        }
        const baseIds = accessible.rows.map((r) => r.base_id);
        const baseName = new Map(accessible.rows.map((r) => [r.base_id, r.name]));
        if (baseIds.length === 0) {
          void reply.send({ results: [], hits: [] });
          return;
        }
        const pattern = `%${escapeLike(q)}%`;
        const results: SearchResult[] = [];

        for (const b of accessible.rows) {
          if (b.name.toLowerCase().includes(q.toLowerCase())) {
            results.push({
              kind: "base",
              id: pid("bas", b.base_id),
              title: b.name,
              subtitle: b.kind === "contact_directory" ? "Contacts" : "Base",
              baseId: pid("bas", b.base_id),
              tableId: null,
              recordId: null,
              href: `/bases/${pid("bas", b.base_id)}`,
            });
          }
        }

        const tables = await sql<{ id: string; base_id: string; name: string }>`
          SELECT id, base_id, name FROM data.tables
          WHERE base_id = ANY(${baseIds}::uuid[]) AND deleted_at IS NULL
            AND name ILIKE ${pattern}
          ORDER BY name LIMIT ${limit}
        `.execute(ctx.db);
        for (const t of tables.rows) {
          results.push({
            kind: "table",
            id: pid("tbl", t.id),
            title: t.name,
            subtitle: baseName.get(t.base_id) ?? "",
            baseId: pid("bas", t.base_id),
            tableId: pid("tbl", t.id),
            recordId: null,
            href: `/bases/${pid("bas", t.base_id)}?table=${pid("tbl", t.id)}`,
          });
        }

        const records = await sql<{
          id: string;
          table_id: string;
          base_id: string;
          table_name: string;
          primary_text: string | null;
          match_text: string | null;
          row_number: string;
        }>`
          SELECT r.id, r.table_id, r.base_id, t.name AS table_name, r.row_number::text AS row_number,
                 COALESCE(r.cells ->> pf.slot::text, r.computed ->> pf.slot::text) AS primary_text,
                 (
                   SELECT r.cells ->> f.slot::text FROM data.fields f
                   WHERE f.table_id = r.table_id AND f.deleted_at IS NULL
                     AND f.type = ANY(${TEXT_TYPES}::text[])
                     AND r.cells ->> f.slot::text ILIKE ${pattern}
                   LIMIT 1
                 ) AS match_text
          FROM data.records r
          JOIN data.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
          LEFT JOIN data.fields pf ON pf.id = t.primary_field_id
          WHERE r.base_id = ANY(${baseIds}::uuid[]) AND r.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM data.fields f
              WHERE f.table_id = r.table_id AND f.deleted_at IS NULL
                AND f.type = ANY(${TEXT_TYPES}::text[])
                AND r.cells ->> f.slot::text ILIKE ${pattern}
            )
          ORDER BY (COALESCE(r.cells ->> pf.slot::text, '') ILIKE ${pattern}) DESC, r.updated_at DESC
          LIMIT ${limit}
        `.execute(ctx.db);
        for (const r of records.rows) {
          const title = r.primary_text?.trim() || `Record ${r.row_number}`;
          const match = r.match_text ?? "";
          results.push({
            kind: "record",
            id: pid("rec", r.id),
            title,
            subtitle:
              match && match !== r.primary_text
                ? `${r.table_name} · ${snippet(match, q)}`
                : `${r.table_name} · ${baseName.get(r.base_id) ?? ""}`,
            baseId: pid("bas", r.base_id),
            tableId: pid("tbl", r.table_id),
            recordId: pid("rec", r.id),
            href: `/bases/${pid("bas", r.base_id)}?table=${pid("tbl", r.table_id)}&record=${pid("rec", r.id)}`,
          });
        }

        void reply.send({
          results: results.slice(0, limit * 2),
          // Legacy shape kept for older clients.
          hits: results.map((r) => ({
            documentId: r.id,
            baseId: r.baseId,
            docType: r.kind,
            refId: r.id,
            title: r.title,
            rank: 1,
          })),
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );
}
