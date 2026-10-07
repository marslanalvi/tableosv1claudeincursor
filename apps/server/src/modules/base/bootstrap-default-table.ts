import { encodePublicId, generateUuidV7, keyBetween, keysBetween } from "@tabula/types";
import type { Database } from "@tabula/db";
import { sql, type Transaction } from "kysely";

type DbTrx = Transaction<Database>;

export interface BootstrappedTable {
  tableId: string;
  /** Primary field ("Name"). */
  fieldId: string;
  fieldIds: string[];
  viewId: string;
  recordIds: string[];
}

const opt = (label: string, color: string) => ({
  id: encodePublicId({ prefix: "opt", uuid: generateUuidV7() }),
  label,
  color,
});

/**
 * Creates an Airtable-style starter table: Name (primary), Notes, Assignee,
 * Status (Todo / In progress / Done), Attachments, a default grid view and
 * three empty records. Keeps `tables.record_count` / `base_runtime.record_count`
 * in sync.
 */
export async function bootstrapDefaultTable(
  trx: DbTrx,
  params: {
    workspaceId: string;
    baseId: string;
    userId: string;
    tableName?: string;
    /** Number of empty starter records (default 3). */
    emptyRecords?: number;
    /** Order key for the table (defaults to after the last table). */
    orderKey?: string;
  },
): Promise<BootstrappedTable> {
  const tableId = generateUuidV7();
  const viewId = generateUuidV7();
  const tableName = params.tableName?.trim() || "Table 1";

  let orderKey = params.orderKey;
  if (!orderKey) {
    const last = await sql<{ order_key: string }>`
      SELECT order_key FROM data.tables WHERE base_id = ${params.baseId} AND deleted_at IS NULL
      ORDER BY order_key DESC LIMIT 1
    `.execute(trx);
    try {
      orderKey = keyBetween(last.rows[0]?.order_key ?? null, null);
    } catch {
      orderKey = keyBetween(null, null);
    }
  }

  const fields: Array<{ name: string; type: string; config: Record<string, unknown> }> = [
    { name: "Name", type: "text", config: {} },
    { name: "Notes", type: "long_text", config: { richText: false } },
    { name: "Assignee", type: "collaborator", config: { allowMultiple: false, notify: true } },
    {
      name: "Status",
      type: "single_select",
      config: { options: [opt("Todo", "red"), opt("In progress", "yellow"), opt("Done", "green")] },
    },
    { name: "Attachments", type: "attachment", config: {} },
  ];
  const fieldIds = fields.map(() => generateUuidV7());
  const fieldKeys = keysBetween(null, null, fields.length);

  await sql`
    INSERT INTO data.tables (
      id, workspace_id, base_id, name, order_key, next_field_slot, created_by
    ) VALUES (
      ${tableId}, ${params.workspaceId}, ${params.baseId}, ${tableName}, ${orderKey},
      ${fields.length + 1}, ${params.userId}
    )
  `.execute(trx);

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    await sql`
      INSERT INTO data.fields (
        id, workspace_id, base_id, table_id, slot, name, type, config, order_key, created_by
      ) VALUES (
        ${fieldIds[i]!}, ${params.workspaceId}, ${params.baseId}, ${tableId}, ${i + 1}, ${f.name},
        ${f.type}, ${JSON.stringify(f.config)}::jsonb, ${fieldKeys[i]!}, ${params.userId}
      )
    `.execute(trx);
  }

  await sql`
    UPDATE data.tables
    SET primary_field_id = ${fieldIds[0]!}, updated_at = now()
    WHERE id = ${tableId}
  `.execute(trx);

  const lastView = await sql<{ order_key: string }>`
    SELECT order_key FROM data.views WHERE base_id = ${params.baseId} ORDER BY order_key DESC LIMIT 1
  `.execute(trx);
  let viewKey: string;
  try {
    viewKey = keyBetween(lastView.rows[0]?.order_key ?? null, null);
  } catch {
    viewKey = keyBetween(null, null);
  }
  await sql`
    INSERT INTO data.views (
      id, workspace_id, base_id, table_id, type, name, order_key, is_default, created_by, config
    ) VALUES (
      ${viewId}, ${params.workspaceId}, ${params.baseId}, ${tableId}, 'grid', 'Grid view',
      ${viewKey}, true, ${params.userId}, '{}'::jsonb
    )
  `.execute(trx);

  const n = Math.max(0, params.emptyRecords ?? 3);
  const recordIds: string[] = [];
  if (n > 0) {
    const keys = keysBetween(null, null, n);
    for (let i = 0; i < n; i++) {
      const id = generateUuidV7();
      recordIds.push(id);
      await sql`
        INSERT INTO data.records (
          table_id, id, workspace_id, base_id, row_number, manual_order, cells,
          created_by, updated_by, created_via, last_change_seq
        ) VALUES (
          ${tableId}, ${id}, ${params.workspaceId}, ${params.baseId}, ${i + 1}, ${keys[i]!}, '{}'::jsonb,
          ${params.userId}, ${params.userId}, 'system', 0
        )
      `.execute(trx);
    }
    await sql`
      UPDATE data.tables SET next_row_number = ${n + 1}, record_count = ${n} WHERE id = ${tableId}
    `.execute(trx);
    await sql`
      UPDATE data.base_runtime SET record_count = record_count + ${n}, updated_at = now()
      WHERE base_id = ${params.baseId}
    `.execute(trx);
  }

  return { tableId, fieldId: fieldIds[0]!, fieldIds, viewId, recordIds };
}
