/** Table-level schema operations (delete / duplicate / reorder). */
import { generateUuidV7, keyBetween, keysBetween } from "@tabula/types";
import { rewriteFormulaRefs } from "@tabula/formula";
import { sql } from "kysely";
import { ApiError } from "../../http/errors.js";
import { backfillFieldsInTx, runComputeInTx } from "../compute/engine.js";
import { planFieldDependencies, writeFieldDependencies } from "../compute/deps.js";
import {
  COMPUTED_TYPES,
  dedupeName,
  deleteLinksToTableInTx,
  type SchemaOpContext,
} from "./field-ops.js";
import { loadTableFieldRows, loadTableRow } from "./table-schema.js";

const LINK_TYPES = new Set(["link", "contact"]);

export async function deleteTableInTx(ctx: SchemaOpContext, tableId: string): Promise<string[]> {
  const live = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM data.tables WHERE base_id = ${ctx.baseId} AND deleted_at IS NULL
  `.execute(ctx.trx);
  if (Number(live.rows[0]?.n ?? 0) <= 1) {
    throw new ApiError(409, "CONFLICT", "A base must have at least one table");
  }
  const table = await loadTableRow(ctx.trx, tableId);
  if (!table) throw new ApiError(404, "TABLE_NOT_FOUND", "Table not found");
  const touched = await deleteLinksToTableInTx(ctx, tableId);
  await sql`
    UPDATE data.tables SET deleted_at = now(), deleted_by = ${ctx.userId}, updated_at = now() WHERE id = ${tableId}
  `.execute(ctx.trx);
  await sql`
    DELETE FROM data.field_dependencies d USING data.fields f
    WHERE f.table_id = ${tableId} AND (d.dependent_field_id = f.id OR d.depends_on_field_id = f.id)
  `.execute(ctx.trx);
  await sql`DELETE FROM data.computed_stale WHERE table_id = ${tableId}`.execute(ctx.trx);
  // Records of a deleted table no longer count toward the plan limit.
  await sql`
    UPDATE data.base_runtime SET record_count = GREATEST(record_count - ${table.recordCount}, 0), updated_at = now()
    WHERE base_id = ${ctx.baseId}
  `.execute(ctx.trx);
  return touched;
}

export async function reorderTablesInTx(ctx: SchemaOpContext, tableIds: string[]): Promise<void> {
  const r = await sql<{ id: string }>`
    SELECT id FROM data.tables WHERE base_id = ${ctx.baseId} AND deleted_at IS NULL ORDER BY order_key ASC
  `.execute(ctx.trx);
  const known = r.rows.map((x) => x.id);
  for (const id of tableIds) {
    if (!known.includes(id)) throw new ApiError(422, "VALIDATION_FAILED", "tableIds contains a table not in this base");
  }
  if (new Set(tableIds).size !== tableIds.length) throw new ApiError(422, "VALIDATION_FAILED", "tableIds contains duplicates");
  const ordered = [...tableIds, ...known.filter((id) => !tableIds.includes(id))];
  const keys = keysBetween(null, null, ordered.length);
  const payload = ordered.map((id, i) => ({ id, k: keys[i]! }));
  await sql`
    UPDATE data.tables AS t SET order_key = v.k, updated_at = now()
    FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS v(id uuid, k text)
    WHERE t.id = v.id AND t.base_id = ${ctx.baseId}
  `.execute(ctx.trx);
}

/**
 * Duplicate a table: fields (same slots), optionally records + links, plus a
 * default grid view. Link fields to other tables get new relations (and inverse
 * fields in the linked tables); computed fields are remapped and backfilled.
 */
export async function duplicateTableInTx(
  ctx: SchemaOpContext,
  tableId: string,
  opts: { withRecords: boolean; name?: string },
): Promise<{ tableId: string; touchedTableIds: string[] }> {
  const trx = ctx.trx;
  const src = await loadTableRow(trx, tableId);
  if (!src) throw new ApiError(404, "TABLE_NOT_FOUND", "Table not found");
  const names = await sql<{ name: string }>`
    SELECT name FROM data.tables WHERE base_id = ${ctx.baseId} AND deleted_at IS NULL
  `.execute(trx);
  const name = opts.name?.trim()
    ? opts.name.trim()
    : dedupeName(names.rows.map((r) => r.name), `${src.name} copy`);
  if (names.rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(409, "CONFLICT", `A table named "${name}" already exists`);
  }
  const fields = await loadTableFieldRows(trx, tableId);
  const newTableId = generateUuidV7();
  const next = await sql<{ order_key: string }>`
    SELECT order_key FROM data.tables WHERE base_id = ${ctx.baseId} AND deleted_at IS NULL AND order_key > ${src.orderKey}
    ORDER BY order_key ASC LIMIT 1
  `.execute(trx);
  let orderKey: string;
  try {
    orderKey = keyBetween(src.orderKey, next.rows[0]?.order_key ?? null);
  } catch {
    orderKey = keyBetween(src.orderKey, null);
  }
  const slotRow = await sql<{ next_field_slot: number; next_row_number: string }>`
    SELECT next_field_slot, next_row_number FROM data.tables WHERE id = ${tableId}
  `.execute(trx);
  await sql`
    INSERT INTO data.tables (id, workspace_id, base_id, name, description, order_key, next_field_slot, created_by)
    VALUES (${newTableId}, ${ctx.workspaceId}, ${ctx.baseId}, ${name}, ${src.description}, ${orderKey},
            ${slotRow.rows[0]?.next_field_slot ?? 1}, ${ctx.userId})
  `.execute(trx);

  const idMap = new Map<string, string>();
  for (const f of fields) idMap.set(f.id, generateUuidV7());
  const remap = (id: unknown): unknown => (typeof id === "string" && idMap.has(id) ? idMap.get(id) : id);
  const touched = new Set<string>();

  // Insert all fields with remapped configs (same slots / order keys).
  const relSrc = await sql<{ id: string; a_field_id: string; b_field_id: string | null; a_table_id: string; b_table_id: string }>`
    SELECT id, a_field_id, b_field_id, a_table_id, b_table_id FROM data.link_relations
    WHERE a_table_id = ${tableId} OR b_table_id = ${tableId}
  `.execute(trx);
  for (const f of fields) {
    const newId = idMap.get(f.id)!;
    let config: Record<string, unknown> = { ...f.config };
    if (LINK_TYPES.has(f.type)) {
      const linked = String(config["linkedTableId"]);
      config = { ...config, linkedTableId: linked === tableId ? newTableId : linked, inverseFieldId: null };
    } else if (f.type === "lookup" || f.type === "rollup" || f.type === "count") {
      config = { ...config, linkFieldId: remap(config["linkFieldId"]) };
      if (config["targetFieldId"]) config["targetFieldId"] = remap(config["targetFieldId"]);
    } else if (f.type === "formula" && typeof config["expression"] === "string") {
      try {
        config["expression"] = rewriteFormulaRefs(config["expression"], (ref) =>
          idMap.has(ref.toLowerCase()) ? idMap.get(ref.toLowerCase())! : null,
        );
      } catch {
        /* keep */
      }
    }
    await sql`
      INSERT INTO data.fields (id, workspace_id, base_id, table_id, slot, name, description, type, config,
                               order_key, is_computed, created_by)
      VALUES (${newId}, ${ctx.workspaceId}, ${ctx.baseId}, ${newTableId}, ${f.slot}, ${f.name}, ${f.description},
              ${f.type}, ${JSON.stringify(config)}::jsonb, ${f.orderKey}, ${COMPUTED_TYPES.has(f.type)}, ${ctx.userId})
    `.execute(trx);
  }
  if (src.primaryFieldId && idMap.has(src.primaryFieldId)) {
    await sql`UPDATE data.tables SET primary_field_id = ${idMap.get(src.primaryFieldId)!} WHERE id = ${newTableId}`.execute(trx);
  }

  // Relations for link fields.
  const relMap = new Map<string, { newRelId: string; side: "a" | "b"; oldRelId: string }>();
  for (const f of fields) {
    if (!LINK_TYPES.has(f.type)) continue;
    const newId = idMap.get(f.id)!;
    const rel = relSrc.rows.find((r) => r.a_field_id === f.id || r.b_field_id === f.id);
    const linked = String(f.config["linkedTableId"]);
    const allow = f.config["allowMultiple"] !== false;
    const newRelId = generateUuidV7();
    if (linked === tableId) {
      // Self link: only side a of a self relation is duplicated.
      if (rel && rel.a_field_id !== f.id) continue;
      const inv = rel?.b_field_id ? idMap.get(rel.b_field_id) ?? null : null;
      await sql`
        INSERT INTO data.link_relations (id, workspace_id, base_id, a_table_id, a_field_id, b_table_id, b_field_id,
                                         allow_multiple_a, allow_multiple_b)
        VALUES (${newRelId}, ${ctx.workspaceId}, ${ctx.baseId}, ${newTableId}, ${newId}, ${newTableId}, ${inv}, ${allow}, true)
      `.execute(trx);
      if (inv) {
        await sql`UPDATE data.fields SET config = config || ${JSON.stringify({ inverseFieldId: newId })}::jsonb WHERE id = ${inv}`.execute(trx);
        await sql`UPDATE data.fields SET config = config || ${JSON.stringify({ inverseFieldId: inv })}::jsonb WHERE id = ${newId}`.execute(trx);
      }
      if (rel) relMap.set(f.id, { newRelId, side: "a", oldRelId: rel.id });
      continue;
    }
    // Link to another table: new inverse field there.
    const peerFields = await loadTableFieldRows(trx, linked);
    const invId = generateUuidV7();
    const slot = await sql<{ slot: number }>`
      UPDATE data.tables SET next_field_slot = next_field_slot + 1 WHERE id = ${linked}
      RETURNING (next_field_slot - 1) AS slot
    `.execute(trx);
    const lastKey = peerFields.length ? peerFields[peerFields.length - 1]!.orderKey : null;
    let invKey: string;
    try {
      invKey = keyBetween(lastKey, null);
    } catch {
      invKey = keyBetween(null, null);
    }
    await sql`
      INSERT INTO data.fields (id, workspace_id, base_id, table_id, slot, name, type, config, order_key, created_by)
      VALUES (${invId}, ${ctx.workspaceId}, ${ctx.baseId}, ${linked}, ${slot.rows[0]!.slot},
              ${dedupeName(peerFields.map((p) => p.name), name)}, 'link',
              ${JSON.stringify({ linkedTableId: newTableId, inverseFieldId: newId, allowMultiple: true })}::jsonb,
              ${invKey}, ${ctx.userId})
    `.execute(trx);
    await sql`UPDATE data.fields SET config = config || ${JSON.stringify({ inverseFieldId: invId })}::jsonb WHERE id = ${newId}`.execute(trx);
    await sql`
      INSERT INTO data.link_relations (id, workspace_id, base_id, a_table_id, a_field_id, b_table_id, b_field_id,
                                       allow_multiple_a, allow_multiple_b)
      VALUES (${newRelId}, ${ctx.workspaceId}, ${ctx.baseId}, ${newTableId}, ${newId}, ${linked}, ${invId}, ${allow}, true)
    `.execute(trx);
    touched.add(linked);
    if (rel) relMap.set(f.id, { newRelId, side: rel.a_field_id === f.id ? "a" : "b", oldRelId: rel.id });
  }

  // Default grid view.
  const lastView = await sql<{ order_key: string }>`
    SELECT order_key FROM data.views WHERE base_id = ${ctx.baseId} ORDER BY order_key DESC LIMIT 1
  `.execute(trx);
  let viewKey: string;
  try {
    viewKey = keyBetween(lastView.rows[0]?.order_key ?? null, null);
  } catch {
    viewKey = keyBetween(null, null);
  }
  await sql`
    INSERT INTO data.views (id, workspace_id, base_id, table_id, type, name, order_key, is_default, created_by, config)
    VALUES (${generateUuidV7()}, ${ctx.workspaceId}, ${ctx.baseId}, ${newTableId}, 'grid', 'Grid view', ${viewKey}, true,
            ${ctx.userId}, '{}'::jsonb)
  `.execute(trx);

  // Records.
  if (opts.withRecords) {
    const linkSlots = fields.filter((f) => LINK_TYPES.has(f.type)).map((f) => String(f.slot));
    const recMap = await sql<{ old_id: string; new_id: string }>`
      WITH src AS (
        SELECT id, row_number, manual_order, cells, created_by
        FROM data.records WHERE table_id = ${tableId} AND deleted_at IS NULL
      ), ins AS (
        INSERT INTO data.records (table_id, id, workspace_id, base_id, row_number, manual_order, cells,
                                  created_by, updated_by, created_via, last_change_seq)
        SELECT ${newTableId}, public.uuidv7(), ${ctx.workspaceId}, ${ctx.baseId}, row_number, manual_order,
               cells - ${linkSlots}::text[], created_by, ${ctx.userId}, 'api', 0
        FROM src
        RETURNING id, row_number
      )
      SELECT s.id AS old_id, i.id AS new_id FROM src s JOIN ins i ON i.row_number = s.row_number
    `.execute(trx);
    const n = recMap.rows.length;
    await sql`
      UPDATE data.tables SET record_count = ${n}, next_row_number = ${Number(slotRow.rows[0]?.next_row_number ?? 1)}
      WHERE id = ${newTableId}
    `.execute(trx);
    await sql`
      UPDATE data.base_runtime SET record_count = record_count + ${n}, updated_at = now() WHERE base_id = ${ctx.baseId}
    `.execute(trx);
    const pairs = JSON.stringify(recMap.rows);
    for (const [, m] of relMap) {
      // Copy links: our side remapped, peer side kept (self links: both sides remapped).
      const own = m.side === "a" ? "a_record_id" : "b_record_id";
      const peer = m.side === "a" ? "b_record_id" : "a_record_id";
      const ownOrd = m.side === "a" ? "a_order" : "b_order";
      const peerOrd = m.side === "a" ? "b_order" : "a_order";
      await sql`
        INSERT INTO data.record_links (relation_id, a_record_id, b_record_id, a_order, b_order, workspace_id, base_id)
        SELECT ${m.newRelId}, x.new_id, COALESCE(y.new_id, l.${sql.ref(peer)}), l.${sql.ref(ownOrd)}, l.${sql.ref(peerOrd)},
               l.workspace_id, l.base_id
        FROM data.record_links l
        JOIN jsonb_to_recordset(${pairs}::jsonb) AS x(old_id uuid, new_id uuid) ON x.old_id = l.${sql.ref(own)}
        LEFT JOIN jsonb_to_recordset(${pairs}::jsonb) AS y(old_id uuid, new_id uuid)
          ON y.old_id = l.${sql.ref(peer)} AND ${sql.lit(m.side === "a")} AND EXISTS (
            SELECT 1 FROM data.link_relations r WHERE r.id = ${m.oldRelId} AND r.a_table_id = r.b_table_id)
        WHERE l.relation_id = ${m.oldRelId} AND l.deletion_batch_id IS NULL
        ON CONFLICT DO NOTHING
      `.execute(trx);
    }
  } else {
    await sql`UPDATE data.tables SET next_row_number = 1 WHERE id = ${newTableId}`.execute(trx);
  }

  // Dependencies + backfill for computed fields; refresh inverse fields' dependents.
  const newFields = await loadTableFieldRows(trx, newTableId);
  const computed = newFields.filter((f) => COMPUTED_TYPES.has(f.type) && f.type !== "ai_generated");
  for (const f of computed) {
    const edges = await planFieldDependencies(trx, ctx.baseId, {
      id: f.id,
      tableId: newTableId,
      name: f.name,
      type: f.type,
      config: f.config,
    });
    await writeFieldDependencies(trx, { baseId: ctx.baseId, workspaceId: ctx.workspaceId, fieldId: f.id, edges });
  }
  const scope = {
    baseId: ctx.baseId,
    workspaceId: ctx.workspaceId,
    redis: ctx.redis,
    ...(ctx.afterCommit ? { afterCommit: ctx.afterCommit } : {}),
  };
  if (opts.withRecords && computed.length) {
    await backfillFieldsInTx(trx, scope, newTableId, computed.map((f) => f.id));
  }
  if (opts.withRecords) {
    // Peers in other tables gained links through their new inverse fields.
    const inv = await sql<{ table_id: string; id: string; rel: string }>`
      SELECT f.table_id, f.id, r.id AS rel FROM data.link_relations r JOIN data.fields f ON f.id = r.b_field_id
      WHERE r.a_table_id = ${newTableId} AND r.b_table_id <> ${newTableId}
    `.execute(trx);
    for (const x of inv.rows) {
      const peers = await sql<{ id: string }>`
        SELECT DISTINCT b_record_id AS id FROM data.record_links WHERE relation_id = ${x.rel}
      `.execute(trx);
      if (peers.rows.length) {
        await runComputeInTx(trx, scope, {
          changes: [{ tableId: x.table_id, recordIds: peers.rows.map((p) => p.id), fieldIds: [x.id] }],
        });
      }
    }
  }
  return { tableId: newTableId, touchedTableIds: [...touched] };
}
