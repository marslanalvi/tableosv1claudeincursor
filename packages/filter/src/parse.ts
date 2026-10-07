import { FILTER_OPS, type FilterAst, type FilterNode } from "./ast.js";

const MAX_GROUP_DEPTH = 8;
/** Total condition nodes per filter (architecture/11 §5). */
const MAX_CONDITIONS = 200;

/** Validates shape, depth and size in one bounded walk (deep input never recurses past the limit). */
function check(value: unknown, depth: number, budget: { conditions: number }): void {
  if (!value || typeof value !== "object") throw new Error("INVALID_FILTER_AST");
  const o = value as Record<string, unknown>;
  if (o["kind"] === "condition") {
    if (
      typeof o["fieldId"] !== "string" ||
      typeof o["op"] !== "string" ||
      !(FILTER_OPS as readonly string[]).includes(o["op"])
    ) {
      throw new Error("INVALID_FILTER_AST");
    }
    if (++budget.conditions > MAX_CONDITIONS) throw new Error("FILTER_TOO_LARGE");
    return;
  }
  if ((o["kind"] !== "and" && o["kind"] !== "or") || !Array.isArray(o["children"])) {
    throw new Error("INVALID_FILTER_AST");
  }
  if (depth + 1 > MAX_GROUP_DEPTH && o["children"].length > 0) throw new Error("FILTER_DEPTH_EXCEEDED");
  for (const c of o["children"]) check(c, depth + 1, budget);
}

/** Parse persisted / API filter JSON into a validated AST (depth ≤ 8, ≤ 200 conditions). */
export function parseFilterAst(input: unknown): FilterAst | null {
  if (input === undefined || input === null) return null;
  check(input, 0, { conditions: 0 });
  return input as FilterNode;
}

export { MAX_GROUP_DEPTH, MAX_CONDITIONS };
