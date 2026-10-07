/**
 * FieldDto serialization + wire ↔ storage config conversion (CONTRACTS §4).
 *
 * Storage: config holds raw uuids; formula expressions reference fields as
 * `{<field uuid>}`. Wire: `tbl_`/`fld_` public ids; formulas show `{Field Name}`.
 */
import { getFieldType, isFieldTypeKey, type FieldConfig } from "@tabula/fields";
import {
  FormulaParseError,
  formulaFieldRefs,
  parseFormula,
  rewriteFormulaRefs,
  validateFormulaAst,
} from "@tabula/formula";
import { sql, type Kysely } from "kysely";
import type { Database } from "@tabula/db";
import { ApiError } from "../../http/errors.js";
import { pid } from "../../lib/public-ids.js";
import { decodePublicId, type PublicIdPrefix } from "@tabula/types";
import type { Db, FieldRowFull } from "./table-schema.js";

export interface FieldDto {
  id: string;
  name: string;
  type: string;
  slot: number;
  config: Record<string, unknown>;
  description: string | null;
  isPrimary: boolean;
  isComputed: boolean;
  /** Present for link fields: "tbl_…" of the linked table (same as config.linkedTableId). */
  [key: string]: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): boolean {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Accept `pfx_…` or raw uuid; returns uuid or null. */
export function idFromAny(value: unknown, prefix: PublicIdPrefix): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (isUuid(value)) return (value as string).toLowerCase();
  if (value.startsWith(`${prefix}_`)) {
    try {
      return decodePublicId(value, prefix).uuid;
    } catch {
      return null;
    }
  }
  return null;
}

function pidOrNull(prefix: PublicIdPrefix, v: unknown): string | null {
  return isUuid(v) ? pid(prefix, v as string) : typeof v === "string" && v.startsWith(`${prefix}_`) ? v : null;
}

/** Formula expression stored with `{uuid}` refs → `{Name}` refs for display. */
export function formulaToDisplay(expr: string, nameById: ReadonlyMap<string, string>): string {
  if (!expr) return expr;
  try {
    return rewriteFormulaRefs(expr, (ref) => {
      if (isUuid(ref)) return nameById.get(ref.toLowerCase()) ?? null;
      if (ref.startsWith("fld_")) {
        const id = idFromAny(ref, "fld");
        return id ? (nameById.get(id) ?? null) : null;
      }
      return null;
    });
  } catch {
    return expr;
  }
}

/** Convert a stored config to the wire shape. */
export function configToWire(
  type: string,
  config: Record<string, unknown>,
  nameById: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const c: Record<string, unknown> = { ...config };
  switch (type) {
    case "link":
    case "contact":
      c["linkedTableId"] = pidOrNull("tbl", c["linkedTableId"]);
      c["inverseFieldId"] = pidOrNull("fld", c["inverseFieldId"]);
      if (c["allowMultiple"] === undefined) c["allowMultiple"] = true;
      break;
    case "lookup":
    case "rollup":
      c["linkFieldId"] = pidOrNull("fld", c["linkFieldId"]);
      c["targetFieldId"] = pidOrNull("fld", c["targetFieldId"] ?? c["lookupFieldId"] ?? c["rollupFieldId"]);
      delete c["lookupFieldId"];
      delete c["rollupFieldId"];
      if (type === "rollup" && c["aggregation"] === undefined) c["aggregation"] = "sum";
      break;
    case "count":
      c["linkFieldId"] = pidOrNull("fld", c["linkFieldId"]);
      break;
    case "formula": {
      const expr = typeof c["expression"] === "string" ? c["expression"] : typeof c["formula"] === "string" ? c["formula"] : "";
      c["expression"] = formulaToDisplay(expr, nameById);
      delete c["formula"];
      break;
    }
    case "button": {
      const a = c["action"] as Record<string, unknown> | undefined;
      if (a && a["type"] === "run_automation") {
        c["action"] = { ...a, automationId: pidOrNull("aut", a["automationId"]) ?? a["automationId"] };
      }
      break;
    }
    default:
      break;
  }
  return c;
}

