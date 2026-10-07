/**
 * Field schema operations (create / update / type change / delete / duplicate /
 * reorder / primary) — run inside a base transaction.
 */
import {
  convertCellValue,
  formatCellValue,
  getFieldType,
  isFieldTypeKey,
  newOptionId,
  optionColorAt,
  plainText,
  type FieldConfig,
} from "@tabula/fields";
import type { Database } from "@tabula/db";
import { generateUuidV7, keyBetween, keysBetween } from "@tabula/types";
import type { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import { ApiError } from "../../http/errors.js";
import { backfillFieldsInTx, runComputeInTx, unwrapStoredComputed, ERRORS_KEY, type ComputeScope } from "../compute/engine.js";
import { planFieldDependencies, writeFieldDependencies, rebuildBaseDependencies } from "../compute/deps.js";
import { configFromWire } from "./field-dto.js";
import { loadFieldRow, loadTableFieldRows, loadTableRow, type FieldRowFull } from "./table-schema.js";

type DbTrx = Transaction<Database>;

export const COMPUTED_TYPES = new Set(["formula", "lookup", "rollup", "count", "ai_generated"]);
const LINK_TYPES = new Set(["link", "contact"]);
const SYNC_CONVERT_LIMIT = 5000;
const CHUNK = 1000;

export interface SchemaOpContext {
  trx: DbTrx;
  baseId: string;
  workspaceId: string;
  userId: string;
  redis: Redis | null;
  afterCommit?: (fn: () => Promise<void> | void) => void;
}

function scope(ctx: SchemaOpContext): ComputeScope {
  return {
    baseId: ctx.baseId,
    workspaceId: ctx.workspaceId,
    redis: ctx.redis,
    ...(ctx.afterCommit ? { afterCommit: ctx.afterCommit } : {}),
  };
}

export function dedupeName(existing: Iterable<string>, base: string): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  const clean = base.trim().slice(0, 240) || "Field";
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; i < 10_000; i++) {
    const cand = `${clean} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return `${clean} ${generateUuidV7().slice(0, 6)}`;
}

async function assertNameFree(trx: DbTrx, tableId: string, name: string, exceptId?: string): Promise<void> {
  const r = await sql<{ id: string }>`
    SELECT id FROM data.fields
    WHERE table_id = ${tableId} AND deleted_at IS NULL AND lower(name) = lower(${name})
  `.execute(trx);
  if (r.rows.some((x) => x.id !== exceptId)) {
    throw new ApiError(409, "CONFLICT", `A field named "${name}" already exists in this table`);
  }
}

async function allocateSlot(trx: DbTrx, tableId: string): Promise<number> {
  const r = await sql<{ slot: number }>`
    UPDATE data.tables SET next_field_slot = next_field_slot + 1, updated_at = now()
    WHERE id = ${tableId}
    RETURNING (next_field_slot - 1) AS slot
  `.execute(trx);
  const slot = r.rows[0]?.slot;
  if (!slot) throw new ApiError(404, "TABLE_NOT_FOUND", "Table not found");
  return Number(slot);
}

async function appendFieldOrderKey(trx: DbTrx, tableId: string): Promise<string> {
  const r = await sql<{ order_key: string }>`
    SELECT order_key FROM data.fields WHERE table_id = ${tableId} AND deleted_at IS NULL
    ORDER BY order_key DESC LIMIT 1
  `.execute(trx);
  try {
    return keyBetween(r.rows[0]?.order_key ?? null, null);
  } catch {
    return keyBetween(null, null);
  }
}

async function insertFieldRow(
  ctx: SchemaOpContext,
  p: {
    id: string;
    tableId: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    description?: string;
    orderKey?: string;
  },
): Promise<number> {
  const slot = await allocateSlot(ctx.trx, p.tableId);
  const orderKey = p.orderKey ?? (await appendFieldOrderKey(ctx.trx, p.tableId));
  await sql`
    INSERT INTO data.fields (
      id, workspace_id, base_id, table_id, slot, name, description, type, config, order_key,
      is_computed, created_by, updated_by
    ) VALUES (
      ${p.id}, ${ctx.workspaceId}, ${ctx.baseId}, ${p.tableId}, ${slot}, ${p.name}, ${p.description ?? ""},
      ${p.type}, ${JSON.stringify(p.config)}::jsonb, ${orderKey}, ${COMPUTED_TYPES.has(p.type)},
      ${ctx.userId}, ${ctx.userId}
    )
  `.execute(ctx.trx);
  return slot;
}

/** Create the relation + inverse field for a new link field `fieldId`. */
async function createLinkRelation(
  ctx: SchemaOpContext,
  p: { fieldId: string; tableId: string; config: Record<string, unknown>; inverseName?: string },
): Promise<{ inverseFieldId: string | null; config: Record<string, unknown> }> {
  const linkedTableId = String(p.config["linkedTableId"]);
  const allowMultiple = p.config["allowMultiple"] !== false;
  const self = linkedTableId === p.tableId;
  let inverseFieldId: string | null = null;
  if (!self) {
    const srcTable = await loadTableRow(ctx.trx, p.tableId);
    const peerFields = await loadTableFieldRows(ctx.trx, linkedTableId);
    inverseFieldId = generateUuidV7();
    const invName = dedupeName(
      peerFields.map((f) => f.name),
      p.inverseName ?? srcTable?.name ?? "Linked records",
    );
    await insertFieldRow(ctx, {
      id: inverseFieldId,
      tableId: linkedTableId,
      name: invName,
      type: "link",
      config: { linkedTableId: p.tableId, inverseFieldId: p.fieldId, allowMultiple: true },
    });
  }
  await sql`
    INSERT INTO data.link_relations (
      id, workspace_id, base_id, a_table_id, a_field_id, b_table_id, b_field_id,
      allow_multiple_a, allow_multiple_b
    ) VALUES (
      ${generateUuidV7()}, ${ctx.workspaceId}, ${ctx.baseId}, ${p.tableId}, ${p.fieldId},
      ${linkedTableId}, ${inverseFieldId}, ${allowMultiple}, true
    )
  `.execute(ctx.trx);
  return { inverseFieldId, config: { ...p.config, inverseFieldId, allowMultiple } };
}

/** Remove a link field's relation (and soft-delete its inverse field). */
async function dropLinkRelation(ctx: SchemaOpContext, field: FieldRowFull): Promise<string | null> {
  const rel = await sql<{ id: string; a_field_id: string; b_field_id: string | null }>`
    SELECT id, a_field_id, b_field_id FROM data.link_relations
    WHERE a_field_id = ${field.id} OR b_field_id = ${field.id}
  `.execute(ctx.trx);
  let otherId: string | null = null;
  for (const r of rel.rows) {
    otherId = r.a_field_id === field.id ? r.b_field_id : r.a_field_id;
    await sql`DELETE FROM data.link_relations WHERE id = ${r.id}`.execute(ctx.trx);
  }
  if (otherId) {
    await sql`
      UPDATE data.fields SET deleted_at = now(), deleted_by = ${ctx.userId}, updated_at = now()
      WHERE id = ${otherId} AND deleted_at IS NULL
    `.execute(ctx.trx);
    await sql`
      DELETE FROM data.field_dependencies WHERE dependent_field_id = ${otherId} OR depends_on_field_id = ${otherId}
         OR via_link_field_id = ${otherId}
    `.execute(ctx.trx);
  }
  return otherId;
}

/** Computed fields (any table) that depend on any of `fieldIds`. */
async function dependentsOf(trx: DbTrx, fieldIds: string[]): Promise<Array<{ id: string; table_id: string }>> {
  if (fieldIds.length === 0) return [];
  const r = await sql<{ id: string; table_id: string }>`
    SELECT DISTINCT f.id, f.table_id FROM data.field_dependencies d
    JOIN data.fields f ON f.id = d.dependent_field_id AND f.deleted_at IS NULL
    WHERE d.depends_on_field_id = ANY(${fieldIds}::uuid[]) OR d.via_link_field_id = ANY(${fieldIds}::uuid[])
  `.execute(trx);
  return r.rows;
}

async function backfillGrouped(ctx: SchemaOpContext, fields: Array<{ id: string; table_id: string }>): Promise<void> {
  const byTable = new Map<string, string[]>();
  for (const f of fields) {
    const list = byTable.get(f.table_id) ?? [];
    if (!list.includes(f.id)) list.push(f.id);
    byTable.set(f.table_id, list);
  }
  for (const [tableId, ids] of byTable) await backfillFieldsInTx(ctx.trx, scope(ctx), tableId, ids);
}

async function allRecordIds(trx: DbTrx, tableId: string): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT id FROM data.records WHERE table_id = ${tableId} AND deleted_at IS NULL
  `.execute(trx);
  return r.rows.map((x) => x.id);
}

