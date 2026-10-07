/**
 * Record revision history, built from the change log (`data.base_changes`).
 *
 * - `record.updated` ops carry the full cell map after the write; the matching
 *   inverse op (or `prevCells` on undo/redo ops) has the map before it, so a
 *   field change is any slot whose value differs.
 * - Link changes are not in cells: record ops carry `links: LinkDiff[]`
 *   (`records/write.ts`), which also lets the peer record find "linked from"
 *   changes. The links route writes `link.add`/`link.remove` +
 *   `records.links_changed` instead.
 * - Values are returned in the record wire format (rendered client-side with
 *   the field's display formatting); `fields` describes every referenced
 *   field, including deleted ones (last known name).
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "@tabula/db";
import type { TabulaStorage } from "@tabula/storage";
import { pid } from "../../lib/public-ids.js";
import {
  displayText,
  loadUsers,
  serializeRecords,
  type LinkWire,
  type RecordRowLike,
  type SerializeFieldRow,
  type UserWire,
} from "../records/serialize.js";
import { configToWire } from "../schema/field-dto.js";

type Db = Kysely<Database>;

export interface ChangeLogRow {
  seq: string | number;
  created_at: Date | string;
  actor_type: string;
  actor_id: string | null;
  via: string;
  client_mutation_id: string | null;
  ops: unknown;
  inverse_ops: unknown;
}

export interface HistoryFieldMeta {
  id: string;
  slot: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isComputed: boolean;
  deleted: boolean;
}

export type RawChange =
  | { fieldId: string; before: unknown; after: unknown }
  | { fieldId: string; added: string[]; removed: string[] };

export type HistoryKind = "created" | "updated" | "deleted" | "restored";

export interface RawEntry {
  seq: number;
  at: Date;
  kind: HistoryKind;
  actorType: string;
  actorId: string | null;
  via: string;
  clientMutationId: string | null;
  duplicatedFrom?: string;
  changes: RawChange[];
  /** False when the change log has no values for this change (undo rows written before values were kept). */
  detailed: boolean;
}

export interface EntryContext {
  fieldForSlot(slot: string): HistoryFieldMeta | undefined;
  /** Inverse link field of a link field (null for one-way / self links). */
  peerFieldOf(fieldId: string): string | null;
}

/** Field types whose values are not user edits (or not stored in cells). */
const NOT_REVISIONED = new Set([
  "link",
  "contact",
  "autonumber",
  "created_time",
  "modified_time",
  "created_by",
  "modified_by",
  "button",
]);

const KIND_RANK: Record<HistoryKind, number> = { created: 4, deleted: 3, restored: 2, updated: 1 };

type Op = Record<string, unknown>;

function asOps(v: unknown): Op[] {
  return Array.isArray(v) ? v.filter((o): o is Op => !!o && typeof o === "object" && !Array.isArray(o)) : [];
}

