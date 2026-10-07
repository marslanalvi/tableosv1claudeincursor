import type { FieldMeta, WireRecord } from "./tokens.js";

/**
 * In-memory evaluation of a filter AST (CONTRACTS §6) against a record in
 * WIRE format (fields keyed by fld_ id, option ids, collaborator/link objects).
 * Used for "record matches conditions" / "enters view" triggers and
 * conditional actions.
 */
type Node =
  | { kind: "and" | "or"; children: Node[] }
  | { kind: "condition"; fieldId: string; op: string; value?: unknown };

export interface EvalContext {
  /** usr_ id of the "current user" for isMe. */
  userId?: string;
  now?: Date;
}

function isEmpty(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    v === false ||
    (Array.isArray(v) && v.length === 0)
  );
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function resolveDate(value: unknown, now: Date): string | null {
  if (typeof value === "string") return value.slice(0, 10);
  if (value && typeof value === "object") {
    const rel = (value as { relative?: string; date?: string }).relative;
    const date = (value as { date?: string }).date;
    switch (rel) {
      case "today":
        return ymd(now);
      case "tomorrow":
        return ymd(addDays(now, 1));
      case "yesterday":
        return ymd(addDays(now, -1));
      case "oneWeekAgo":
        return ymd(addDays(now, -7));
      case "oneWeekFromNow":
        return ymd(addDays(now, 7));
      case "oneMonthAgo":
        return ymd(addDays(now, -30));
      case "oneMonthFromNow":
        return ymd(addDays(now, 30));
      case "exactDate":
        return date ?? null;
      default:
        return date ?? null;
    }
  }
  return null;
}

function withinRange(dateStr: string, value: unknown, now: Date): boolean {
  const range = (value as { range?: string; n?: number } | undefined)?.range;
  const n = (value as { n?: number } | undefined)?.n ?? 1;
  const today = ymd(now);
  let from = today;
  let to = today;
  switch (range) {
    case "pastWeek":
      from = ymd(addDays(now, -7));
      break;
    case "pastMonth":
      from = ymd(addDays(now, -30));
      break;
    case "pastYear":
      from = ymd(addDays(now, -365));
      break;
    case "nextWeek":
      to = ymd(addDays(now, 7));
      break;
    case "nextMonth":
      to = ymd(addDays(now, 30));
      break;
    case "nextYear":
      to = ymd(addDays(now, 365));
      break;
    case "pastNDays":
      from = ymd(addDays(now, -n));
      break;
    case "nextNDays":
      to = ymd(addDays(now, n));
      break;
    case "thisWeek": {
      const dow = now.getUTCDay();
      from = ymd(addDays(now, -dow));
      to = ymd(addDays(now, 6 - dow));
      break;
    }
    case "thisMonth":
      from = `${today.slice(0, 7)}-01`;
      to = `${today.slice(0, 7)}-31`;
      break;
    default:
      return false;
  }
  return dateStr >= from && dateStr <= to;
}

/** Comparable scalar for a wire value. */
function scalar(field: FieldMeta | undefined, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return o["name"] ?? o["text"] ?? o["label"] ?? o["id"] ?? JSON.stringify(v);
  }
  if (field && (field.type === "date" || field.type === "datetime" || field.type === "created_time" || field.type === "modified_time")) {
    return String(v);
  }
  return v;
}

function ids(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => (typeof x === "object" && x ? String((x as { id?: unknown }).id ?? "") : String(x)));
}

function textOf(field: FieldMeta | undefined, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (field && (field.type === "single_select" || field.type === "multi_select")) {
    const options = (field.config?.["options"] ?? []) as { id?: string; label?: string }[];
    return ids(v)
      .map((id) => options.find((o) => o.id === id)?.label ?? id)
      .join(", ");
  }
  if (Array.isArray(v)) return v.map((x) => textOf(undefined, x)).join(", ");
  if (typeof v === "object") return String(scalar(field, v));
  return String(v);
}

