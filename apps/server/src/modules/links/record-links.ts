/**
 * Record links — `data.record_links` is the single source of truth
 * (CONTRACTS §10). Link field values are never stored in `records.cells`.
 *
 * Ordering: `a_order` orders the b-records inside an a-record's list;
 * `b_order` orders the a-records inside a b-record's list.
 */
import type { Database } from "@tabula/db";
import { mergeLinkOps, type LinkSetOp } from "@tabula/links";
import { keyBetween, keysBetween } from "@tabula/types";
import { sql, type Kysely, type Transaction } from "kysely";
import { ApiError } from "../../http/errors.js";
import { parsePid } from "../../lib/public-ids.js";

type DbTrx = Transaction<Database> | Kysely<Database>;

export interface LinkRelationContext {
  relationId: string;
  side: "a" | "b";
  allowMultiple: boolean;
  peerTableId: string;
  ownTableId: string;
  /** The field on the other side (inverse), null for one-way links. */
  peerFieldId: string | null;
}

export async function getLinkRelationForField(
  trx: DbTrx,
  fieldId: string,
): Promise<(LinkRelationContext & { aFieldId: string; bFieldId: string | null }) | null> {
  const row = await sql<{
    id: string;
    a_field_id: string;
    b_field_id: string | null;
    a_table_id: string;
    b_table_id: string;
    allow_multiple_a: boolean;
    allow_multiple_b: boolean;
  }>`
    SELECT id, a_field_id, b_field_id, a_table_id, b_table_id,
           allow_multiple_a, allow_multiple_b
    FROM data.link_relations
    WHERE a_field_id = ${fieldId} OR b_field_id = ${fieldId}
    LIMIT 1
  `.execute(trx);

  const rel = row.rows[0];
  if (!rel) return null;
  // Per-field allowMultiple lives in the field config (authoritative); fall back to the relation.
  const cfg = await sql<{ config: Record<string, unknown> }>`
    SELECT config FROM data.fields WHERE id = ${fieldId}
  `.execute(trx);
  const cfgMulti = cfg.rows[0]?.config?.["allowMultiple"];

  if (rel.a_field_id === fieldId) {
    return {
      relationId: rel.id,
      side: "a",
      allowMultiple: typeof cfgMulti === "boolean" ? cfgMulti : rel.allow_multiple_a,
      peerTableId: rel.b_table_id,
      ownTableId: rel.a_table_id,
      peerFieldId: rel.b_field_id,
      aFieldId: rel.a_field_id,
      bFieldId: rel.b_field_id,
    };
  }

  return {
    relationId: rel.id,
    side: "b",
    allowMultiple: typeof cfgMulti === "boolean" ? cfgMulti : rel.allow_multiple_b,
    peerTableId: rel.a_table_id,
    ownTableId: rel.b_table_id,
    peerFieldId: rel.a_field_id,
    aFieldId: rel.a_field_id,
    bFieldId: rel.b_field_id,
  };
}

/** Ordered peer ids (including links to soft-deleted peers) on `rel`'s side for `recordId`. */
async function currentLinks(
  trx: DbTrx,
  rel: LinkRelationContext,
  recordId: string,
): Promise<Array<{ peer: string; order: string }>> {
  if (rel.side === "a") {
    const rows = await sql<{ peer: string; ord: string }>`
      SELECT b_record_id AS peer, a_order AS ord FROM data.record_links
      WHERE relation_id = ${rel.relationId} AND a_record_id = ${recordId}
        AND deletion_batch_id IS NULL
      ORDER BY a_order ASC, b_record_id ASC
    `.execute(trx);
    return rows.rows.map((r) => ({ peer: r.peer, order: r.ord }));
  }
  const rows = await sql<{ peer: string; ord: string }>`
    SELECT a_record_id AS peer, b_order AS ord FROM data.record_links
    WHERE relation_id = ${rel.relationId} AND b_record_id = ${recordId}
      AND deletion_batch_id IS NULL
    ORDER BY b_order ASC, a_record_id ASC
  `.execute(trx);
  return rows.rows.map((r) => ({ peer: r.peer, order: r.ord }));
}

function normalizeRecordId(raw: string): string {
  if (raw.includes("_")) {
    return parsePid(raw, "rec");
  }
  return raw.toLowerCase();
}

