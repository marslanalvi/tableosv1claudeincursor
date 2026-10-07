/**
 * Field dependency rows (`data.field_dependencies`) for computed fields.
 * Edge semantics: `dependent` must be recomputed when `depends_on` changes;
 * `via_link_field_id` (a link field in the dependent's table) says the change
 * happens on *linked* records.
 */
import { findCycle } from "@tabula/compute";
import { parseFormula, formulaFieldRefs } from "@tabula/formula";
import type { Database } from "@tabula/db";
import { sql, type Kysely } from "kysely";
import { ApiError } from "../../http/errors.js";
import type { Db } from "../schema/table-schema.js";

export interface DepEdge {
  dependsOn: string;
  via: string | null;
}

export interface DepFieldInfo {
  id: string;
  tableId: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Field ids referenced by a stored formula expression. */
export function formulaRefIds(expression: string): string[] {
  if (!expression || !expression.trim()) return [];
  try {
    return formulaFieldRefs(parseFormula(expression)).filter((r) => UUID_RE.test(r)).map((r) => r.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Compute dependency edges of `field`. `fieldsById` must contain every live
 * field of the base; `primaryByTable` maps table → primary field id.
 */
export function edgesForField(
  field: DepFieldInfo,
  fieldsById: ReadonlyMap<string, DepFieldInfo>,
  primaryByTable: ReadonlyMap<string, string | null>,
): DepEdge[] {
  const out: DepEdge[] = [];
  const add = (dependsOn: string | undefined | null, via: string | null) => {
    if (!dependsOn || dependsOn === field.id) return;
    if (!fieldsById.has(dependsOn)) return;
    if (out.some((e) => e.dependsOn === dependsOn && e.via === via)) return;
    out.push({ dependsOn, via });
  };
  const c = field.config;
  switch (field.type) {
    case "formula": {
      const expr = typeof c["expression"] === "string" ? c["expression"] : "";
      for (const ref of formulaRefIds(expr)) {
        const f = fieldsById.get(ref);
        if (!f) continue;
        add(ref, null);
        if (f.type === "link" || f.type === "contact") {
          // Link values render as the linked records' primary values.
          const peerTable = String(f.config["linkedTableId"] ?? "");
          add(primaryByTable.get(peerTable) ?? null, ref);
        }
      }
      break;
    }
    case "lookup":
    case "rollup": {
      const link = String(c["linkFieldId"] ?? "");
      const target = String(c["targetFieldId"] ?? c["lookupFieldId"] ?? c["rollupFieldId"] ?? "");
      add(link, null);
      add(target, link);
      break;
    }
    case "count":
      add(String(c["linkFieldId"] ?? ""), null);
      break;
    default:
      break;
  }
  return out;
}

export async function loadAllEdges(
  db: Db,
  baseId: string,
): Promise<Array<{ dependentFieldId: string; dependsOnFieldId: string; viaLinkFieldId: string | null }>> {
  const r = await sql<{ dependent_field_id: string; depends_on_field_id: string; via_link_field_id: string | null }>`
    SELECT dependent_field_id, depends_on_field_id, via_link_field_id
    FROM data.field_dependencies WHERE base_id = ${baseId}
  `.execute(db as Kysely<Database>);
  return r.rows.map((x) => ({
    dependentFieldId: x.dependent_field_id,
    dependsOnFieldId: x.depends_on_field_id,
    viaLinkFieldId: x.via_link_field_id,
  }));
}

/** Throws 422 CYCLE_DETECTED when giving `fieldId` the `edges` would create a cycle. */
export async function assertNoCycle(
  db: Db,
  baseId: string,
  fieldId: string,
  edges: DepEdge[],
  nameOf: (id: string) => string,
): Promise<void> {
  const existing = (await loadAllEdges(db, baseId)).filter((e) => e.dependentFieldId !== fieldId);
  const all = [
    ...existing,
    ...edges.map((e) => ({ dependentFieldId: fieldId, dependsOnFieldId: e.dependsOn })),
  ];
  const ids = new Set<string>();
  for (const e of all) {
    ids.add(e.dependentFieldId);
    ids.add(e.dependsOnFieldId);
  }
  const cycle = findCycle([...ids], all);
  if (cycle) {
    const names = cycle.map((id) => `{${nameOf(id)}}`).join(" → ");
    throw new ApiError(422, "CYCLE_DETECTED", `Circular reference: ${names}`, {
      cycle: cycle,
    });
  }
}

export async function writeFieldDependencies(
  trx: Db,
  params: { baseId: string; workspaceId: string; fieldId: string; edges: DepEdge[] },
): Promise<void> {
  const db = trx as Kysely<Database>;
  await sql`DELETE FROM data.field_dependencies WHERE dependent_field_id = ${params.fieldId}`.execute(db);
  for (const e of params.edges) {
    await sql`
      INSERT INTO data.field_dependencies (
        dependent_field_id, depends_on_field_id, via_link_field_id, workspace_id, base_id
      ) VALUES (${params.fieldId}, ${e.dependsOn}, ${e.via}, ${params.workspaceId}, ${params.baseId})
      ON CONFLICT (dependent_field_id, depends_on_field_id) DO NOTHING
    `.execute(db);
  }
}

/** Load base fields/primaries and compute + validate edges for one field. */
export async function planFieldDependencies(
  db: Db,
  baseId: string,
  field: DepFieldInfo,
): Promise<DepEdge[]> {
  const fr = await sql<{ id: string; table_id: string; name: string; type: string; config: Record<string, unknown> }>`
    SELECT id, table_id, name, type, config FROM data.fields WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db as Kysely<Database>);
  const fieldsById = new Map<string, DepFieldInfo>(
    fr.rows.map((r) => [r.id, { id: r.id, tableId: r.table_id, name: r.name, type: r.type, config: r.config ?? {} }]),
  );
  fieldsById.set(field.id, field);
  const tr = await sql<{ id: string; primary_field_id: string | null }>`
    SELECT id, primary_field_id FROM data.tables WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db as Kysely<Database>);
  const primaryByTable = new Map(tr.rows.map((r) => [r.id, r.primary_field_id]));
  const edges = edgesForField(field, fieldsById, primaryByTable);
  await assertNoCycle(db, baseId, field.id, edges, (id) => fieldsById.get(id)?.name ?? id);
  return edges;
}

/**
 * Recompute dependency rows for every computed field in a base (used after
 * primary-field changes / field deletes). Cycles are not re-validated here.
 */
export async function rebuildBaseDependencies(trx: Db, baseId: string, workspaceId: string): Promise<void> {
  const db = trx as Kysely<Database>;
  const fr = await sql<{ id: string; table_id: string; name: string; type: string; config: Record<string, unknown> }>`
    SELECT id, table_id, name, type, config FROM data.fields WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db);
  const fieldsById = new Map<string, DepFieldInfo>(
    fr.rows.map((r) => [r.id, { id: r.id, tableId: r.table_id, name: r.name, type: r.type, config: r.config ?? {} }]),
  );
  const tr = await sql<{ id: string; primary_field_id: string | null }>`
    SELECT id, primary_field_id FROM data.tables WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db);
  const primaryByTable = new Map(tr.rows.map((r) => [r.id, r.primary_field_id]));
  await sql`DELETE FROM data.field_dependencies WHERE base_id = ${baseId}`.execute(db);
  for (const f of fieldsById.values()) {
    if (!["formula", "lookup", "rollup", "count"].includes(f.type)) continue;
    const edges = edgesForField(f, fieldsById, primaryByTable);
    await writeFieldDependencies(db, { baseId, workspaceId, fieldId: f.id, edges });
  }
}
