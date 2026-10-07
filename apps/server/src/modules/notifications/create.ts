import { generateUuidV7 } from "@tabula/types";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { pid } from "../../lib/public-ids.js";

export interface NewNotification {
  userId: string;
  workspaceId: string | null;
  baseId: string | null;
  category: "mention" | "comment" | "reply" | "system" | "automation" | "share";
  title: string;
  /** Plain-text preview shown in the bell. */
  text: string;
  link: string | null;
  actorUserId: string | null;
  data?: Record<string, unknown>;
}

export async function createNotifications(db: TabulaDb, items: NewNotification[]): Promise<void> {
  for (const n of items) {
    await sql`
      INSERT INTO core.notifications (
        id, user_id, workspace_id, base_id, category, title, body, actor_user_id, link
      ) VALUES (
        ${generateUuidV7()}, ${n.userId}, ${n.workspaceId}, ${n.baseId}, ${n.category},
        ${n.title.slice(0, 300)},
        ${JSON.stringify({ text: n.text.slice(0, 1000), ...(n.data ?? {}) })}::jsonb,
        ${n.actorUserId}, ${n.link}
      )
    `.execute(db);
  }
}

/** In-app link to a record (web route `/bases/$baseId` honours these search params). */
export function recordLink(baseId: string, tableId: string, recordId: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({
    tableId: pid("tbl", tableId),
    recordId: pid("rec", recordId),
    ...(extra ?? {}),
  });
  return `/bases/${pid("bas", baseId)}?${params.toString()}`;
}

/** Primary-field text of a record (best effort; falls back to "Record N"). */
export async function recordTitle(db: TabulaDb, tableId: string, recordId: string): Promise<string> {
  const r = await sql<{ cells: Record<string, unknown>; computed: Record<string, unknown>; row_number: string; slot: number | null }>`
    SELECT r.cells, r.computed, r.row_number::text AS row_number, f.slot
    FROM data.records r
    JOIN data.tables t ON t.id = r.table_id
    LEFT JOIN data.fields f ON f.id = t.primary_field_id
    WHERE r.table_id = ${tableId} AND r.id = ${recordId}
    LIMIT 1
  `.execute(db);
  const row = r.rows[0];
  if (!row) return "a record";
  const key = row.slot != null ? String(row.slot) : null;
  let v: unknown = key ? (row.cells?.[key] ?? row.computed?.[key]) : undefined;
  if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object)) {
    v = (v as { value: unknown }).value;
  }
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  if (typeof v === "number") return String(v);
  return `Record ${row.row_number}`;
}
