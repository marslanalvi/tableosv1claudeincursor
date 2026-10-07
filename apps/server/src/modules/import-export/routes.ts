import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { ApiError, notFound, validationProblem } from "../../http/errors.js";
import { resolveBaseContext, resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { LimitsService } from "../billing/limits-service.js";
import { executeRecordQuery } from "../query/execute-record-query.js";
import { loadView } from "../share/service.js";
import { handleWave4Error } from "../wave4/problems.js";
import { createRecords, type WriteScope } from "../wave4/record-writer.js";
import { exportValue, toCsv, type ExportField } from "./format.js";
import { buildXlsx } from "./xlsx.js";

const MAX_ROWS_PER_REQUEST = 2000;
const BATCH = 500;
const MAX_EXPORT_ROWS = 100_000;

const importBody = z.object({
  tableId: z.string(),
  filename: z.string().max(255).optional(),
  /** Rows keyed by `fld_` id (or field name). */
  rows: z.array(z.record(z.unknown())).min(1).max(MAX_ROWS_PER_REQUEST),
  typecast: z.boolean().optional().default(true),
  /** Continue an existing import job (chunked uploads from the wizard). */
  importJobId: z.string().optional(),
  /** Index of rows[0] in the source file (for error row numbers). */
  rowOffset: z.number().int().nonnegative().optional().default(0),
  /** Total rows in the source file (first chunk only). */
  totalRows: z.number().int().positive().optional(),
  final: z.boolean().optional().default(true),
});

interface RowError {
  row: number;
  message: string;
}

export async function registerImportExportRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limits = new LimitsService(ctx.db);

  /**
   * Create records through B's write path (`records/write.ts`: validation,
   * typecast, links, compute; one base change per batch). A failing batch is
   * bisected so only the bad rows are reported.
   */
  async function writeBatch(
    scope: WriteScope,
    rows: Record<string, unknown>[],
    typecast: boolean,
    rowOffset: number,
  ): Promise<{ created: number; errors: RowError[] }> {
    try {
      const ids = await createRecords(ctx, scope, rows.map((fields) => ({ fields })), typecast);
      return { created: ids.length, errors: [] };
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status !== 422) throw err;
      if (rows.length === 1) {
        return { created: 0, errors: [{ row: rowOffset + 1, message: (err as Error).message }] };
      }
      const mid = Math.ceil(rows.length / 2);
      const left = await writeBatch(scope, rows.slice(0, mid), typecast, rowOffset);
      const right = await writeBatch(scope, rows.slice(mid), typecast, rowOffset + mid);
      return { created: left.created + right.created, errors: [...left.errors, ...right.errors] };
    }
  }

  async function handleImport(request: FastifyRequest<{ Params: { baseId: string } }>, reply: FastifyReply) {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return;
    }
    const baseId = parsePid(request.params.baseId, "bas");
    const base = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!base.ok) {
      notFound(request, reply, "Base not found");
      return;
    }
    const snapshot = await compileForUser(ctx.db, user.id, baseId);
    assertCan(snapshot, "record.create");

    const body = importBody.parse(request.body);
    const tableId = parsePid(body.tableId, "tbl");
    const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
    if (!table.ok) {
      notFound(request, reply, "Table not found");
      return;
    }
    await limits.assertCanCreateRecord(base.orgId, baseId, body.rows.length);

    // Job bookkeeping (one job across chunked requests).
    let importJobId: string;
    if (body.importJobId) {
      importJobId = parsePid(body.importJobId, "imp");
      const job = await sql<{ id: string }>`
        SELECT id FROM data.import_jobs
        WHERE id = ${importJobId} AND base_id = ${baseId} AND created_by = ${user.id}
      `.execute(ctx.db);
      if (!job.rows[0]) {
        notFound(request, reply, "Import job not found");
        return;
      }
    } else {
      importJobId = generateUuidV7();
      await sql`
        INSERT INTO data.import_jobs (
          id, workspace_id, base_id, table_id, status, source_filename, rows_total, created_by
        ) VALUES (
          ${importJobId}, ${base.workspaceId}, ${baseId}, ${tableId}, 'running',
          ${body.filename ?? "import.csv"}, ${body.totalRows ?? body.rows.length}, ${user.id}
        )
      `.execute(ctx.db);
    }

    let imported = 0;
    const errors: RowError[] = [];
    const scope: WriteScope = {
      orgId: base.orgId,
      workspaceId: base.workspaceId,
      baseId,
      tableId,
      actor: { actorType: "user", actorId: user.id, sessionId: user.sessionId, via: "api" },
      userId: user.id,
      via: "import",
    };
    for (let i = 0; i < body.rows.length; i += BATCH) {
      const chunk = body.rows.slice(i, i + BATCH);
      const r = await writeBatch(scope, chunk, body.typecast, body.rowOffset + i);
      imported += r.created;
      errors.push(...r.errors);
    }

    for (const e of errors.slice(0, 500)) {
      await sql`
        INSERT INTO data.import_errors (id, import_job_id, workspace_id, source_row, message)
        VALUES (${generateUuidV7()}, ${importJobId}, ${base.workspaceId}, ${e.row}, ${e.message.slice(0, 1000)})
      `.execute(ctx.db);
    }
    const totals = await sql<{ rows_imported: string; rows_failed: string }>`
      UPDATE data.import_jobs
      SET rows_imported = rows_imported + ${imported},
          rows_failed = rows_failed + ${errors.length},
          status = CASE WHEN ${body.final} THEN
                     (CASE WHEN rows_imported + ${imported} = 0 AND rows_failed + ${errors.length} > 0
                           THEN 'failed' ELSE 'succeeded' END)
                   ELSE 'running' END,
          finished_at = CASE WHEN ${body.final} THEN now() ELSE finished_at END
      WHERE id = ${importJobId}
      RETURNING rows_imported::text, rows_failed::text
    `.execute(ctx.db);

    void reply.code(200).send({
      importJobId: pid("imp", importJobId),
      rowsImported: imported,
      rowsFailed: errors.length,
      errors,
      totalImported: Number(totals.rows[0]?.rows_imported ?? imported),
      totalFailed: Number(totals.rows[0]?.rows_failed ?? errors.length),
      status: body.final ? (imported === 0 && errors.length > 0 ? "failed" : "succeeded") : "running",
    });
  }

  app.post<{ Params: { baseId: string } }>("/v1/bases/:baseId/import", async (request, reply) => {
    try {
      await handleImport(request, reply);
    } catch (err) {
      handleWave4Error(request, reply, err);
    }
  });
  // Legacy path (same body).
  app.post<{ Params: { baseId: string } }>("/v1/bases/:baseId/import/csv", async (request, reply) => {
    try {
      await handleImport(request, reply);
    } catch (err) {
      handleWave4Error(request, reply, err);
    }
  });

  // ─────────────────────────── Export ───────────────────────────

  async function buildExport(
    tableId: string,
    viewId: string | null,
  ): Promise<{ header: string[]; rows: (string | number | boolean | null)[][]; fields: ExportField[]; name: string; xlsxRows: (string | number | boolean | null)[][] }> {
    const t = await sql<{ name: string; primary_field_id: string | null }>`
      SELECT name, primary_field_id FROM data.tables WHERE id = ${tableId}
    `.execute(ctx.db);
    const tableName = t.rows[0]?.name ?? "Export";
    const primary = t.rows[0]?.primary_field_id ?? null;
    const fieldRows = await sql<{ id: string; name: string; type: string; config: Record<string, unknown> }>`
      SELECT id, name, type, config FROM data.fields
      WHERE table_id = ${tableId} AND deleted_at IS NULL AND type <> 'button'
      ORDER BY order_key COLLATE "C" ASC, slot ASC
    `.execute(ctx.db);
    const view = viewId ? await loadView(ctx.db, viewId) : null;
    let fields: ExportField[] = fieldRows.rows.map((f) => ({
      id: pid("fld", f.id),
      name: f.name,
      type: f.type,
      config: f.config ?? {},
    }));
    if (view) {
      const hidden = new Set(view.config.hiddenFieldIds);
      const order = new Map(view.config.fieldOrder.map((id, i) => [id, i]));
      const primaryPid = primary ? pid("fld", primary) : null;
      fields = fields
        .filter((f) => f.id === primaryPid || !hidden.has(f.id))
        .map((f, i) => ({ f, i }))
        .sort((a, b) => {
          if (a.f.id === primaryPid) return -1;
          if (b.f.id === primaryPid) return 1;
          const pa = order.get(a.f.id);
          const pb = order.get(b.f.id);
          if (pa !== undefined && pb !== undefined) return pa - pb;
          if (pa !== undefined) return -1;
          if (pb !== undefined) return 1;
          return a.i - b.i;
        })
        .map((x) => x.f);
    }

    const absoluteUrl = (u: string) => (u.startsWith("/") ? `${ctx.env.API_URL.replace(/\/$/, "")}${u}` : u);
    const rows: (string | number | boolean | null)[][] = [];
    const xlsxRows: (string | number | boolean | null)[][] = [];
    let cursor: string | null = null;
    do {
      const page = await executeRecordQuery(ctx.db, tableId, {
        pageSize: 500,
        ...(view?.config.filter ? { filter: view.config.filter } : {}),
        ...(view?.config.sorts.length
          ? { sort: view.config.sorts.map((s) => ({ fieldId: s.fieldId, direction: s.direction })) }
          : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const rec of page.records as unknown as { fields: Record<string, unknown> }[]) {
        rows.push(fields.map((f) => exportValue(f, rec.fields[f.id], { absoluteUrl })));
        xlsxRows.push(fields.map((f) => exportValue(f, rec.fields[f.id], { absoluteUrl, keepNumbers: true })));
      }
      cursor = page.nextCursor;
    } while (cursor && rows.length < MAX_EXPORT_ROWS);

    return {
      header: fields.map((f) => f.name),
      rows,
      xlsxRows,
      fields,
      name: view ? `${tableName}-${view.name}` : tableName,
    };
  }

  function fileName(name: string, ext: string): string {
    const safe = name.replace(/[^\w\- ]+/g, "_").trim() || "export";
    return `${safe}.${ext}`;
  }

  app.get<{
    Params: { baseId: string; tableId: string };
    Querystring: { format?: string; viewId?: string };
  }>("/v1/bases/:baseId/tables/:tableId/export", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }
      const baseId = parsePid(request.params.baseId, "bas");
      const tableId = parsePid(request.params.tableId, "tbl");
      const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
      if (!table.ok) {
        notFound(request, reply, "Table not found");
        return;
      }
      const snapshot = await compileForUser(ctx.db, user.id, baseId);
      assertCan(snapshot, "export.data");
      const format = (request.query.format ?? "csv").toLowerCase();
      if (format !== "csv" && format !== "xlsx") {
        validationProblem(request, reply, "format must be csv or xlsx");
        return;
      }
      let viewId: string | null = null;
      if (request.query.viewId) {
        viewId = parsePid(request.query.viewId, "viw");
        const v = await loadView(ctx.db, viewId);
        if (!v || v.tableId !== tableId) {
          notFound(request, reply, "View not found");
          return;
        }
      }
      const data = await buildExport(tableId, viewId);
      await sql`
        INSERT INTO data.export_jobs (
          id, workspace_id, base_id, table_id, status, row_count, requested_by, finished_at
        ) VALUES (
          ${generateUuidV7()}, ${table.workspaceId}, ${baseId}, ${tableId},
          'succeeded', ${data.rows.length}, ${user.id}, now()
        )
      `.execute(ctx.db).catch(() => undefined);

      if (format === "xlsx") {
        const buf = buildXlsx(data.name, [data.header, ...data.xlsxRows]);
        void reply
          .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .header("Content-Disposition", `attachment; filename="${fileName(data.name, "xlsx")}"`)
          .header("X-Row-Count", String(data.rows.length))
          .send(buf);
        return;
      }
      const csv = toCsv([data.header, ...data.rows]);
      void reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${fileName(data.name, "csv")}"`)
        .header("X-Row-Count", String(data.rows.length))
        .send(csv);
    } catch (err) {
      handleWave4Error(request, reply, err);
    }
  });

  // Legacy JSON export (kept for API compatibility).
  app.post<{ Params: { baseId: string } }>("/v1/bases/:baseId/export/csv", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }
      const baseId = parsePid(request.params.baseId, "bas");
      const body = z.object({ tableId: z.string(), viewId: z.string().optional() }).parse(request.body);
      const tableId = parsePid(body.tableId, "tbl");
      const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
      if (!table.ok) {
        notFound(request, reply, "Table not found");
        return;
      }
      const snapshot = await compileForUser(ctx.db, user.id, baseId);
      assertCan(snapshot, "export.data");
      const data = await buildExport(tableId, body.viewId ? parsePid(body.viewId, "viw") : null);
      void reply.send({
        format: "csv",
        rowCount: data.rows.length,
        csv: toCsv([data.header, ...data.rows]),
      });
    } catch (err) {
      handleWave4Error(request, reply, err);
    }
  });
}
