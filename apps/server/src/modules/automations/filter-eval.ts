import { evaluateFilter, isFilterError, type EvalField, type FilterAst } from "@tabula/filter";
import { decodePublicId } from "@tabula/types";
import type { FieldMeta, TableMeta, WireRecord } from "./tokens.js";

/**
 * Evaluate a filter AST (CONTRACTS §6) against a record in WIRE format, using
 * the shared `@tabula/filter` evaluator (same semantics as the SQL compiler).
 * Used for "record matches conditions" / "enters view" triggers and
 * conditional actions.
 */
export interface EvalContext {
  /** usr_ id of the "current user" for isMe. */
  userId?: string;
  now?: Date;
  timeZone?: string;
}

function rawFieldUuid(id: string): string | null {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase();
  if (!id.startsWith("fld_")) return null;
  try {
    return decodePublicId(id).uuid;
  } catch {
    return null;
  }
}

/**
 * Attach `lookupTarget` to every lookup field, resolving `config.targetFieldId`
 * (raw uuid or `fld_`; legacy `lookupFieldId`) across all tables of the base.
 * Mutates and returns `tables`.
 */
export function resolveLookupTargets(tables: TableMeta[]): TableMeta[] {
  const byUuid = new Map<string, FieldMeta>();
  for (const t of tables) {
    for (const f of t.fields) {
      const u = rawFieldUuid(f.id);
      if (u) byUuid.set(u, f);
    }
  }
  for (const t of tables) {
    for (const f of t.fields) {
      if (f.type !== "lookup") continue;
      const raw = f.config?.["targetFieldId"] ?? f.config?.["lookupFieldId"];
      const target = typeof raw === "string" ? byUuid.get(rawFieldUuid(raw) ?? "") : undefined;
      f.lookupTarget = target ? { id: target.id, type: target.type, config: target.config ?? {} } : null;
    }
  }
  return tables;
}

/**
 * A null/empty filter matches everything. A filter that cannot be evaluated
 * (unknown operator for the field type, bad operand) matches nothing.
 */
export function evaluateWireFilter(
  filter: unknown,
  record: WireRecord,
  fields: FieldMeta[],
  ctx: EvalContext = {},
): boolean {
  if (filter === null || filter === undefined) return true;
  const evalFields: EvalField[] = fields.map((f) => ({
    id: f.id,
    type: f.type,
    config: f.config ?? {},
    ...(f.lookupTarget ? { lookupTarget: f.lookupTarget } : {}),
  })) as EvalField[];
  try {
    return evaluateFilter(filter as FilterAst, { fields: record.fields ?? {} }, evalFields, {
      ...(ctx.now ? { now: ctx.now } : {}),
      ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
      ...(ctx.userId ? { currentUserId: ctx.userId } : {}),
      unknownField: "false",
    });
  } catch (err) {
    if (isFilterError(err)) return false;
    throw err;
  }
}