export function fieldRowToDto(
  row: Pick<FieldRowFull, "id" | "name" | "type" | "slot" | "config" | "description" | "isComputed"> & {
    tableId?: string;
  },
  ctx: { primaryFieldId: string | null; nameById: ReadonlyMap<string, string> },
): FieldDto {
  const dto: FieldDto = {
    id: pid("fld", row.id),
    name: row.name,
    type: row.type,
    slot: row.slot,
    config: configToWire(row.type, row.config ?? {}, ctx.nameById),
    description: row.description ? row.description : null,
    isPrimary: ctx.primaryFieldId === row.id,
    isComputed: row.isComputed || (isFieldTypeKey(row.type) && getFieldType(row.type).isComputed === true),
    isReadOnly: isFieldTypeKey(row.type) ? getFieldType(row.type).readOnly === true : true,
  };
  if (row.tableId) dto["tableId"] = pid("tbl", row.tableId);
  return dto;
}

/** Name map for every live field in a base (formula display). */
export async function loadFieldNameMap(db: Db, baseId: string): Promise<Map<string, string>> {
  const r = await sql<{ id: string; name: string }>`
    SELECT id, name FROM data.fields WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db as Kysely<Database>);
  return new Map(r.rows.map((x) => [x.id, x.name]));
}

// ---------------------------------------------------------------------------
// Wire → storage
// ---------------------------------------------------------------------------

export interface ConfigResolveContext {
  db: Db;
  baseId: string;
  tableId: string;
  /** Live fields of `tableId` (formula refs and lookup link fields resolve here). */
  tableFields: readonly FieldRowFull[];
  /** The field being configured (excluded from self-reference). */
  fieldId?: string;
  /** Existing stored config (keeps link relation / inverse ids on update). */
  existing?: Record<string, unknown>;
}

function invalid(detail: string): never {
  throw new ApiError(422, "VALIDATION_FAILED", detail);
}

/** Resolve a field reference (pid / uuid / name) inside `fields`. */
export function findFieldByRef(fields: readonly FieldRowFull[], ref: string): FieldRowFull | undefined {
  const id = idFromAny(ref, "fld");
  if (id) return fields.find((f) => f.id === id);
  const exact = fields.find((f) => f.name === ref);
  if (exact) return exact;
  const lk = ref.trim().toLowerCase();
  return fields.find((f) => f.name.trim().toLowerCase() === lk);
}

/** Formula with `{Name}` / `{fld_…}` / bare refs → stored `{uuid}` refs. Validates syntax + functions. */
export function formulaToStorage(
  expr: string,
  fields: readonly FieldRowFull[],
  selfId: string | undefined,
): { expression: string; refIds: string[] } {
  const trimmed = expr.trim();
  if (trimmed === "") return { expression: "", refIds: [] };
  let ast;
  try {
    ast = parseFormula(trimmed);
    validateFormulaAst(ast);
  } catch (e) {
    if (e instanceof FormulaParseError || (e instanceof Error && e.name === "FormulaEvalError")) {
      invalid(`Formula error: ${e.message}`);
    }
    throw e;
  }
  const refIds: string[] = [];
  for (const ref of formulaFieldRefs(ast)) {
    const f = findFieldByRef(fields, ref);
    if (!f) invalid(`Formula error: unknown field {${ref}}`);
    if (selfId && f.id === selfId) invalid(`Formula error: a formula cannot reference itself ({${f.name}})`);
    if (f.type === "button") invalid(`Formula error: {${f.name}} is a button field`);
    if (!refIds.includes(f.id)) refIds.push(f.id);
  }
  const expression = rewriteFormulaRefs(expr, (ref) => findFieldByRef(fields, ref)?.id ?? null);
  return { expression, refIds };
}

async function loadLiveTable(db: Db, baseId: string, tableId: string): Promise<boolean> {
  const r = await sql<{ id: string }>`
    SELECT id FROM data.tables WHERE id = ${tableId} AND base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db as Kysely<Database>);
  return r.rows.length > 0;
}

async function loadLiveField(
  db: Db,
  fieldId: string,
): Promise<{ id: string; table_id: string; type: string; config: Record<string, unknown>; name: string } | null> {
  const r = await sql<{ id: string; table_id: string; type: string; config: Record<string, unknown>; name: string }>`
    SELECT id, table_id, type, config, name FROM data.fields WHERE id = ${fieldId} AND deleted_at IS NULL
  `.execute(db as Kysely<Database>);
  return r.rows[0] ?? null;
}

