/**
 * Field/table schema loading shared by B's modules (records writes, fields,
 * compute, links). Config is stored with raw uuids.
 */
import type { Database, TabulaDb } from "@tabula/db";
import { sql, type Kysely, type Transaction } from "kysely";

export type Db = Kysely<Database> | Transaction<Database> | TabulaDb;

export interface FieldRowFull {
  id: string;
  tableId: string;
  slot: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  description: string;
  isComputed: boolean;
  orderKey: string;
  indexState: string;
}

interface RawFieldRow {
  id: string;
  table_id: string;
  slot: number;
  name: string;
  type: string;
  config: unknown;
  description: string;
  is_computed: boolean;
  order_key: string;
  index_state: string;
}

function mapField(r: RawFieldRow): FieldRowFull {
  return {
    id: r.id,
    tableId: r.table_id,
    slot: Number(r.slot),
    name: r.name,
    type: r.type,
    config: (r.config ?? {}) as Record<string, unknown>,
    description: r.description ?? "",
    isComputed: r.is_computed,
    orderKey: r.order_key,
    indexState: r.index_state ?? "none",
  };
}

const FIELD_COLUMNS = sql.raw(
  "id, table_id, slot, name, type, config, description, is_computed, order_key, index_state",
);

export async function loadTableFieldRows(db: Db, tableId: string): Promise<FieldRowFull[]> {
  const r = await sql<RawFieldRow>`
    SELECT ${FIELD_COLUMNS} FROM data.fields
    WHERE table_id = ${tableId} AND deleted_at IS NULL
    ORDER BY order_key ASC, slot ASC
  `.execute(db as Kysely<Database>);
  return r.rows.map(mapField);
}

export async function loadBaseFieldRows(db: Db, baseId: string): Promise<FieldRowFull[]> {
  const r = await sql<RawFieldRow>`
    SELECT f.id, f.table_id, f.slot, f.name, f.type, f.config, f.description, f.is_computed,
           f.order_key, f.index_state
    FROM data.fields f
    JOIN data.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
    WHERE f.base_id = ${baseId} AND f.deleted_at IS NULL
    ORDER BY f.order_key ASC, f.slot ASC
  `.execute(db as Kysely<Database>);
  return r.rows.map(mapField);
}

export async function loadFieldRow(
  db: Db,
  tableId: string,
  fieldId: string,
): Promise<FieldRowFull | null> {
  const r = await sql<RawFieldRow>`
    SELECT ${FIELD_COLUMNS} FROM data.fields
    WHERE id = ${fieldId} AND table_id = ${tableId} AND deleted_at IS NULL
  `.execute(db as Kysely<Database>);
  const row = r.rows[0];
  return row ? mapField(row) : null;
}

export interface TableRow {
  id: string;
  baseId: string;
  workspaceId: string;
  name: string;
  primaryFieldId: string | null;
  orderKey: string;
  recordCount: number;
  description: string;
}

export async function loadTableRow(db: Db, tableId: string): Promise<TableRow | null> {
  const r = await sql<{
    id: string;
    base_id: string;
    workspace_id: string;
    name: string;
    primary_field_id: string | null;
    order_key: string;
    record_count: string;
    description: string;
  }>`
    SELECT id, base_id, workspace_id, name, primary_field_id, order_key, record_count, description
    FROM data.tables WHERE id = ${tableId} AND deleted_at IS NULL
  `.execute(db as Kysely<Database>);
  const t = r.rows[0];
  if (!t) return null;
  return {
    id: t.id,
    baseId: t.base_id,
    workspaceId: t.workspace_id,
    name: t.name,
    primaryFieldId: t.primary_field_id,
    orderKey: t.order_key,
    recordCount: Number(t.record_count),
    description: t.description ?? "",
  };
}

export interface TableSchema {
  table: TableRow;
  fields: FieldRowFull[];
  byId: Map<string, FieldRowFull>;
  bySlot: Map<string, FieldRowFull>;
}

export async function loadTableSchema(db: Db, tableId: string): Promise<TableSchema | null> {
  const table = await loadTableRow(db, tableId);
  if (!table) return null;
  const fields = await loadTableFieldRows(db, tableId);
  return {
    table,
    fields,
    byId: new Map(fields.map((f) => [f.id, f])),
    bySlot: new Map(fields.map((f) => [String(f.slot), f])),
  };
}

export interface LinkRelationRow {
  id: string;
  aTableId: string;
  aFieldId: string;
  bTableId: string;
  bFieldId: string | null;
  allowMultipleA: boolean;
  allowMultipleB: boolean;
}

export async function loadRelationForField(db: Db, fieldId: string): Promise<LinkRelationRow | null> {
  const r = await sql<{
    id: string;
    a_table_id: string;
    a_field_id: string;
    b_table_id: string;
    b_field_id: string | null;
    allow_multiple_a: boolean;
    allow_multiple_b: boolean;
  }>`
    SELECT id, a_table_id, a_field_id, b_table_id, b_field_id, allow_multiple_a, allow_multiple_b
    FROM data.link_relations
    WHERE a_field_id = ${fieldId} OR b_field_id = ${fieldId}
    LIMIT 1
  `.execute(db as Kysely<Database>);
  const x = r.rows[0];
  if (!x) return null;
  return {
    id: x.id,
    aTableId: x.a_table_id,
    aFieldId: x.a_field_id,
    bTableId: x.b_table_id,
    bFieldId: x.b_field_id,
    allowMultipleA: x.allow_multiple_a,
    allowMultipleB: x.allow_multiple_b,
  };
}

/** Lowercased-name index for resolving `fields` input keys and formula refs. */
export function resolveFieldKey(
  fields: readonly FieldRowFull[],
  key: string,
  decodeFieldPid: (s: string) => string | null,
): FieldRowFull | undefined {
  if (key.startsWith("fld_")) {
    const id = decodeFieldPid(key);
    return id ? fields.find((f) => f.id === id) : undefined;
  }
  const byId = fields.find((f) => f.id === key);
  if (byId) return byId;
  const exact = fields.find((f) => f.name === key);
  if (exact) return exact;
  const lk = key.trim().toLowerCase();
  return fields.find((f) => f.name.toLowerCase() === lk);
}
