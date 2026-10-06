import { sql } from "kysely";
import type { TabulaDb } from "@tabula/db";
import type { SqlFieldInfo } from "@tabula/filter";
import type { PlanQueryContext } from "@tabula/query";
import { decodePublicId } from "@tabula/types";
import { pid } from "../../lib/public-ids.js";

export interface QueryFieldRow {
  id: string;
  slot: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  index_state: string;
  is_computed: boolean;
}

export async function loadQueryFields(db: TabulaDb, tableId: string): Promise<QueryFieldRow[]> {
  const result = await sql<QueryFieldRow>`
    SELECT id, slot, name, type, config, index_state, is_computed
    FROM data.fields
    WHERE table_id = ${tableId} AND deleted_at IS NULL
    ORDER BY order_key COLLATE "C", slot ASC
  `.execute(db);
  return result.rows.map((r) => ({ ...r, config: (r.config ?? {}) as Record<string, unknown> }));
}

function toInfo(f: { id: string; slot: number; type: string; config: Record<string, unknown> | null; is_computed: boolean }): SqlFieldInfo {
  return { id: f.id, slot: f.slot, type: f.type, config: f.config ?? {}, isComputed: f.is_computed };
}

/** Field metadata for SQL compilation: link relations and peer primary fields resolved. */
export async function loadSqlFieldInfos(db: TabulaDb, fields: QueryFieldRow[]): Promise<SqlFieldInfo[]> {
  const infos = fields.map(toInfo);
  const linkIds = fields.filter((f) => f.type === "link" || f.type === "contact").map((f) => f.id);
  if (linkIds.length === 0) return infos;
  const rels = await sql<{ id: string; a_field_id: string; b_field_id: string | null; a_table_id: string; b_table_id: string }>`
    SELECT id, a_field_id, b_field_id, a_table_id, b_table_id
    FROM data.link_relations
    WHERE a_field_id = ANY(${linkIds}::uuid[]) OR b_field_id = ANY(${linkIds}::uuid[])
  `.execute(db);
  const peerTables = new Set<string>();
  for (const r of rels.rows) {
    peerTables.add(r.a_table_id);
    peerTables.add(r.b_table_id);
  }
  const prims = await sql<{ table_id: string; id: string; slot: number; type: string; config: Record<string, unknown>; is_computed: boolean }>`
    SELECT t.id AS table_id, f.id, f.slot, f.type, f.config, f.is_computed
    FROM data.tables t JOIN data.fields f ON f.id = t.primary_field_id AND f.deleted_at IS NULL
    WHERE t.id = ANY(${[...peerTables]}::uuid[])
  `.execute(db);
  const primByTable = new Map(prims.rows.map((p) => [p.table_id, toInfo(p)]));
  for (const info of infos) {
    const rel = rels.rows.find((r) => r.a_field_id === info.id || r.b_field_id === info.id);
    if (!rel) continue;
    const side = rel.a_field_id === info.id ? "a" : "b";
    const peerTableId = side === "a" ? rel.b_table_id : rel.a_table_id;
    info.link = { relationId: rel.id, side, peerTableId, peerPrimary: primByTable.get(peerTableId) ?? null };
  }
  return infos;
}

/** Map keyed by uuid and `fld_` id. */
export function fieldInfoMap(infos: SqlFieldInfo[]): Map<string, SqlFieldInfo> {
  const m = new Map<string, SqlFieldInfo>();
  for (const f of infos) {
    m.set(f.id, f);
    m.set(pid("fld", f.id), f);
  }
  return m;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All accepted spellings of an entity id (uuid ↔ usr_/rec_/att_ public id). */
export function idVariants(id: string): string[] {
  const out = new Set<string>([id]);
  if (UUID_RE.test(id)) {
    const u = id.toLowerCase();
    out.add(u);
    for (const p of ["usr", "rec", "att"] as const) {
      try {
        out.add(pid(p, u));
      } catch {
        /* not encodable */
      }
    }
  } else {
    const m = /^([a-z]{3})_/.exec(id);
    if (m) {
      try {
        out.add(decodePublicId(id).uuid);
      } catch {
        /* ignore malformed */
      }
    }
  }
  return [...out];
}

export interface UserQueryContext {
  userId: string;
  timeZone: string;
}

export async function loadUserQueryContext(db: TabulaDb, userId: string): Promise<UserQueryContext> {
  const r = await sql<{ time_zone: string }>`SELECT time_zone FROM core.users WHERE id = ${userId}`.execute(db);
  return { userId, timeZone: r.rows[0]?.time_zone || "UTC" };
}

export function buildPlanContext(
  infos: SqlFieldInfo[],
  user: UserQueryContext | null,
  timeZoneOverride?: string,
): PlanQueryContext {
  return {
    fields: fieldInfoMap(infos),
    idVariants,
    currentUserId: user?.userId ?? null,
    timeZone: timeZoneOverride ?? user?.timeZone ?? "UTC",
  };
}
