import type { TabulaDb } from "@tabula/db";
import type { SearchBackend } from "@tabula/search";
import { sql } from "kysely";
import { loadRecordNames } from "../records/serialize.js";

const CHUNK = 500;

function cellsToSearchText(cells: unknown): string {
  if (!cells || typeof cells !== "object") return "";
  const parts: string[] = [];
  for (const value of Object.values(cells as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") parts.push(value);
    else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
    } else if (typeof value === "object") {
      parts.push(JSON.stringify(value));
    }
  }
  return parts.join(" ");
}

/**
 * (Re)index records of one table. The title is the primary field's display text
 * (as shown in the grid), falling back to "Record N". Missing or deleted records
 * are removed from the index.
 */
export async function indexRecordDocuments(
  db: TabulaDb,
  search: SearchBackend,
  params: { workspaceId: string; baseId: string; tableId: string; recordIds: readonly string[] },
): Promise<number> {
  const ids = [...new Set(params.recordIds)];
  let indexed = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await sql<{ id: string; cells: unknown; row_number: string }>`
      SELECT id, cells, row_number::text
      FROM data.records
      WHERE id = ANY(${chunk}::uuid[])
        AND table_id = ${params.tableId}
        AND deleted_at IS NULL
    `.execute(db);
    const names = await loadRecordNames(db, params.tableId, rows.rows.map((r) => r.id));
    const live = new Set<string>();
    for (const rec of rows.rows) {
      live.add(rec.id);
      const title = names.get(rec.id)?.trim() || `Record ${rec.row_number}`;
      await search.upsert({
        workspaceId: params.workspaceId,
        baseId: params.baseId,
        docType: "record",
        refId: rec.id,
        title,
        body: `${title} ${cellsToSearchText(rec.cells)}`,
      });
      indexed++;
    }
    for (const id of chunk) {
      if (!live.has(id)) await search.remove(params.baseId, "record", id);
    }
  }
  return indexed;
}

export async function indexRecordDocument(
  db: TabulaDb,
  search: SearchBackend,
  params: { workspaceId: string; baseId: string; tableId: string; recordId: string },
): Promise<void> {
  await indexRecordDocuments(db, search, { ...params, recordIds: [params.recordId] });
}

/** Reindex every live record of a table and drop index rows for records that are gone. */
export async function reindexTableRecords(
  db: TabulaDb,
  search: SearchBackend,
  params: { workspaceId: string; baseId: string; tableId: string },
): Promise<number> {
  let indexed = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await sql<{ id: string }>`
      SELECT id FROM data.records
      WHERE table_id = ${params.tableId} AND deleted_at IS NULL AND id > ${after}::uuid
      ORDER BY id LIMIT ${CHUNK}
    `.execute(db);
    if (page.rows.length === 0) break;
    indexed += await indexRecordDocuments(db, search, { ...params, recordIds: page.rows.map((r) => r.id) });
    after = page.rows[page.rows.length - 1]!.id;
  }
  await sql`
    DELETE FROM data.search_documents sd
    WHERE sd.base_id = ${params.baseId} AND sd.doc_type = 'record'
      AND EXISTS (SELECT 1 FROM data.records r WHERE r.id = sd.ref_id AND r.table_id = ${params.tableId})
      AND NOT EXISTS (
        SELECT 1 FROM data.records r
        WHERE r.id = sd.ref_id AND r.table_id = ${params.tableId} AND r.deleted_at IS NULL
      )
  `.execute(db);
  return indexed;
}

/** One-off backfill: reindex every table of a base. */
export async function reindexBaseRecords(
  db: TabulaDb,
  search: SearchBackend,
  baseId: string,
): Promise<{ tables: number; records: number }> {
  const tables = await sql<{ id: string; workspace_id: string }>`
    SELECT t.id, b.workspace_id
    FROM data.tables t JOIN data.bases b ON b.id = t.base_id
    WHERE t.base_id = ${baseId} AND t.deleted_at IS NULL
  `.execute(db);
  let records = 0;
  for (const t of tables.rows) {
    records += await reindexTableRecords(db, search, { workspaceId: t.workspace_id, baseId, tableId: t.id });
  }
  return { tables: tables.rows.length, records };
}
