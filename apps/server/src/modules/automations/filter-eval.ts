import { evaluateFilter, isFilterError, type EvalField, type FilterAst } from "@tabula/filter";
import type { FieldMeta, WireRecord } from "./tokens.js";

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