/**
 * Validate + convert a wire config into the stored config (defaults filled in
 * by the registry). Throws ApiError(422) with a readable message.
 */
export async function configFromWire(
  type: string,
  input: Record<string, unknown> | undefined,
  ctx: ConfigResolveContext,
): Promise<FieldConfig> {
  if (!isFieldTypeKey(type)) invalid(`Unknown field type "${type}"`);
  const def = getFieldType(type);
  if (def.creatable === false) invalid(`Field type "${type}" is not supported yet`);
  const raw: Record<string, unknown> = { ...(input ?? {}) };

  switch (type) {
    case "link":
    case "contact": {
      const linked = idFromAny(raw["linkedTableId"] ?? ctx.existing?.["linkedTableId"], "tbl");
      if (!linked) invalid("config.linkedTableId is required for link fields");
      if (!(await loadLiveTable(ctx.db, ctx.baseId, linked))) invalid("config.linkedTableId: table not found in this base");
      raw["linkedTableId"] = linked;
      raw["inverseFieldId"] = ctx.existing?.["inverseFieldId"] ?? null;
      if (raw["allowMultiple"] === undefined && ctx.existing?.["allowMultiple"] !== undefined) {
        raw["allowMultiple"] = ctx.existing["allowMultiple"];
      }
      break;
    }
    case "lookup":
    case "rollup":
    case "count": {
      const linkRef = raw["linkFieldId"];
      const link = typeof linkRef === "string" ? findFieldByRef(ctx.tableFields, linkRef) : undefined;
      if (!link) invalid("config.linkFieldId must be a link field in this table");
      if (link.type !== "link" && link.type !== "contact") invalid("config.linkFieldId must be a link field");
      raw["linkFieldId"] = link.id;
      if (type !== "count") {
        const targetRef = raw["targetFieldId"] ?? raw["lookupFieldId"] ?? raw["rollupFieldId"];
        const linkedTableId = String(link.config["linkedTableId"] ?? "");
        const targetId = idFromAny(targetRef, "fld");
        let target = targetId ? await loadLiveField(ctx.db, targetId) : null;
        if (!target && typeof targetRef === "string") {
          const r = await sql<{ id: string; table_id: string; type: string; config: Record<string, unknown>; name: string }>`
            SELECT id, table_id, type, config, name FROM data.fields
            WHERE table_id = ${linkedTableId} AND deleted_at IS NULL AND lower(name) = lower(${targetRef})
            LIMIT 1
          `.execute(ctx.db as Kysely<Database>);
          target = r.rows[0] ?? null;
        }
        if (!target || target.table_id !== linkedTableId) {
          invalid("config.targetFieldId must be a field in the linked table");
        }
        if (target.type === "button") invalid("config.targetFieldId cannot be a button field");
        raw["targetFieldId"] = target.id;
        delete raw["lookupFieldId"];
        delete raw["rollupFieldId"];
      }
      break;
    }
    case "formula": {
      const expr = raw["expression"] ?? raw["formula"] ?? "";
      if (typeof expr !== "string") invalid("config.expression must be a string");
      raw["expression"] = formulaToStorage(expr, ctx.tableFields, ctx.fieldId).expression;
      delete raw["formula"];
      break;
    }
    case "single_select":
    case "multi_select": {
      if (raw["options"] === undefined && Array.isArray(ctx.existing?.["options"])) {
        raw["options"] = ctx.existing!["options"];
      }
      if (raw["options"] === undefined && !ctx.existing) {
        raw["options"] = [];
      }
      break;
    }
    case "button": {
      const a = raw["action"] as Record<string, unknown> | undefined;
      if (a && a["type"] === "run_automation") {
        const id = idFromAny(a["automationId"], "aut");
        if (!id) invalid("config.action.automationId must be an automation id");
        raw["action"] = { ...a, automationId: id };
      }
      break;
    }
    default:
      break;
  }
  try {
    return def.normalizeConfig(raw);
  } catch (e) {
    if (e instanceof Error && e.name === "FieldValidationError") invalid(e.message);
    throw e;
  }
}
