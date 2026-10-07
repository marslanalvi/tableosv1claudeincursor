/**
 * Token interpolation for automation configs: `{{trigger.record.fields.Name}}`,
 * `{{steps.a1.records.0.fields.Email}}`, `{{trigger.body.customer.id}}`.
 *
 * Pure functions (no I/O) — covered by tokens.test.ts.
 */

export interface FieldMeta {
  id: string; // fld_…
  name: string;
  type: string;
  slot?: number;
  config?: Record<string, unknown>;
  /** Lookup fields: the looked-up field (resolved from `config.targetFieldId`). */
  lookupTarget?: { id: string; type: string; config: Record<string, unknown> } | null;
}

export interface TableMeta {
  id: string; // tbl_…
  name: string;
  fields: FieldMeta[];
  views: { id: string; name: string; type?: string; config?: Record<string, unknown> }[];
}

export interface WireRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  fields: Record<string, unknown>;
}

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function optionLabel(field: FieldMeta, id: unknown): string {
  const options = (field.config?.["options"] ?? []) as { id?: string; label?: string; name?: string }[];
  const hit = options.find((o) => o.id === id);
  return hit?.label ?? hit?.name ?? String(id);
}

/** Human-readable rendering of a wire value (what Airtable shows in tokens). */
export function displayValue(field: FieldMeta | undefined, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (!field) return stringify(value);
  switch (field.type) {
    case "single_select":
      return optionLabel(field, value);
    case "multi_select":
      return Array.isArray(value) ? value.map((v) => optionLabel(field, v)).join(", ") : optionLabel(field, value);
    case "collaborator":
    case "created_by":
    case "modified_by": {
      const arr = Array.isArray(value) ? value : [value];
      return arr
        .map((u) => (typeof u === "object" && u ? ((u as { name?: string; email?: string }).name ?? (u as { email?: string }).email ?? "") : String(u)))
        .join(", ");
    }
    case "link": {
      const arr = Array.isArray(value) ? value : [value];
      return arr
        .map((r) => (typeof r === "object" && r ? ((r as { name?: string; id?: string }).name ?? (r as { id?: string }).id ?? "") : String(r)))
        .join(", ");
    }
    case "attachment": {
      const arr = Array.isArray(value) ? value : [value];
      return arr
        .map((a) => (typeof a === "object" && a ? ((a as { url?: string; filename?: string }).url ?? (a as { filename?: string }).filename ?? "") : String(a)))
        .join(", ");
    }
    case "checkbox":
      return value === true ? "true" : "false";
    case "barcode":
      return typeof value === "object" && value ? String((value as { text?: unknown }).text ?? "") : String(value);
    case "lookup": {
      const target = field.lookupTarget;
      const inner: FieldMeta | undefined = target ? { id: target.id, name: "", type: target.type, config: target.config } : undefined;
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((v) => (inner ? displayValue(inner, v) : stringify(v))).filter((s) => s !== "").join(", ");
    }
    default:
      return stringify(value);
  }
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => stringify(v)).join(", ");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o["name"] === "string") return o["name"];
    if (typeof o["label"] === "string") return o["label"];
    if (typeof o["text"] === "string") return o["text"];
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Token-context view of a record:
 *   { id, url, createdAt, fields: {<Name>: display}, raw: {<Name>: wire value}, fieldsById: {fld_: display} }
 */
export function recordContext(
  table: TableMeta | undefined,
  record: WireRecord,
  appUrl?: string,
  baseId?: string,
): Record<string, unknown> {
  const fields: Record<string, string> = {};
  const raw: Record<string, unknown> = {};
  const fieldsById: Record<string, string> = {};
  for (const f of table?.fields ?? []) {
    const v = record.fields[f.id];
    const d = displayValue(f, v);
    fields[f.name] = d;
    raw[f.name] = v ?? null;
    fieldsById[f.id] = d;
  }
  // Values for fields we have no metadata for.
  for (const [k, v] of Object.entries(record.fields)) {
    if (!(k in fieldsById)) fieldsById[k] = stringify(v);
  }
  return {
    id: record.id,
    url: appUrl && baseId && table ? `${appUrl}/bases/${baseId}?table=${table.id}&record=${record.id}` : undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    tableId: table?.id,
    tableName: table?.name,
    fields,
    raw,
    fieldsById,
  };
}