/** Throws 422 when any id is not a live record of `tableId`. */
export async function assertRecordsExist(trx: DbTrx, tableId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await sql<{ id: string }>`
    SELECT id FROM data.records
    WHERE table_id = ${tableId} AND id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
  `.execute(trx);
  const found = new Set(r.rows.map((x) => x.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApiError(422, "LINK_TARGET_NOT_FOUND", `Linked record not found in the linked table: ${missing.length === 1 ? "1 id" : `${missing.length} ids`}`, {
      missing: missing.map((m) => `rec_${m}`),
    });
  }
}

export interface LinkWriteResult {
  relationId: string;
  ownTableId: string;
  peerTableId: string;
  peerFieldId: string | null;
  /** Peers newly linked / unlinked (their inverse field changed). */
  added: string[];
  removed: string[];
  /** Ordered peer ids after the write. */
  next: string[];
  changed: boolean;
}

/**
 * Replace (or add to / remove from) one record's side of a link field.
 * Validates targets, cardinality and keeps fractional ordering on both sides.
 */
export async function writeRecordLinksInTx(
  trx: DbTrx,
  params: {
    workspaceId: string;
    baseId: string;
    fieldId: string;
    recordId: string;
    targetIds: string[];
    mode?: "replace" | "add" | "remove";
  },
): Promise<LinkWriteResult> {
  const rel = await getLinkRelationForField(trx, params.fieldId);
  if (!rel) throw new ApiError(404, "LINK_FIELD_NOT_FOUND", "Link field has no relation");
  const mode = params.mode ?? "replace";
  const targets: string[] = [];
  for (const t of params.targetIds) {
    const id = normalizeRecordId(t);
    if (!targets.includes(id)) targets.push(id);
  }
  const current = await currentLinks(trx, rel, params.recordId);
  const currentIds = current.map((c) => c.peer);

  let desired: string[];
  if (mode === "replace") desired = targets;
  else if (mode === "add") desired = [...currentIds, ...targets.filter((t) => !currentIds.includes(t))];
  else desired = currentIds.filter((id) => !targets.includes(id));

  if (!rel.allowMultiple && desired.length > 1) {
    throw new ApiError(422, "LINK_CARDINALITY", "This link field only allows a single linked record");
  }
  const added = desired.filter((id) => !currentIds.includes(id));
  const removed = currentIds.filter((id) => !desired.includes(id));
  await assertRecordsExist(trx, rel.peerTableId, added);

  const ownOrderCol = rel.side === "a" ? "a_order" : "b_order";
  const peerOrderCol = rel.side === "a" ? "b_order" : "a_order";
  const ownCol = rel.side === "a" ? "a_record_id" : "b_record_id";
  const peerCol = rel.side === "a" ? "b_record_id" : "a_record_id";

  if (removed.length > 0) {
    await sql`
      DELETE FROM data.record_links
      WHERE relation_id = ${rel.relationId}
        AND ${sql.ref(ownCol)} = ${params.recordId}
        AND ${sql.ref(peerCol)} = ANY(${removed}::uuid[])
    `.execute(trx);
  }

  // Own-side order: keep existing keys when the result is "retained, then added".
  const retained = current.filter((c) => desired.includes(c.peer));
  const appendOrder = [...retained.map((c) => c.peer), ...added];
  const orderUnchanged = mode !== "replace" || desired.every((id, i) => appendOrder[i] === id);
  const ownOrder = new Map<string, string>();
  if (orderUnchanged) {
    // Append new links after the last retained one.
    let last = retained.length ? retained[retained.length - 1]!.order : null;
    for (const c of retained) ownOrder.set(c.peer, c.order);
    for (const id of added) {
      let k: string;
      try {
        k = keyBetween(last, null);
      } catch {
        k = keyBetween(null, null);
      }
      ownOrder.set(id, k);
      last = k;
    }
  } else {
    const keys = keysBetween(null, null, desired.length);
    desired.forEach((id, i) => ownOrder.set(id, keys[i]!));
    for (const c of retained) {
      const k = ownOrder.get(c.peer)!;
      if (k !== c.order) {
        await sql`
          UPDATE data.record_links SET ${sql.ref(ownOrderCol)} = ${k}
          WHERE relation_id = ${rel.relationId} AND ${sql.ref(ownCol)} = ${params.recordId}
            AND ${sql.ref(peerCol)} = ${c.peer}
        `.execute(trx);
      }
    }
  }

  if (added.length > 0) {
    // Peer-side order: append to the end of each peer's list.
    const maxRows = await sql<{ peer: string; mx: string | null }>`
      SELECT ${sql.ref(peerCol)} AS peer, max(${sql.ref(peerOrderCol)}) AS mx
      FROM data.record_links
      WHERE relation_id = ${rel.relationId} AND ${sql.ref(peerCol)} = ANY(${added}::uuid[])
      GROUP BY ${sql.ref(peerCol)}
    `.execute(trx);
    const maxByPeer = new Map(maxRows.rows.map((r) => [r.peer, r.mx]));
    for (const peer of added) {
      let peerKey: string;
      try {
        peerKey = keyBetween(maxByPeer.get(peer) ?? null, null);
      } catch {
        peerKey = keyBetween(null, null);
      }
      const ownKey = ownOrder.get(peer)!;
      const aId = rel.side === "a" ? params.recordId : peer;
      const bId = rel.side === "a" ? peer : params.recordId;
      const aOrder = rel.side === "a" ? ownKey : peerKey;
      const bOrder = rel.side === "a" ? peerKey : ownKey;
      await sql`
        INSERT INTO data.record_links (
          relation_id, a_record_id, b_record_id, a_order, b_order, workspace_id, base_id
        ) VALUES (
          ${rel.relationId}, ${aId}, ${bId}, ${aOrder}, ${bOrder}, ${params.workspaceId}, ${params.baseId}
        )
        ON CONFLICT (relation_id, a_record_id, b_record_id)
        DO UPDATE SET deletion_batch_id = NULL, a_order = EXCLUDED.a_order, b_order = EXCLUDED.b_order
      `.execute(trx);
    }
  }

  const reordered = !orderUnchanged;
  return {
    relationId: rel.relationId,
    ownTableId: rel.ownTableId,
    peerTableId: rel.peerTableId,
    peerFieldId: rel.peerFieldId,
    added,
    removed,
    next: desired,
    changed: added.length > 0 || removed.length > 0 || reordered,
  };
}

/** Ordered live peer ids for one record of a link field. */
export async function readRecordLinks(trx: DbTrx, fieldId: string, recordId: string): Promise<string[]> {
  const rel = await getLinkRelationForField(trx, fieldId);
  if (!rel) return [];
  return (await currentLinks(trx, rel, recordId)).map((c) => c.peer);
}

/** Legacy op-based API (POST/DELETE …/links). */
export async function applyLinkOpsInTx(
  trx: DbTrx,
  params: {
    workspaceId: string;
    baseId: string;
    tableId: string;
    recordId: string;
    fieldId: string;
    ops: LinkSetOp[];
  },
): Promise<{ nextIds: string[]; result: LinkWriteResult }> {
  const merged = mergeLinkOps(params.ops.map((op) => ({ ...op, recordId: normalizeRecordId(op.recordId) })));
  let result = await writeRecordLinksInTx(trx, {
    workspaceId: params.workspaceId,
    baseId: params.baseId,
    fieldId: params.fieldId,
    recordId: params.recordId,
    targetIds: merged.remove,
    mode: "remove",
  });
  const removed = result.removed;
  result = await writeRecordLinksInTx(trx, {
    workspaceId: params.workspaceId,
    baseId: params.baseId,
    fieldId: params.fieldId,
    recordId: params.recordId,
    targetIds: merged.add.map((a) => a.recordId),
    mode: "add",
  });
  result = { ...result, removed: [...removed, ...result.removed] };
  result.changed = result.added.length > 0 || result.removed.length > 0;
  return { nextIds: result.next, result };
}

/**
 * Legacy helper: callers that still put link arrays in cells. Only slots in
 * `changedSlots` are applied (never re-sync untouched link cells — that was
 * the data-loss bug). Returns field ids whose links changed, plus the peer
 * changes for compute.
 */
export async function syncRecordLinksFromCells(
  trx: DbTrx,
  params: {
    workspaceId: string;
    baseId: string;
    tableId: string;
    recordId: string;
    linkFields: Array<{ fieldId: string; slot: number }>;
    cells: Record<string, unknown>;
    changedSlots?: Record<string, unknown>;
  },
): Promise<string[]> {
  const res = await syncLinkCellsDetailed(trx, params);
  return res.map((r) => r.fieldId);
}

export async function syncLinkCellsDetailed(
  trx: DbTrx,
  params: {
    workspaceId: string;
    baseId: string;
    tableId: string;
    recordId: string;
    linkFields: Array<{ fieldId: string; slot: number }>;
    cells: Record<string, unknown>;
    changedSlots?: Record<string, unknown>;
  },
): Promise<Array<{ fieldId: string; result: LinkWriteResult }>> {
  const out: Array<{ fieldId: string; result: LinkWriteResult }> = [];
  const source = params.changedSlots ?? params.cells;
  for (const lf of params.linkFields) {
    const slotKey = String(lf.slot);
    if (!(slotKey in source)) continue;
    const raw = source[slotKey];
    const desired = Array.isArray(raw)
      ? raw
          .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? (x as { id?: unknown }).id : null))
          .filter((x): x is string => typeof x === "string")
      : typeof raw === "string" && raw
        ? [raw]
        : [];
    const result = await writeRecordLinksInTx(trx, {
      workspaceId: params.workspaceId,
      baseId: params.baseId,
      fieldId: lf.fieldId,
      recordId: params.recordId,
      targetIds: desired,
    });
    if (result.changed) out.push({ fieldId: lf.fieldId, result });
  }
  return out;
}
