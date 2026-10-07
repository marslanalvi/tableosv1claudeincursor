import { generateUuidV7 } from "@tabula/types";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { nextOrderKey } from "../../lib/order-key.js";

export interface ContactDirectory {
  baseId: string;
  contactsTableId: string;
}

/** Ensures one contact_directory base with a Contacts table per workspace. */
export async function ensureContactDirectory(
  db: TabulaDb,
  params: {
    workspaceId: string;
    orgId: string;
    shardId: string;
    userId: string;
  },
): Promise<ContactDirectory> {
  const existing = await sql<{ base_id: string; table_id: string }>`
    SELECT b.id AS base_id, t.id AS table_id
    FROM data.bases b
    INNER JOIN data.tables t ON t.base_id = b.id AND t.name = 'Contacts' AND t.deleted_at IS NULL
    WHERE b.workspace_id = ${params.workspaceId}
      AND b.kind = 'contact_directory'
      AND b.deleted_at IS NULL
    LIMIT 1
  `.execute(db);

  const row = existing.rows[0];
  if (row) {
    await ensureContactFields(db, row.table_id, params.workspaceId, row.base_id, params.userId);
    return { baseId: row.base_id, contactsTableId: row.table_id };
  }

  const baseId = generateUuidV7();
  const tableId = generateUuidV7();
  const fieldId = generateUuidV7();
  const viewId = generateUuidV7();

  await db.transaction().execute(async (trx) => {
    await sql`
      INSERT INTO data.bases (id, workspace_id, kind, name, created_by)
      VALUES (${baseId}, ${params.workspaceId}, 'contact_directory', 'Contacts', ${params.userId})
    `.execute(trx);

    await sql`
      INSERT INTO data.base_runtime (base_id, workspace_id)
      VALUES (${baseId}, ${params.workspaceId})
    `.execute(trx);

    await sql`
      INSERT INTO core.base_directory (
        base_id, workspace_id, org_id, shard_id, name, order_key, kind
      ) VALUES (
        ${baseId}, ${params.workspaceId}, ${params.orgId}, ${params.shardId},
        'Contacts', ${nextOrderKey()}, 'contact_directory'
      )
    `.execute(trx);

    await sql`
      INSERT INTO data.tables (
        id, workspace_id, base_id, name, order_key, next_field_slot, created_by
      ) VALUES (
        ${tableId}, ${params.workspaceId}, ${baseId}, 'Contacts', ${nextOrderKey()}, 3, ${params.userId}
      )
    `.execute(trx);

    await sql`
      INSERT INTO data.fields (
        id, workspace_id, base_id, table_id, slot, name, type, order_key, created_by
      ) VALUES (
        ${fieldId}, ${params.workspaceId}, ${baseId}, ${tableId}, 1, 'Name', 'text', ${nextOrderKey()}, ${params.userId}
      )
    `.execute(trx);

    await sql`
      UPDATE data.tables SET primary_field_id = ${fieldId}, updated_at = now()
      WHERE id = ${tableId}
    `.execute(trx);

    await sql`
      INSERT INTO data.views (
        id, workspace_id, base_id, table_id, type, name, order_key, is_default, created_by, config
      ) VALUES (
        ${viewId}, ${params.workspaceId}, ${baseId}, ${tableId}, 'grid', 'Grid view',
        ${nextOrderKey()}, true, ${params.userId}, ${JSON.stringify({ visibleFieldSlots: [1] })}::jsonb
      )
    `.execute(trx);
  });

  await ensureContactFields(db, tableId, params.workspaceId, baseId, params.userId);
  return { baseId, contactsTableId: tableId };
}

/** Standard contact fields, by (case-insensitive) name. */
export const CONTACT_FIELDS = [
  { key: "name", name: "Name", type: "text" },
  { key: "email", name: "Email", type: "email" },
  { key: "phone", name: "Phone", type: "phone" },
  { key: "company", name: "Company", type: "text" },
  { key: "title", name: "Title", type: "text" },
  { key: "notes", name: "Notes", type: "long_text" },
] as const;

export type ContactKey = (typeof CONTACT_FIELDS)[number]["key"];

async function ensureContactFields(
  db: TabulaDb,
  tableId: string,
  workspaceId: string,
  baseId: string,
  userId: string,
): Promise<void> {
  const existing = await sql<{ name: string }>`
    SELECT name FROM data.fields WHERE table_id = ${tableId} AND deleted_at IS NULL
  `.execute(db);
  const have = new Set(existing.rows.map((r) => r.name.toLowerCase()));
  const missing = CONTACT_FIELDS.filter((f) => !have.has(f.name.toLowerCase()));
  if (missing.length === 0) return;
  await db.transaction().execute(async (trx) => {
    for (const f of missing) {
      const slotRes = await sql<{ slot: number }>`
        UPDATE data.tables
        SET next_field_slot = GREATEST(
              next_field_slot,
              (SELECT COALESCE(MAX(slot), 0) + 1 FROM data.fields WHERE table_id = ${tableId})
            ) + 1
        WHERE id = ${tableId}
        RETURNING next_field_slot - 1 AS slot
      `.execute(trx);
      const slot = slotRes.rows[0]?.slot;
      if (!slot) continue;
      await sql`
        INSERT INTO data.fields (
          id, workspace_id, base_id, table_id, slot, name, type, order_key, created_by
        ) VALUES (
          ${generateUuidV7()}, ${workspaceId}, ${baseId}, ${tableId}, ${slot}, ${f.name}, ${f.type},
          ${nextOrderKey()}, ${userId}
        )
      `.execute(trx);
    }
  });
}

/** slot per contact key for the directory table. */
export async function contactSlots(db: TabulaDb, tableId: string): Promise<Partial<Record<ContactKey, number>>> {
  const rows = await sql<{ name: string; slot: number }>`
    SELECT name, slot FROM data.fields WHERE table_id = ${tableId} AND deleted_at IS NULL
  `.execute(db);
  const out: Partial<Record<ContactKey, number>> = {};
  for (const f of CONTACT_FIELDS) {
    const hit = rows.rows.find((r) => r.name.toLowerCase() === f.name.toLowerCase());
    if (hit) out[f.key] = hit.slot;
  }
  return out;
}