/** Recompute everything downstream of `fieldId` for all records of its table. */
async function propagateFromField(ctx: SchemaOpContext, tableId: string, fieldId: string): Promise<void> {
  const ids = await allRecordIds(ctx.trx, tableId);
  if (ids.length === 0) return;
  await runComputeInTx(ctx.trx, scope(ctx), {
    changes: [{ tableId, recordIds: ids, fieldIds: [fieldId] }],
    syncLimit: SYNC_CONVERT_LIMIT,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateFieldInput {
  name: string;
  type: string;
  config?: Record<string, unknown>;
  description?: string | null;
  /** for link fields: name of the inverse field */
  inverseName?: string;
  id?: string;
  orderKey?: string;
}

export async function createFieldInTx(
  ctx: SchemaOpContext,
  tableId: string,
  input: CreateFieldInput,
): Promise<{ fieldId: string; inverseFieldId: string | null; linkedTableId: string | null }> {
  const name = input.name.trim();
  if (!name) throw new ApiError(422, "VALIDATION_FAILED", "Field name is required");
  await assertNameFree(ctx.trx, tableId, name);
  const fieldId = input.id ?? generateUuidV7();
  const tableFields = await loadTableFieldRows(ctx.trx, tableId);
  let config = (await configFromWire(input.type, input.config, {
    db: ctx.trx,
    baseId: ctx.baseId,
    tableId,
    tableFields,
    fieldId,
  })) as Record<string, unknown>;

  await insertFieldRow(ctx, {
    id: fieldId,
    tableId,
    name,
    type: input.type,
    config,
    ...(input.description ? { description: input.description } : {}),
    ...(input.orderKey ? { orderKey: input.orderKey } : {}),
  });

  let inverseFieldId: string | null = null;
  let linkedTableId: string | null = null;
  if (LINK_TYPES.has(input.type)) {
    const res = await createLinkRelation(ctx, {
      fieldId,
      tableId,
      config,
      ...(input.inverseName ? { inverseName: input.inverseName } : {}),
    });
    inverseFieldId = res.inverseFieldId;
    linkedTableId = String(config["linkedTableId"]);
    config = res.config;
    await sql`UPDATE data.fields SET config = ${JSON.stringify(config)}::jsonb WHERE id = ${fieldId}`.execute(ctx.trx);
  }

  if (COMPUTED_TYPES.has(input.type)) {
    const edges = await planFieldDependencies(ctx.trx, ctx.baseId, {
      id: fieldId,
      tableId,
      name,
      type: input.type,
      config,
    });
    await writeFieldDependencies(ctx.trx, { baseId: ctx.baseId, workspaceId: ctx.workspaceId, fieldId, edges });
    await backfillFieldsInTx(ctx.trx, scope(ctx), tableId, [fieldId], SYNC_CONVERT_LIMIT);
  }
  return { fieldId, inverseFieldId, linkedTableId };
}

// ---------------------------------------------------------------------------
// Update (name / description / config / type)
// ---------------------------------------------------------------------------

export interface UpdateFieldInput {
  name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
  type?: string;
}

export interface UpdateFieldResult {
  field: FieldRowFull;
  tableIds: string[];
  converted: number;
}

function optionsOf(config: Record<string, unknown>): Array<{ id: string; label: string; color?: string }> {
  return Array.isArray(config["options"]) ? (config["options"] as Array<{ id: string; label: string; color?: string }>) : [];
}

export async function updateFieldInTx(
  ctx: SchemaOpContext,
  tableId: string,
  fieldId: string,
  input: UpdateFieldInput,
): Promise<UpdateFieldResult> {
  const field = await loadFieldRow(ctx.trx, tableId, fieldId);
  if (!field) throw new ApiError(404, "FIELD_NOT_FOUND", "Field not found");
  const tableIds = new Set([tableId]);
  let converted = 0;

  if (input.name !== undefined && input.name.trim() !== field.name) {
    const name = input.name.trim();
    if (!name) throw new ApiError(422, "VALIDATION_FAILED", "Field name is required");
    await assertNameFree(ctx.trx, tableId, name, fieldId);
    await sql`
      UPDATE data.fields SET name = ${name}, updated_by = ${ctx.userId}, updated_at = now() WHERE id = ${fieldId}
    `.execute(ctx.trx);
    field.name = name;
  }
  if (input.description !== undefined) {
    await sql`
      UPDATE data.fields SET description = ${input.description ?? ""}, updated_at = now() WHERE id = ${fieldId}
    `.execute(ctx.trx);
    field.description = input.description ?? "";
  }

  const newType = input.type ?? field.type;
  const typeChanged = newType !== field.type;
  if (!typeChanged && input.config === undefined) {
    return { field, tableIds: [...tableIds], converted };
  }
  if (!isFieldTypeKey(newType)) throw new ApiError(422, "VALIDATION_FAILED", `Unknown field type "${newType}"`);
  if (typeChanged) await assertNotLastRecordIdField(ctx.trx, tableId, field);

  const tableFields = await loadTableFieldRows(ctx.trx, tableId);
  // Merge partial config onto the existing one when the type is unchanged.
  const baseConfig = typeChanged ? {} : field.config;
  let mergedInput: Record<string, unknown> = { ...(input.config ?? {}) };
  if (!typeChanged) {
    mergedInput = { ...wireFromStoredForMerge(field), ...mergedInput };
  }
  if (typeChanged && LINK_TYPES.has(field.type) && LINK_TYPES.has(newType)) {
    mergedInput = { linkedTableId: field.config["linkedTableId"], ...mergedInput };
  }
  let newConfig = (await configFromWire(newType, mergedInput, {
    db: ctx.trx,
    baseId: ctx.baseId,
    tableId,
    tableFields: tableFields.filter((f) => f.id !== fieldId),
    fieldId,
    ...(typeChanged ? {} : { existing: baseConfig }),
  })) as Record<string, unknown>;

  // Link target change on an existing link field = drop & recreate relation.
  const linkRetarget =
    !typeChanged && LINK_TYPES.has(field.type) && newConfig["linkedTableId"] !== field.config["linkedTableId"];

  if (typeChanged || linkRetarget) {
    const res = await convertFieldType(ctx, field, newType, newConfig);
    newConfig = res.config;
    converted = res.converted;
    for (const t of res.tableIds) tableIds.add(t);
  } else if (LINK_TYPES.has(field.type)) {
    // allowMultiple toggle: mirror onto the relation for this side.
    const allow = newConfig["allowMultiple"] !== false;
    await sql`UPDATE data.link_relations SET allow_multiple_a = ${allow} WHERE a_field_id = ${fieldId}`.execute(ctx.trx);
    await sql`UPDATE data.link_relations SET allow_multiple_b = ${allow} WHERE b_field_id = ${fieldId}`.execute(ctx.trx);
  } else if (field.type === "single_select" || field.type === "multi_select") {
    // Deleted options are cleared from cells (architecture/28 E025).
    const kept = new Set(optionsOf(newConfig).map((o) => o.id));
    const removed = optionsOf(field.config).map((o) => o.id).filter((id) => !kept.has(id));
    if (removed.length) {
      const slot = String(field.slot);
      if (field.type === "single_select") {
        await sql`
          UPDATE data.records SET cells = cells - ${slot}, version = version + 1, updated_at = now()
          WHERE table_id = ${tableId} AND cells ->> ${slot} = ANY(${removed}::text[])
        `.execute(ctx.trx);
      } else {
        await sql`
          UPDATE data.records r
          SET cells = CASE WHEN v.kept = '[]'::jsonb THEN r.cells - ${slot}
                           ELSE jsonb_set(r.cells, ARRAY[${slot}], v.kept) END,
              version = r.version + 1, updated_at = now()
          FROM (
            SELECT id, COALESCE(
              (SELECT jsonb_agg(e) FROM jsonb_array_elements(cells -> ${slot}) e
               WHERE NOT (e #>> '{}') = ANY(${removed}::text[])), '[]'::jsonb) AS kept
            FROM data.records
            WHERE table_id = ${tableId} AND jsonb_typeof(cells -> ${slot}) = 'array'
              AND (cells -> ${slot}) ?| ${removed}::text[]
          ) v
          WHERE r.table_id = ${tableId} AND r.id = v.id
        `.execute(ctx.trx);
      }
    }
  }

  await sql`
    UPDATE data.fields
    SET type = ${newType}, config = ${JSON.stringify(newConfig)}::jsonb,
        is_computed = ${COMPUTED_TYPES.has(newType)}, updated_by = ${ctx.userId}, updated_at = now()
    WHERE id = ${fieldId}
  `.execute(ctx.trx);
  field.type = newType;
  field.config = newConfig;
  field.isComputed = COMPUTED_TYPES.has(newType);

  if (COMPUTED_TYPES.has(newType)) {
    const edges = await planFieldDependencies(ctx.trx, ctx.baseId, {
      id: fieldId,
      tableId,
      name: field.name,
      type: newType,
      config: newConfig,
    });
    await writeFieldDependencies(ctx.trx, { baseId: ctx.baseId, workspaceId: ctx.workspaceId, fieldId, edges });
    await backfillFieldsInTx(ctx.trx, scope(ctx), tableId, [fieldId], SYNC_CONVERT_LIMIT);
  } else {
    await sql`DELETE FROM data.field_dependencies WHERE dependent_field_id = ${fieldId}`.execute(ctx.trx);
  }
  // Dependents (formulas/lookups/rollups elsewhere) see new values or type.
  if (typeChanged || linkRetarget) {
    await rebuildBaseDependencies(ctx.trx, ctx.baseId, ctx.workspaceId);
  }
  const deps = await dependentsOf(ctx.trx, [fieldId]);
  if (deps.length && !COMPUTED_TYPES.has(newType)) await propagateFromField(ctx, tableId, fieldId);
  else if (deps.length) await backfillGrouped(ctx, deps);
  for (const d of deps) tableIds.add(d.table_id);
  return { field, tableIds: [...tableIds], converted };
}

/** Stored config → a wire-ish input for partial merges (keeps ids, raw uuids are accepted). */
function wireFromStoredForMerge(field: FieldRowFull): Record<string, unknown> {
  const c = { ...field.config };
  if (field.type === "formula") {
    // Stored `{uuid}` refs are accepted by configFromWire as-is.
    return c;
  }
  return c;
}

/**
 * Convert existing values of `field` to `newType` (+ relation/computed cleanup).
 * Returns the (possibly extended) target config.
 */
async function convertFieldType(
  ctx: SchemaOpContext,
  field: FieldRowFull,
  newType: string,
  targetConfig: Record<string, unknown>,
): Promise<{ config: Record<string, unknown>; converted: number; tableIds: string[] }> {
  const trx = ctx.trx;
  const slot = String(field.slot);
  const fromLink = LINK_TYPES.has(field.type);
  const toLink = LINK_TYPES.has(newType);
  const fromComputed = COMPUTED_TYPES.has(field.type);
  const toComputed = COMPUTED_TYPES.has(newType);
  const tableIds: string[] = [];
  let config = { ...targetConfig };
  let converted = 0;

  // Snapshot source values as text/stored values before tearing anything down.
  const recs = await sql<{ id: string; cells: Record<string, unknown>; computed: Record<string, unknown> }>`
    SELECT id, cells, computed FROM data.records WHERE table_id = ${field.tableId} AND deleted_at IS NULL
  `.execute(trx);
  const sourceValues = new Map<string, unknown>();
  if (fromLink) {
    const rel = await sql<{ id: string; a_field_id: string; b_table_id: string; a_table_id: string }>`
      SELECT id, a_field_id, a_table_id, b_table_id FROM data.link_relations
      WHERE a_field_id = ${field.id} OR b_field_id = ${field.id} LIMIT 1
    `.execute(trx);
    const r = rel.rows[0];
    if (r) {
      const sideA = r.a_field_id === field.id;
      const peerTable = sideA ? r.b_table_id : r.a_table_id;
      const peerTableRow = await loadTableRow(trx, peerTable);
      const prim = peerTableRow?.primaryFieldId ? await loadFieldRow(trx, peerTable, peerTableRow.primaryFieldId) : null;
      const links = await sql<{ src: string; dst: string; cells: Record<string, unknown>; computed: Record<string, unknown> }>`
        SELECT ${sql.ref(sideA ? "l.a_record_id" : "l.b_record_id")} AS src,
               ${sql.ref(sideA ? "l.b_record_id" : "l.a_record_id")} AS dst, p.cells, p.computed
        FROM data.record_links l
        JOIN data.records p ON p.table_id = ${peerTable} AND p.id = ${sql.ref(sideA ? "l.b_record_id" : "l.a_record_id")}
          AND p.deleted_at IS NULL
        WHERE l.relation_id = ${r.id} AND l.deletion_batch_id IS NULL
        ORDER BY ${sql.ref(sideA ? "l.a_order" : "l.b_order")}
      `.execute(trx);
      for (const l of links.rows) {
        let name = "";
        if (prim) {
          name = prim.isComputed
            ? plainText(unwrapStoredComputed(l.computed?.[String(prim.slot)]))
            : formatCellValue(prim.type, l.cells?.[String(prim.slot)], prim.config);
        }
        const list = (sourceValues.get(l.src) as string[] | undefined) ?? [];
        if (name) list.push(name);
        sourceValues.set(l.src, list);
      }
    }
  } else {
    for (const r of recs.rows) {
      const v = fromComputed ? unwrapStoredComputed(r.computed?.[slot]) : r.cells?.[slot];
      if (v !== undefined && v !== null) sourceValues.set(r.id, v);
    }
  }

  // Tear down old shape.
  if (fromLink) {
    const other = await dropLinkRelation(ctx, field);
    if (other) {
      const o = await sql<{ table_id: string }>`SELECT table_id FROM data.fields WHERE id = ${other}`.execute(trx);
      if (o.rows[0]) tableIds.push(o.rows[0].table_id);
    }
  }
  if (fromComputed) {
    await sql`DELETE FROM data.field_dependencies WHERE dependent_field_id = ${field.id}`.execute(trx);
  }

  // New shape.
  if (toLink) {
    const res = await createLinkRelation(ctx, { fieldId: field.id, tableId: field.tableId, config });
    config = res.config;
    tableIds.push(String(config["linkedTableId"]));
  }

  const fromType = fromLink ? "multi_select_text" : field.type;
  const fromCfg = field.config as FieldConfig;
  const createdOptions: Array<{ id: string; label: string; color: string }> = [];
  const toCfg: FieldConfig = { ...(config as FieldConfig) };
  const createOption = (label: string): string => {
    const opts = optionsOf(toCfg as Record<string, unknown>);
    const hit = opts.find((o) => o.label.toLowerCase() === label.toLowerCase());
    if (hit) return hit.id;
    const opt = { id: newOptionId(), label, color: optionColorAt(opts.length) };
    toCfg.options = [...opts, opt];
    createdOptions.push(opt);
    return opt.id;
  };

  // Link targets by primary text (text → link conversion).
  let primaryIndex: Map<string, string> | null = null;
  if (toLink) {
    const peerTable = String(config["linkedTableId"]);
    const pt = await loadTableRow(trx, peerTable);
    const prim = pt?.primaryFieldId ? await loadFieldRow(trx, peerTable, pt.primaryFieldId) : null;
    primaryIndex = new Map();
    if (prim && !prim.isComputed) {
      const pr = await sql<{ id: string; cells: Record<string, unknown> }>`
        SELECT id, cells FROM data.records WHERE table_id = ${peerTable} AND deleted_at IS NULL ORDER BY manual_order
      `.execute(trx);
      for (const p of pr.rows) {
        const t = formatCellValue(prim.type, p.cells?.[String(prim.slot)], prim.config).trim().toLowerCase();
        if (t && !primaryIndex.has(t)) primaryIndex.set(t, p.id);
      }
    }
  }

  const updates: Array<{ id: string; cells: Record<string, unknown>; computed: Record<string, unknown> }> = [];
  const linkWrites: Array<{ id: string; targets: string[] }> = [];
  for (const r of recs.rows) {
    const cells = { ...(r.cells ?? {}) };
    const computed = { ...(r.computed ?? {}) };
    const had = slot in cells || slot in computed;
    delete cells[slot];
    if (fromComputed) {
      delete computed[slot];
      const errs = computed[ERRORS_KEY] as Record<string, unknown> | undefined;
      if (errs && slot in errs) {
        const e = { ...errs };
        delete e[slot];
        if (Object.keys(e).length) computed[ERRORS_KEY] = e;
        else delete computed[ERRORS_KEY];
      }
    }
    const src = sourceValues.get(r.id);
    if (!toComputed && src !== undefined) {
      if (toLink) {
        const texts = Array.isArray(src) ? src.map((x) => plainText(x)) : plainText(src).split(",");
        const targets = texts
          .map((t) => primaryIndex?.get(t.trim().toLowerCase()))
          .filter((x): x is string => !!x);
        const allow = config["allowMultiple"] !== false;
        if (targets.length) linkWrites.push({ id: r.id, targets: allow ? [...new Set(targets)] : targets.slice(0, 1) });
      } else {
        const from =
          fromType === "multi_select_text"
            ? { type: "text", config: {} }
            : fromComputed
              ? { type: "formula", config: {} }
              : { type: field.type, config: fromCfg };
        const value = fromType === "multi_select_text" && Array.isArray(src) ? (src as string[]).join(", ") : src;
        const res = convertCellValue(
          value,
          from,
          { type: newType, config: toCfg },
          { createOption },
        );
        if (res.value !== undefined) {
          cells[slot] = res.value;
          converted++;
        }
      }
    }
    if (had || slot in cells) updates.push({ id: r.id, cells, computed });
  }
  for (let i = 0; i < updates.length; i += CHUNK) {
    await sql`
      UPDATE data.records AS r SET cells = v.cells, computed = v.computed
      FROM jsonb_to_recordset(${JSON.stringify(updates.slice(i, i + CHUNK))}::jsonb)
        AS v(id uuid, cells jsonb, computed jsonb)
      WHERE r.table_id = ${field.tableId} AND r.id = v.id
    `.execute(trx);
  }
  if (createdOptions.length) config = { ...config, options: toCfg.options };

  if (linkWrites.length) {
    const { writeRecordLinksInTx } = await import("../links/record-links.js");
    // Field row must have the link type before writing links (relation lookup uses link_relations only).
    for (const w of linkWrites) {
      await writeRecordLinksInTx(trx, {
        workspaceId: ctx.workspaceId,
        baseId: ctx.baseId,
        fieldId: field.id,
        recordId: w.id,
        targetIds: w.targets,
      });
      converted++;
    }
    const inv = config["inverseFieldId"];
    if (typeof inv === "string") {
      const peerTable = String(config["linkedTableId"]);
      const peers = [...new Set(linkWrites.flatMap((w) => w.targets))];
      await runComputeInTx(trx, scope(ctx), { changes: [{ tableId: peerTable, recordIds: peers, fieldIds: [inv] }] });
    }
  }
  if (!getFieldType(newType).isComputed) {
    // nothing else
  }
  return { config, converted, tableIds };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/** Every table keeps one Record ID field; users hide it per view instead. */
async function assertNotLastRecordIdField(trx: DbTrx, tableId: string, field: { id: string; type: string }): Promise<void> {
  if (field.type !== "record_id") return;
  const others = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM data.fields
    WHERE table_id = ${tableId} AND type = 'record_id' AND deleted_at IS NULL AND id <> ${field.id}
  `.execute(trx);
  if ((others.rows[0]?.n ?? 0) === 0) {
    throw new ApiError(
      409,
      "RECORD_ID_REQUIRED",
      "Every table keeps a Record ID field. Hide it from the view's Fields menu instead.",
    );
  }
}

export async function deleteFieldInTx(
  ctx: SchemaOpContext,
  tableId: string,
  fieldId: string,
): Promise<{ tableIds: string[]; inverseFieldId: string | null }> {
  const field = await loadFieldRow(ctx.trx, tableId, fieldId);
  if (!field) throw new ApiError(404, "FIELD_NOT_FOUND", "Field not found");
  const table = await loadTableRow(ctx.trx, tableId);
  if (table?.primaryFieldId === fieldId) {
    throw new ApiError(409, "PRIMARY_FIELD_REQUIRED", "The primary field cannot be deleted. Make another field primary first.");
  }
  await assertNotLastRecordIdField(ctx.trx, tableId, field);
  const tableIds = new Set([tableId]);
  const deps = await dependentsOf(ctx.trx, [fieldId]);
  let inverseFieldId: string | null = null;
  if (LINK_TYPES.has(field.type)) {
    inverseFieldId = await dropLinkRelation(ctx, field);
    if (inverseFieldId) {
      const other = await sql<{ table_id: string }>`SELECT table_id FROM data.fields WHERE id = ${inverseFieldId}`.execute(ctx.trx);
      if (other.rows[0]) tableIds.add(other.rows[0].table_id);
      deps.push(...(await dependentsOf(ctx.trx, [inverseFieldId])));
    }
  }
  await sql`
    UPDATE data.fields SET deleted_at = now(), deleted_by = ${ctx.userId}, updated_at = now() WHERE id = ${fieldId}
  `.execute(ctx.trx);
  await sql`
    DELETE FROM data.field_dependencies
    WHERE dependent_field_id = ${fieldId} OR depends_on_field_id = ${fieldId} OR via_link_field_id = ${fieldId}
  `.execute(ctx.trx);
  await sql`DELETE FROM data.computed_stale WHERE field_id = ${fieldId}`.execute(ctx.trx);
  const live = deps.filter((d) => d.id !== fieldId && d.id !== inverseFieldId);
  await backfillGrouped(ctx, live);
  for (const d of live) tableIds.add(d.table_id);
  return { tableIds: [...tableIds], inverseFieldId };
}

/** Delete every link field (any table) pointing at `tableId` (table delete cleanup). */
export async function deleteLinksToTableInTx(ctx: SchemaOpContext, tableId: string): Promise<string[]> {
  const r = await sql<{ id: string; table_id: string }>`
    SELECT id, table_id FROM data.fields
    WHERE base_id = ${ctx.baseId} AND deleted_at IS NULL AND type IN ('link','contact')
      AND table_id <> ${tableId} AND config->>'linkedTableId' = ${tableId}
  `.execute(ctx.trx);
  const touched = new Set<string>();
  for (const f of r.rows) {
    const still = await loadFieldRow(ctx.trx, f.table_id, f.id);
    if (!still) continue;
    const primary = (await loadTableRow(ctx.trx, f.table_id))?.primaryFieldId === f.id;
    if (primary) continue;
    const res = await deleteFieldInTx(ctx, f.table_id, f.id);
    res.tableIds.forEach((t) => touched.add(t));
  }
  // Relations of this table's own link fields.
  await sql`
    DELETE FROM data.link_relations WHERE a_table_id = ${tableId} OR b_table_id = ${tableId}
  `.execute(ctx.trx);
  touched.delete(tableId);
  return [...touched];
}

// ---------------------------------------------------------------------------
// Duplicate / reorder / primary
// ---------------------------------------------------------------------------

export async function duplicateFieldInTx(
  ctx: SchemaOpContext,
  tableId: string,
  fieldId: string,
  withValues: boolean,
): Promise<{ fieldId: string; tableIds: string[] }> {
  const field = await loadFieldRow(ctx.trx, tableId, fieldId);
  if (!field) throw new ApiError(404, "FIELD_NOT_FOUND", "Field not found");
  const fields = await loadTableFieldRows(ctx.trx, tableId);
  const name = dedupeName(fields.map((f) => f.name), `${field.name} copy`);
  // Place right after the source field.
  const idx = fields.findIndex((f) => f.id === fieldId);
  const next = fields[idx + 1];
  let orderKey: string | undefined;
  try {
    orderKey = keyBetween(field.orderKey, next ? next.orderKey : null);
  } catch {
    orderKey = undefined;
  }
  const config = { ...field.config };
  delete config["inverseFieldId"];
  const created = await createFieldInTx(ctx, tableId, {
    name,
    type: field.type,
    config,
    ...(field.description ? { description: field.description } : {}),
    ...(orderKey ? { orderKey } : {}),
  });
  const tableIds = new Set([tableId]);
  if (created.linkedTableId) tableIds.add(created.linkedTableId);
  if (withValues && !COMPUTED_TYPES.has(field.type)) {
    const newRow = await loadFieldRow(ctx.trx, tableId, created.fieldId);
    if (LINK_TYPES.has(field.type)) {
      const src = await sql<{ id: string; a_field_id: string }>`
        SELECT id, a_field_id FROM data.link_relations WHERE a_field_id = ${fieldId} OR b_field_id = ${fieldId} LIMIT 1
      `.execute(ctx.trx);
      const dst = await sql<{ id: string }>`SELECT id FROM data.link_relations WHERE a_field_id = ${created.fieldId}`.execute(ctx.trx);
      const s = src.rows[0];
      const d = dst.rows[0];
      if (s && d) {
        const sideA = s.a_field_id === fieldId;
        await sql`
          INSERT INTO data.record_links (relation_id, a_record_id, b_record_id, a_order, b_order, workspace_id, base_id)
          SELECT ${d.id}, ${sql.ref(sideA ? "a_record_id" : "b_record_id")}, ${sql.ref(sideA ? "b_record_id" : "a_record_id")},
                 ${sql.ref(sideA ? "a_order" : "b_order")}, ${sql.ref(sideA ? "b_order" : "a_order")}, workspace_id, base_id
          FROM data.record_links WHERE relation_id = ${s.id} AND deletion_batch_id IS NULL
          ON CONFLICT DO NOTHING
        `.execute(ctx.trx);
        if (created.inverseFieldId && created.linkedTableId) {
          const peers = await sql<{ id: string }>`
            SELECT DISTINCT b_record_id AS id FROM data.record_links WHERE relation_id = ${d.id}
          `.execute(ctx.trx);
          await runComputeInTx(ctx.trx, scope(ctx), {
            changes: [{ tableId: created.linkedTableId, recordIds: peers.rows.map((p) => p.id), fieldIds: [created.inverseFieldId] }],
          });
        }
      }
    } else if (newRow) {
      await sql`
        UPDATE data.records
        SET cells = jsonb_set(cells, ARRAY[${String(newRow.slot)}], cells->${String(field.slot)}, true)
        WHERE table_id = ${tableId} AND deleted_at IS NULL AND cells ? ${String(field.slot)}
      `.execute(ctx.trx);
    }
  }
  return { fieldId: created.fieldId, tableIds: [...tableIds] };
}

export async function reorderFieldsInTx(ctx: SchemaOpContext, tableId: string, fieldIds: string[]): Promise<void> {
  const fields = await loadTableFieldRows(ctx.trx, tableId);
  const known = new Set(fields.map((f) => f.id));
  for (const id of fieldIds) {
    if (!known.has(id)) throw new ApiError(422, "VALIDATION_FAILED", "fieldIds contains a field that is not in this table");
  }
  if (new Set(fieldIds).size !== fieldIds.length) throw new ApiError(422, "VALIDATION_FAILED", "fieldIds contains duplicates");
  const rest = fields.filter((f) => !fieldIds.includes(f.id)).map((f) => f.id);
  const ordered = [...fieldIds, ...rest];
  const keys = keysBetween(null, null, ordered.length);
  const payload = ordered.map((id, i) => ({ id, k: keys[i]! }));
  await sql`
    UPDATE data.fields AS f SET order_key = v.k, updated_at = now()
    FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS v(id uuid, k text)
    WHERE f.id = v.id AND f.table_id = ${tableId}
  `.execute(ctx.trx);
}

export async function setPrimaryFieldInTx(ctx: SchemaOpContext, tableId: string, fieldId: string): Promise<void> {
  const field = await loadFieldRow(ctx.trx, tableId, fieldId);
  if (!field) throw new ApiError(404, "FIELD_NOT_FOUND", "Field not found");
  if (["button", "link", "contact", "attachment", "checkbox"].includes(field.type)) {
    throw new ApiError(422, "VALIDATION_FAILED", `A ${field.type} field cannot be the primary field`);
  }
  await sql`
    UPDATE data.tables SET primary_field_id = ${fieldId}, updated_by = ${ctx.userId}, updated_at = now() WHERE id = ${tableId}
  `.execute(ctx.trx);
  // Primary is the first column.
  await sql`
    UPDATE data.fields SET order_key = ${keyBetween(null, await firstOrderKey(ctx.trx, tableId))}
    WHERE id = ${fieldId}
  `.execute(ctx.trx);
  await rebuildBaseDependencies(ctx.trx, ctx.baseId, ctx.workspaceId);
  await propagateFromField(ctx, tableId, fieldId);
}

async function firstOrderKey(trx: DbTrx, tableId: string): Promise<string | null> {
  const r = await sql<{ order_key: string }>`
    SELECT order_key FROM data.fields WHERE table_id = ${tableId} AND deleted_at IS NULL ORDER BY order_key ASC LIMIT 1
  `.execute(trx);
  const k = r.rows[0]?.order_key ?? null;
  // keyBetween(null, k) must be < k; if k is the minimal key fall back to its value.
  return k;
}
