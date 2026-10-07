import type { TabulaDb } from "@tabula/db";
import type { DomainEvent } from "@tabula/events";
import { CommentEvents, FieldEvents, HistoryEvents, TableEvents } from "@tabula/events";
import type { SearchBackend } from "@tabula/search";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import { indexRecordDocuments, reindexTableRecords } from "./record-index.js";

export async function handleCommentCreatedNotification(
  db: TabulaDb,
  event: DomainEvent,
): Promise<void> {
  if (event.type !== CommentEvents.CREATED) return;
  const baseId = event.tenant.baseId;
  if (!baseId) return;

  const data = event.data as {
    commentId?: string;
    recordId?: string;
    tableId?: string;
    notificationsCreated?: boolean;
  };
  // The API now creates comment notifications inline (with actor + link).
  if (data.notificationsCreated) return;
  const commentId = data.commentId;
  const recordId = data.recordId;
  const tableId = data.tableId;
  const authorId = event.actor.id;
  if (!commentId || !recordId || !tableId) return;

  const subs = await sql<{ user_id: string }>`
    SELECT user_id FROM data.record_subscriptions
    WHERE workspace_id = ${event.tenant.workspaceId}
      AND base_id = ${baseId}
      AND table_id = ${tableId}
      AND record_id = ${recordId}
  `.execute(db);

  const mentions = await sql<{ principal_id: string }>`
    SELECT principal_id FROM data.mentions
    WHERE comment_id = ${commentId} AND principal_type = 'user'
  `.execute(db);

  const recipientIds = new Set<string>();
  for (const s of subs.rows) {
    if (s.user_id !== authorId) recipientIds.add(s.user_id);
  }
  for (const m of mentions.rows) {
    if (m.principal_id !== authorId) recipientIds.add(m.principal_id);
  }

  for (const userId of recipientIds) {
    await sql`
      INSERT INTO core.notifications (
        id, user_id, workspace_id, base_id, category, title, body
      ) VALUES (
        ${generateUuidV7()},
        ${userId},
        ${event.tenant.workspaceId},
        ${baseId},
        'comment',
        'New comment on a record you follow',
        ${JSON.stringify({ commentId, recordId, tableId })}::jsonb
      )
    `.execute(db);
  }
}

export async function handleSearchIndexEvent(
  db: TabulaDb,
  search: SearchBackend,
  event: DomainEvent,
): Promise<void> {
  const baseId = event.tenant.baseId;
  if (!baseId) return;
  const workspaceId = event.tenant.workspaceId;

  const data = event.data as {
    aggregateType?: string;
    aggregateId?: string;
    tableId?: string;
    tableIds?: unknown;
    recordId?: unknown;
    recordIds?: unknown;
    fieldId?: string;
    primaryFieldId?: string;
  };
  const tableId = typeof data.tableId === "string" ? data.tableId : undefined;
  const tableIds = [
    ...new Set([...(tableId ? [tableId] : []), ...strings(data.tableIds)]),
  ];
  const reindexTables = async (ids: readonly string[]) => {
    for (const t of ids) await reindexTableRecords(db, search, { workspaceId, baseId, tableId: t });
  };

  if (event.type.startsWith("record.") || event.type.startsWith("records.")) {
    const recordIds = [
      ...strings(data.recordIds),
      ...(typeof data.recordId === "string" ? [data.recordId] : []),
      ...(data.aggregateType === "record" && data.aggregateId ? [data.aggregateId] : []),
    ];
    if (tableId && recordIds.length > 0) {
      await indexRecordDocuments(db, search, { workspaceId, baseId, tableId, recordIds });
    } else {
      await reindexTables(tableIds);
    }
    // Computed primaries elsewhere (lookups/formulas over links) may show new text.
    const others = tableIds.filter((t) => t !== tableId);
    if (others.length > 0) await reindexTables(await smallComputedPrimaryTables(db, others));
    return;
  }

  if (event.type === TableEvents.UPDATED && data.primaryFieldId && tableId) {
    await reindexTables([tableId]);
    return;
  }

  if ((event.type === FieldEvents.UPDATED || event.type === FieldEvents.TYPE_CHANGED) && tableId) {
    const fieldId = data.fieldId ?? (data.aggregateType === "field" ? data.aggregateId : undefined);
    const prim = await sql<{ primary_field_id: string | null; is_computed: boolean | null }>`
      SELECT t.primary_field_id, f.is_computed
      FROM data.tables t LEFT JOIN data.fields f ON f.id = t.primary_field_id
      WHERE t.id = ${tableId}
    `.execute(db);
    const p = prim.rows[0];
    if (p && (p.primary_field_id === fieldId || p.is_computed)) await reindexTables(tableIds);
    return;
  }

  if (
    event.type === HistoryEvents.CHANGE_UNDONE ||
    event.type === HistoryEvents.CHANGE_REDONE ||
    event.type === "trash.restored"
  ) {
    await reindexTables(tableIds);
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

async function smallComputedPrimaryTables(db: TabulaDb, tableIds: readonly string[]): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT t.id
    FROM data.tables t JOIN data.fields f ON f.id = t.primary_field_id
    WHERE t.id = ANY(${tableIds}::uuid[]) AND t.deleted_at IS NULL AND f.is_computed
      AND (SELECT count(*) FROM data.records r WHERE r.table_id = t.id AND r.deleted_at IS NULL) <= 5000
  `.execute(db);
  return rows.rows.map((r) => r.id);
}

export async function handleFileScanJob(
  db: TabulaDb,
  payload: { attachmentId: string },
): Promise<void> {
  await sql`
    UPDATE data.attachments
    SET scan_status = 'clean'
    WHERE id = ${payload.attachmentId}
      AND scan_status IN ('pending', 'scanning')
  `.execute(db);
}