/** Resolve a dotted path; tolerates keys that themselves contain dots/spaces. */
export function resolvePath(ctx: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\["([^"]+)"\]/g, ".\u0000$1\u0000")
    .split(".")
    .filter((s) => s.length > 0);
  // Re-join bracket-quoted keys that contained dots.
  const parts: string[] = [];
  let buf: string | null = null;
  for (const s of segments) {
    if (buf !== null) {
      buf += `.${s}`;
      if (s.endsWith("\u0000")) {
        parts.push(buf.replace(/\u0000/g, ""));
        buf = null;
      }
    } else if (s.startsWith("\u0000") && !s.endsWith("\u0000")) {
      buf = s;
    } else {
      parts.push(s.replace(/\u0000/g, ""));
    }
  }
  if (buf !== null) parts.push(buf.replace(/\u0000/g, ""));

  return walk(ctx, parts);
}

function walk(cur: unknown, parts: string[]): unknown {
  if (parts.length === 0) return cur;
  if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
  const obj = cur as Record<string, unknown>;
  // Greedy: try the longest key made of the next k segments first ("First.Name").
  for (let k = parts.length; k >= 1; k--) {
    const key = parts.slice(0, k).join(".");
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const res = walk(obj[key], parts.slice(k));
      if (res !== undefined) return res;
    }
  }
  // Case-insensitive fallback for field names.
  const lower = parts[0]!.toLowerCase();
  const ci = Object.keys(obj).find((k) => k.toLowerCase() === lower);
  if (ci !== undefined) return walk(obj[ci], parts.slice(1));
  return undefined;
}

/** Replace every `{{path}}` with its string rendering. */
export function interpolate(template: string, ctx: unknown): string {
  return template.replace(TOKEN_RE, (_m, path: string) => stringify(resolvePath(ctx, path.trim())));
}

/**
 * Interpolate a value used as a cell input. When the whole template is a
 * single token, the raw (non-string) value is preserved, e.g. arrays of
 * record ids or numbers.
 */
export function interpolateValue(value: unknown, ctx: unknown): unknown {
  if (typeof value !== "string") {
    if (Array.isArray(value)) return value.map((v) => interpolateValue(v, ctx));
    return value;
  }
  const single = value.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
  if (single) {
    const v = resolvePath(ctx, single[1]!.trim());
    if (v === undefined || v === null) return null;
    return v;
  }
  return interpolate(value, ctx);
}

/** Recursively interpolate strings in a JSON-ish structure. */
export function interpolateDeep(value: unknown, ctx: unknown): unknown {
  if (typeof value === "string") return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateDeep(v, ctx)]),
    );
  }
  return value;
}

/** Simple left/op/right comparisons used by conditional (branch) actions. */
export function compareCondition(left: string, op: string, right: string | undefined): boolean {
  const l = left.trim();
  const r = (right ?? "").trim();
  const ln = Number(l);
  const rn = Number(r);
  const numeric = l !== "" && r !== "" && !Number.isNaN(ln) && !Number.isNaN(rn);
  switch (op) {
    case "eq":
      return numeric ? ln === rn : l.toLowerCase() === r.toLowerCase();
    case "neq":
      return numeric ? ln !== rn : l.toLowerCase() !== r.toLowerCase();
    case "contains":
      return l.toLowerCase().includes(r.toLowerCase());
    case "notContains":
      return !l.toLowerCase().includes(r.toLowerCase());
    case "empty":
      return l === "" || l === "false";
    case "notEmpty":
      return l !== "" && l !== "false";
    case "gt":
      return numeric ? ln > rn : l > r;
    case "gte":
      return numeric ? ln >= rn : l >= r;
    case "lt":
      return numeric ? ln < rn : l < r;
    case "lte":
      return numeric ? ln <= rn : l <= r;
    default:
      return false;
  }
}