function asMap(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function touches(op: Op, recordId: string): boolean {
  return op["recordId"] === recordId || strings(op["recordIds"]).includes(recordId);
}

function sameValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  if (empty(a) && empty(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One change-log row → the history entry for `recordId` (raw uuids, stored values), or null. */
export function entryFromChange(row: ChangeLogRow, recordId: string, ctx: EntryContext): RawEntry | null {
  const ops = asOps(row.ops);
  const inverse = asOps(row.inverse_ops);
  let kind: HistoryKind | null = null;
  let duplicatedFrom: string | undefined;
  let detailed = true;
  const cellChanges: RawChange[] = [];
  const links = new Map<string, { added: Set<string>; removed: Set<string> }>();

  const setKind = (k: HistoryKind) => {
    if (!kind || KIND_RANK[k] > KIND_RANK[kind]) kind = k;
  };
  const addLink = (fieldId: unknown, added: string[], removed: string[]) => {
    if (typeof fieldId !== "string" || (!added.length && !removed.length)) return;
    let e = links.get(fieldId);
    if (!e) links.set(fieldId, (e = { added: new Set(), removed: new Set() }));
    for (const id of added) e.removed.has(id) ? e.removed.delete(id) : e.added.add(id);
    for (const id of removed) e.added.has(id) ? e.added.delete(id) : e.removed.add(id);
  };

  for (const op of ops) {
    const name = typeof op["op"] === "string" ? op["op"] : "";
    if (Array.isArray(op["links"])) {
      for (const d of asOps(op["links"])) {
        const added = strings(d["added"]);
        const removed = strings(d["removed"]);
        if (d["recordId"] === recordId) {
          addLink(d["fieldId"], added, removed);
        } else if (typeof d["recordId"] === "string" && typeof d["peerFieldId"] === "string") {
          const other = d["recordId"];
          addLink(d["peerFieldId"], added.includes(recordId) ? [other] : [], removed.includes(recordId) ? [other] : []);
        }
      }
    }
    if (!touches(op, recordId)) continue;
    switch (name) {
      case "record.created":
      case "records.created":
        setKind("created");
        if (typeof op["duplicatedFrom"] === "string") duplicatedFrom = op["duplicatedFrom"];
        break;
      case "record.soft_deleted":
      case "records.soft_deleted":
      case "record.deleted":
      case "records.deleted":
        setKind("deleted");
        break;
      case "record.restored":
      case "record.restore":
        setKind("restored");
        break;
      case "record.updated": {
        setKind("updated");
        const after = asMap(op["cells"]);
        const before =
          asMap(op["prevCells"]) ??
          asMap(inverse.find((i) => i["op"] === "record.updated" && i["recordId"] === recordId)?.["cells"]);
        if (!after || !before) {
          if (!Array.isArray(op["links"])) detailed = false;
          break;
        }
        for (const slot of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (sameValue(before[slot], after[slot])) continue;
          const f = ctx.fieldForSlot(slot);
          if (!f || f.isComputed || NOT_REVISIONED.has(f.type)) continue;
          cellChanges.push({ fieldId: f.id, before: before[slot], after: after[slot] });
        }
        break;
      }
      case "link.add":
      case "link.remove": {
        if (op["recordId"] !== recordId) break;
        setKind("updated");
        const peers = ops.filter((o) => o["op"] === "records.links_changed").flatMap((o) => strings(o["recordIds"]));
        addLink(op["fieldId"], name === "link.add" ? peers : [], name === "link.remove" ? peers : []);
        break;
      }
      case "records.links_changed": {
        const src = ops.find(
          (o) => (o["op"] === "link.add" || o["op"] === "link.remove") && typeof o["recordId"] === "string" && o["recordId"] !== recordId,
        );
        const peerField = typeof src?.["fieldId"] === "string" ? ctx.peerFieldOf(src["fieldId"]) : null;
        if (!src || !peerField) break;
        setKind("updated");
        const other = src["recordId"] as string;
        addLink(peerField, src["op"] === "link.add" ? [other] : [], src["op"] === "link.remove" ? [other] : []);
        break;
      }
      default:
        break;
    }
  }

  const changes: RawChange[] = [...cellChanges];
  for (const [fieldId, e] of links) {
    if (e.added.size || e.removed.size) changes.push({ fieldId, added: [...e.added], removed: [...e.removed] });
  }
  if (!kind && changes.length) kind = "updated";
  if (!kind) return null;
  if (kind === "updated" && changes.length === 0 && detailed) return null;

  const entry: RawEntry = {
    seq: Number(row.seq),
    at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    kind,
    actorType: row.actor_type,
    actorId: row.actor_id,
    via: row.via,
    clientMutationId: row.client_mutation_id,
    changes,
    detailed,
  };
  if (duplicatedFrom) entry.duplicatedFrom = duplicatedFrom;
  return entry;
}

export type HistorySource = "user" | "automation" | "form" | "import" | "undo" | "redo" | "restore" | "system";

export function sourceOf(e: Pick<RawEntry, "kind" | "actorType" | "via" | "clientMutationId">, createdVia: string | null): HistorySource {
  if (e.clientMutationId?.startsWith("aut:") || e.actorType === "automation") return "automation";
  if (e.via === "undo" || e.via === "redo" || e.via === "restore") return e.via;
  if (e.kind === "created" && (createdVia === "form" || createdVia === "import")) return createdVia;
  if (e.via === "form" || e.via === "import" || e.via === "automation") return e.via;
  if (e.actorType === "public_form") return "form";
  if (e.actorType === "system") return "system";
  return "user";
}

/* ───────────────────────── wire shapes ───────────────────────── */

export type HistoryChangeWire =
  | { fieldId: string; before?: unknown; after?: unknown }
  | { fieldId: string; added: LinkWire[]; removed: LinkWire[] };

export interface HistoryEntryWire {
  id: string;
  seq: number;
  at: string;
  kind: HistoryKind;
  actor: UserWire | null;
  source: HistorySource;
  /** Automation name when `source` is "automation" and the run is known. */
  sourceName?: string;
  duplicatedFrom?: LinkWire;
  changes: HistoryChangeWire[];
  detailed: boolean;
}

export interface HistoryFieldWire {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  deleted: boolean;
}

export interface RecordHistoryWire {
  entries: HistoryEntryWire[];
  fields: Record<string, HistoryFieldWire>;
  nextCursor: string | null;
  retentionDays: number | null;
}

export interface LoadHistoryParams {
  baseId: string;
  tableId: string;
  recordId: string;
  /** Return entries with seq below this one (exclusive). */
  beforeSeq?: number | null;
  limit: number;
  retentionDays: number | null;
  storage?: TabulaStorage | null;
}

/** Primary display names of records in a table, deleted ones included. */
async function loadNamesAnyState(db: Db, tableId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const pf = await sql<{ slot: number; type: string; config: Record<string, unknown>; is_computed: boolean }>`
    SELECT f.slot, f.type, f.config, f.is_computed
    FROM data.tables t JOIN data.fields f ON f.id = t.primary_field_id
    WHERE t.id = ${tableId}
  `.execute(db);
  const prim = pf.rows[0];
  const rows = await sql<{ id: string; cells: Record<string, unknown>; computed: Record<string, unknown>; row_number: string; created_at: Date; updated_at: Date }>`
    SELECT id, cells, computed, row_number, created_at, updated_at
    FROM data.records WHERE table_id = ${tableId} AND id = ANY(${ids}::uuid[])
  `.execute(db);
  let users: Map<string, UserWire> | undefined;
  if (prim?.type === "collaborator") {
    const uids = rows.rows.flatMap((r) => {
      const v = r.cells?.[String(prim.slot)];
      return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
    });
    users = await loadUsers(db, uids);
  }
  for (const r of rows.rows) {
    if (!prim) {
      out.set(r.id, "");
      continue;
    }
    const info = { slot: prim.slot, type: prim.type, config: prim.config ?? {}, is_computed: prim.is_computed };
    const stored = prim.is_computed ? r.computed?.[String(prim.slot)] : r.cells?.[String(prim.slot)];
    out.set(r.id, displayText(info, stored, r, users));
  }
  return out;
}

const MAX_SCAN_ROUNDS = 8;

export async function loadRecordHistory(db: Db, p: LoadHistoryParams): Promise<RecordHistoryWire> {
  const fieldRows = await sql<{ id: string; slot: number; name: string; type: string; config: Record<string, unknown> | null; is_computed: boolean; deleted_at: Date | null }>`
    SELECT id, slot, name, type, config, is_computed, deleted_at
    FROM data.fields WHERE table_id = ${p.tableId}
    ORDER BY (deleted_at IS NULL) DESC, created_at DESC
  `.execute(db);
  const fieldsById = new Map<string, HistoryFieldMeta>();
  const fieldsBySlot = new Map<string, HistoryFieldMeta>();
  for (const f of fieldRows.rows) {
    const meta: HistoryFieldMeta = {
      id: f.id,
      slot: f.slot,
      name: f.name,
      type: f.type,
      config: f.config ?? {},
      isComputed: f.is_computed,
      deleted: f.deleted_at !== null,
    };
    fieldsById.set(f.id, meta);
    if (!fieldsBySlot.has(String(f.slot))) fieldsBySlot.set(String(f.slot), meta);
  }

  const rels = await sql<{ a_field_id: string; b_field_id: string | null; a_table_id: string; b_table_id: string }>`
    SELECT a_field_id, b_field_id, a_table_id, b_table_id FROM data.link_relations WHERE base_id = ${p.baseId}
  `.execute(db);
  const peerField = new Map<string, string | null>();
  const peerTable = new Map<string, string>();
  for (const r of rels.rows) {
    peerField.set(r.a_field_id, r.b_field_id);
    peerTable.set(r.a_field_id, r.b_table_id);
    if (r.b_field_id) {
      peerField.set(r.b_field_id, r.a_field_id);
      peerTable.set(r.b_field_id, r.a_table_id);
    }
  }
  const ctx: EntryContext = {
    fieldForSlot: (slot) => fieldsBySlot.get(slot),
    peerFieldOf: (fieldId) => peerField.get(fieldId) ?? null,
  };

  const R = p.recordId;
  const patterns = [
    JSON.stringify([{ recordId: R }]),
    JSON.stringify([{ recordIds: [R] }]),
    JSON.stringify([{ links: [{ added: [R] }] }]),
    JSON.stringify([{ links: [{ removed: [R] }] }]),
  ];
  const cutoff = p.retentionDays ? new Date(Date.now() - p.retentionDays * 86_400_000).toISOString() : null;
  const batch = Math.min(500, p.limit * 2 + 10);

  const raw: RawEntry[] = [];
  let before = p.beforeSeq ?? null;
  let exhausted = false;
  for (let round = 0; round < MAX_SCAN_ROUNDS && raw.length < p.limit; round++) {
    const res = await sql<ChangeLogRow>`
      SELECT seq, created_at, actor_type, actor_id, via, client_mutation_id, ops, inverse_ops
      FROM data.base_changes
      WHERE base_id = ${p.baseId}
        AND (${before === null ? null : String(before)}::bigint IS NULL OR seq < ${before === null ? null : String(before)}::bigint)
        AND (${cutoff}::timestamptz IS NULL OR created_at >= ${cutoff}::timestamptz)
        AND (ops @> ${patterns[0]}::jsonb OR ops @> ${patterns[1]}::jsonb
             OR ops @> ${patterns[2]}::jsonb OR ops @> ${patterns[3]}::jsonb)
      ORDER BY seq DESC
      LIMIT ${batch}
    `.execute(db);
    for (const row of res.rows) {
      before = Number(row.seq);
      const e = entryFromChange(row, R, ctx);
      if (e) raw.push(e);
      if (raw.length >= p.limit) break;
    }
    if (res.rows.length < batch && raw.length < p.limit) {
      exhausted = true;
      break;
    }
  }
  const nextCursor = exhausted || before === null ? null : String(before);

  /* ---- hydrate ---- */
  const created = await sql<{ created_via: string | null }>`
    SELECT created_via FROM data.records WHERE table_id = ${p.tableId} AND id = ${R}
  `.execute(db);
  const createdVia = created.rows[0]?.created_via ?? null;

  const users = await loadUsers(db, [...new Set(raw.map((e) => e.actorId).filter((x): x is string => !!x))]);

  const runIds = [
    ...new Set(
      raw
        .map((e) => (e.clientMutationId?.startsWith("aut:") ? e.clientMutationId.slice(4) : ""))
        .filter((x) => /^[0-9a-f-]{36}$/i.test(x)),
    ),
  ];
  const automationNames = new Map<string, string>();
  if (runIds.length) {
    const r = await sql<{ id: string; name: string }>`
      SELECT r.id, a.name FROM data.automation_runs r JOIN data.automations a ON a.id = r.automation_id
      WHERE r.id = ANY(${runIds}::uuid[])
    `.execute(db);
    for (const x of r.rows) automationNames.set(x.id, x.name);
  }

  // Cell values → wire values, through the record serializer (one batched call).
  const cellFields: SerializeFieldRow[] = [...fieldsById.values()]
    .filter((f) => !f.isComputed && !NOT_REVISIONED.has(f.type))
    .map((f) => ({ id: f.id, slot: f.slot, name: f.name, type: f.type, config: f.config, is_computed: false }));
  const synthetic: RecordRowLike[] = [];
  const valueRef: Array<{ change: { before: unknown; after: unknown }; side: "before" | "after"; fieldId: string; row: number }> = [];
  for (const e of raw) {
    for (const c of e.changes) {
      if (!("before" in c)) continue;
      const f = fieldsById.get(c.fieldId);
      if (!f) continue;
      for (const side of ["before", "after"] as const) {
        const v = c[side];
        if (v === undefined || v === null) continue;
        valueRef.push({ change: c, side, fieldId: c.fieldId, row: synthetic.length });
        synthetic.push({ id: R, version: 1, row_number: 0, manual_order: "", cells: { [String(f.slot)]: v }, created_at: e.at });
      }
    }
  }
  const wireRows = synthetic.length
    ? await serializeRecords(db, p.tableId, synthetic, { fields: cellFields, storage: p.storage ?? null })
    : [];
  const wireValue = new Map<object, { before?: unknown; after?: unknown }>();
  for (const ref of valueRef) {
    const w = wireRows[ref.row]?.fields[pid("fld", ref.fieldId)];
    const slot = wireValue.get(ref.change) ?? {};
    if (w !== undefined) slot[ref.side] = w;
    wireValue.set(ref.change, slot);
  }

  // Link ids → {id, name}, grouped by the table they live in.
  const idsByTable = new Map<string, Set<string>>();
  const want = (table: string | undefined, ids: string[]) => {
    if (!table) return;
    let s = idsByTable.get(table);
    if (!s) idsByTable.set(table, (s = new Set()));
    for (const id of ids) s.add(id);
  };
  for (const e of raw) {
    if (e.duplicatedFrom) want(p.tableId, [e.duplicatedFrom]);
    for (const c of e.changes) if ("added" in c) want(peerTable.get(c.fieldId), [...c.added, ...c.removed]);
  }
  const names = new Map<string, Map<string, string>>();
  for (const [table, ids] of idsByTable) names.set(table, await loadNamesAnyState(db, table, [...ids]));
  const linkWire = (table: string | undefined, id: string): LinkWire => ({
    id: pid("rec", id),
    name: (table ? names.get(table)?.get(id) : undefined) ?? "",
  });

  const usedFields = new Set<string>();
  const entries: HistoryEntryWire[] = raw.map((e) => {
    const changes: HistoryChangeWire[] = [];
    for (const c of e.changes) {
      if (!fieldsById.has(c.fieldId)) continue;
      usedFields.add(c.fieldId);
      const fieldId = pid("fld", c.fieldId);
      if ("added" in c) {
        const t = peerTable.get(c.fieldId);
        changes.push({ fieldId, added: c.added.map((id) => linkWire(t, id)), removed: c.removed.map((id) => linkWire(t, id)) });
      } else {
        const v = wireValue.get(c) ?? {};
        if (v.before === undefined && v.after === undefined) continue;
        changes.push({ fieldId, ...v });
      }
    }
    const source = sourceOf(e, createdVia);
    const out: HistoryEntryWire = {
      id: `${e.seq}`,
      seq: e.seq,
      at: e.at.toISOString(),
      kind: e.kind,
      actor: e.actorId ? (users.get(e.actorId) ?? null) : null,
      source,
      changes,
      detailed: e.detailed,
    };
    const runId = e.clientMutationId?.startsWith("aut:") ? e.clientMutationId.slice(4) : "";
    const autName = automationNames.get(runId);
    if (source === "automation" && autName) out.sourceName = autName;
    if (e.duplicatedFrom) out.duplicatedFrom = linkWire(p.tableId, e.duplicatedFrom);
    return out;
  });

  const fields: Record<string, HistoryFieldWire> = {};
  for (const id of usedFields) {
    const f = fieldsById.get(id)!;
    fields[pid("fld", id)] = {
      id: pid("fld", id),
      name: f.name,
      type: f.type,
      config: configToWire(f.type, f.config, new Map()),
      deleted: f.deleted,
    };
  }
  return { entries, fields, nextCursor, retentionDays: p.retentionDays };
}