function evalCondition(
  node: Extract<Node, { kind: "condition" }>,
  record: WireRecord,
  fieldsById: Map<string, FieldMeta>,
  ctx: EvalContext,
): boolean {
  const field = fieldsById.get(node.fieldId);
  const raw = record.fields[node.fieldId];
  const now = ctx.now ?? new Date();
  const value = node.value;
  const isDate =
    field?.type === "date" ||
    field?.type === "datetime" ||
    field?.type === "created_time" ||
    field?.type === "modified_time";

  switch (node.op) {
    case "empty":
      return isEmpty(raw);
    case "notEmpty":
      return !isEmpty(raw);
    case "isMe":
      return ctx.userId !== undefined && ids(raw).includes(ctx.userId);
    case "anyOf":
      return Array.isArray(value) && ids(raw).some((id) => (value as unknown[]).includes(id));
    case "noneOf":
      return !Array.isArray(value) || !ids(raw).some((id) => (value as unknown[]).includes(id));
    case "hasAnyOf":
      return Array.isArray(value) && ids(raw).some((id) => (value as unknown[]).includes(id));
    case "hasAllOf":
      return Array.isArray(value) && (value as unknown[]).every((x) => ids(raw).includes(String(x)));
    case "contains":
      return textOf(field, raw).toLowerCase().includes(String(value ?? "").toLowerCase());
    case "notContains":
      return !textOf(field, raw).toLowerCase().includes(String(value ?? "").toLowerCase());
    case "startsWith":
      return textOf(field, raw).toLowerCase().startsWith(String(value ?? "").toLowerCase());
    case "endsWith":
      return textOf(field, raw).toLowerCase().endsWith(String(value ?? "").toLowerCase());
    case "isWithin":
      return isDate && !isEmpty(raw) && withinRange(String(raw).slice(0, 10), value, now);
  }

  if (isDate) {
    if (isEmpty(raw)) return node.op === "neq";
    const d = String(raw).slice(0, 10);
    const target = resolveDate(value, now);
    if (target === null) return false;
    switch (node.op) {
      case "eq":
        return d === target;
      case "neq":
        return d !== target;
      case "isBefore":
      case "lt":
        return d < target;
      case "isAfter":
      case "gt":
        return d > target;
      case "isOnOrBefore":
      case "lte":
        return d <= target;
      case "isOnOrAfter":
      case "gte":
        return d >= target;
      default:
        return false;
    }
  }

  if (field?.type === "checkbox") {
    const b = raw === true;
    const want = value === true || value === "true" || value === 1;
    if (node.op === "eq") return b === want;
    if (node.op === "neq") return b !== want;
    return false;
  }

  if (field?.type === "single_select" || field?.type === "multi_select" || field?.type === "collaborator" || field?.type === "link") {
    const have = ids(raw);
    const want = Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)];
    // Accept option labels as well as ids.
    const labels = textOf(field, raw).toLowerCase().split(", ");
    const match = want.some((w) => have.includes(w) || labels.includes(w.toLowerCase()));
    if (node.op === "eq") return match;
    if (node.op === "neq") return !match;
    return false;
  }

  const s = scalar(field, raw);
  const numeric = typeof s === "number" || (typeof s === "string" && s !== "" && !Number.isNaN(Number(s)) && value !== undefined && !Number.isNaN(Number(value)));
  switch (node.op) {
    case "eq":
      if (isEmpty(raw)) return isEmpty(value);
      if (numeric) return Number(s) === Number(value);
      return String(s).toLowerCase() === String(value ?? "").toLowerCase();
    case "neq":
      if (isEmpty(raw)) return !isEmpty(value);
      if (numeric) return Number(s) !== Number(value);
      return String(s).toLowerCase() !== String(value ?? "").toLowerCase();
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (isEmpty(raw)) return false;
      const a = numeric ? Number(s) : String(s);
      const b = numeric ? Number(value) : String(value ?? "");
      if (node.op === "gt") return a > b;
      if (node.op === "gte") return a >= b;
      if (node.op === "lt") return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

function evalNode(node: Node, record: WireRecord, fields: Map<string, FieldMeta>, ctx: EvalContext): boolean {
  if (!node || typeof node !== "object") return true;
  if (node.kind === "condition") return evalCondition(node, record, fields, ctx);
  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length === 0) return true;
  if (node.kind === "and") return children.every((c) => evalNode(c, record, fields, ctx));
  return children.some((c) => evalNode(c, record, fields, ctx));
}

/** Evaluate `filter` against a wire record. A null/empty filter matches everything. */
export function evaluateWireFilter(
  filter: unknown,
  record: WireRecord,
  fields: FieldMeta[],
  ctx: EvalContext = {},
): boolean {
  if (filter === null || filter === undefined) return true;
  const map = new Map(fields.map((f) => [f.id, f]));
  return evalNode(filter as Node, record, map, ctx);
}
