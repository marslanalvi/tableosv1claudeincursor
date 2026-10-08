import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { ApiError } from "../../http/errors.js";
import { idFromAny } from "../schema/field-dto.js";

const READ_ONLY = "This table is synced from another base, so its synced data is read-only here. Change it in the source base.";

function fieldKeys(body: unknown): string[] {
  const b = (body ?? {}) as { fields?: Record<string, unknown>; records?: Array<{ fields?: Record<string, unknown> }> };
  const keys = Object.keys(b.fields ?? {});
  for (const r of b.records ?? []) keys.push(...Object.keys(r.fields ?? {}));
  return keys;
}

/**
 * People may add their own fields to a synced table and edit those, but records
 * can't be added/removed and synced fields can't be changed by hand.
 */
export async function assertSyncWritable(
  db: TabulaDb,
  tableId: string,
  action: "record.create" | "record.update" | "record.delete",
  body: unknown,
): Promise<void> {
  const r = await sql<{ field_map: Record<string, string> }>`SELECT field_map FROM data.table_syncs WHERE table_id = ${tableId}`.execute(db);
  const sync = r.rows[0];
  if (!sync) return;
  if (action !== "record.update") throw new ApiError(403, "FORBIDDEN", READ_ONLY);
  const synced = new Set(Object.values(sync.field_map ?? {}));
  const keys = fieldKeys(body);
  if (keys.length === 0) return;
  const names = await sql<{ id: string; name: string }>`
    SELECT id, name FROM data.fields WHERE table_id = ${tableId} AND deleted_at IS NULL
  `.execute(db);
  const byName = new Map(names.rows.map((f) => [f.name.trim().toLowerCase(), f.id]));
  for (const k of keys) {
    const id = idFromAny(k, "fld") ?? byName.get(k.trim().toLowerCase()) ?? null;
    if (id && synced.has(id)) throw new ApiError(403, "FORBIDDEN", READ_ONLY);
  }
}
