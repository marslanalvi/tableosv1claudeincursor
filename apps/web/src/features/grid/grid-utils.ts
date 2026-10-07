import {
  asArray,
  cellValueToText,
  isReadOnlyFieldType,
  selectOptions,
  toNumber,
  type FieldLike,
} from "@tabula/field-ui";

export const ROW_HEIGHTS = { short: 32, medium: 56, tall: 88, extra: 128 } as const;
export const HEADER_H = 32;
export const GROUP_H = 40;
export const ADD_ROW_H = 32;
export const SUMMARY_H = 34;
export const ROWNUM_W = 76;
export const ADD_COL_W = 92;
export const DEFAULT_COL_W = 180;
export const PRIMARY_COL_W = 240;
export const MIN_COL_W = 60;

export type SummaryKind = "none" | "count" | "empty" | "filled" | "unique" | "sum" | "avg" | "min" | "max";

const NUMERIC = new Set(["number", "currency", "percent", "rating", "duration", "autonumber", "count", "rollup", "formula"]);

export function summaryKindsFor(type: string): SummaryKind[] {
  const base: SummaryKind[] = ["none", "count", "empty", "filled", "unique"];
  return NUMERIC.has(type) ? [...base, "sum", "avg", "min", "max"] : base;
}

export const SUMMARY_LABEL: Record<SummaryKind, string> = {
  none: "None",
  count: "Count",
  empty: "Empty",
  filled: "Filled",
  unique: "Unique",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
};

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
}

/** Summary over loaded records; returns display text. */
export function computeSummary(
  field: FieldLike,
  kind: SummaryKind,
  records: { fields: Record<string, unknown> }[],
): string {
  if (kind === "none") return "";
  const values = records.map((r) => r.fields[field.id]);
  switch (kind) {
    case "count":
      return String(values.length);
    case "empty":
      return String(values.filter(isEmpty).length);
    case "filled":
      return String(values.filter((v) => !isEmpty(v)).length);
    case "unique":
      return String(new Set(values.filter((v) => !isEmpty(v)).map((v) => JSON.stringify(v))).size);
    default: {
      const nums = values.map((v) => toNumber(v)).filter((n): n is number => n !== null);
      if (nums.length === 0) return "—";
      let n: number;
      if (kind === "sum") n = nums.reduce((a, b) => a + b, 0);
      else if (kind === "avg") n = nums.reduce((a, b) => a + b, 0) / nums.length;
      else if (kind === "min") n = Math.min(...nums);
      else n = Math.max(...nums);
      const text = cellValueToText(field.type === "formula" || field.type === "rollup" ? { ...field, type: "number" } : field, n);
      return text || String(Math.round(n * 100) / 100);
    }
  }
}

export function isEditableField(field: FieldLike, canEdit: boolean): boolean {
  return canEdit && !field.isComputed && !isReadOnlyFieldType(field.type);
}

// ---------------------------------------------------------------------------
// TSV clipboard
// ---------------------------------------------------------------------------

export function toTsv(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t"))
    .join("\n");
}

export function toHtmlTable(rows: string[][]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
}

/** Parse TSV (Excel/Sheets/Airtable compatible, supports quoted multi-line cells). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  const src = text.replace(/\r\n?/g, "\n");
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
    i++;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Record coloring
// ---------------------------------------------------------------------------

const BAR_COLORS: Record<string, string> = {
  blue: "#458fff",
  cyan: "#18bfff",
  teal: "#20d9d2",
  green: "#39bf45",
  yellow: "#f4d35e",
  orange: "#fcab79",
  red: "#f82b60",
  pink: "#ff08c2",
  purple: "#8b46ff",
  gray: "#9297a0",
};

export function barColor(color: string | undefined | null): string | null {
  if (!color) return null;
  return BAR_COLORS[color] ?? color;
}

type Cond = { kind: "condition"; fieldId: string; op: string; value?: unknown };
type Node = { kind: "and" | "or"; children: Node[] } | Cond;

/** Small client-side evaluator used for "color by conditions". */
export function matchesFilter(node: Node | null | undefined, rec: { fields: Record<string, unknown> }, fields: FieldLike[]): boolean {
  if (!node) return true;
  if (node.kind !== "condition") {
    return node.kind === "and"
      ? node.children.every((c) => matchesFilter(c, rec, fields))
      : node.children.some((c) => matchesFilter(c, rec, fields));
  }
  const field = fields.find((f) => f.id === node.fieldId);
  const v = rec.fields[node.fieldId];
  const text = field ? cellValueToText(field, v).toLowerCase() : String(v ?? "").toLowerCase();
  const target = node.value;
  const tText = String(target ?? "").toLowerCase();
  const n = toNumber(v);
  const tn = toNumber(target);
  const ids = asArray<unknown>(v).map((x) => (typeof x === "object" && x ? (x as { id: string }).id : x));
  switch (node.op) {
    case "empty":
      return isEmpty(v);
    case "notEmpty":
      return !isEmpty(v);
    case "eq":
      return typeof target === "string" && target.startsWith("opt_") ? ids.includes(target) : text === tText || (n !== null && n === tn);
    case "neq":
      return !(text === tText || ids.includes(target));
    case "contains":
      return text.includes(tText);
    case "notContains":
      return !text.includes(tText);
    case "startsWith":
      return text.startsWith(tText);
    case "endsWith":
      return text.endsWith(tText);
    case "gt":
    case "isAfter":
      return n !== null && tn !== null ? n > tn : text > tText;
    case "gte":
    case "isOnOrAfter":
      return n !== null && tn !== null ? n >= tn : text >= tText;
    case "lt":
    case "isBefore":
      return n !== null && tn !== null ? n < tn : text < tText;
    case "lte":
    case "isOnOrBefore":
      return n !== null && tn !== null ? n <= tn : text <= tText;
    case "anyOf":
    case "hasAnyOf":
      return asArray<unknown>(target).some((t) => ids.includes(t));
    case "noneOf":
      return !asArray<unknown>(target).some((t) => ids.includes(t));
    case "hasAllOf":
      return asArray<unknown>(target).every((t) => ids.includes(t));
    default:
      return true;
  }
}

/** Group key + label for a record value. */
export function groupKeyOf(field: FieldLike, value: unknown): { key: string; label: string; color?: string | undefined } {
  if (isEmpty(value)) return { key: "∅", label: "(Empty)" };
  if (field.type === "single_select") {
    const opt = selectOptions(field).find((o) => o.id === value);
    return { key: String(value), label: opt?.label ?? String(value), color: opt?.color };
  }
  const label = cellValueToText(field, value);
  return { key: JSON.stringify(value), label: label || "(Empty)" };
}
