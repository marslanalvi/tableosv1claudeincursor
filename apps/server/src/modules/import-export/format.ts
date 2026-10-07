/**
 * Wire value (CONTRACTS §3) → export cell. Pure so it can be unit tested.
 */

export interface ExportField {
  id: string; // fld_
  name: string;
  type: string;
  config: Record<string, unknown>;
}

/** Leading characters spreadsheet apps treat as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** CSV/XLSX formula-injection guard (OWASP): prefix with an apostrophe. */
export function guardFormula(s: string): string {
  return FORMULA_LEAD.test(s) ? `'${s}` : s;
}

function optionLabel(field: ExportField, id: unknown): string {
  const opts = Array.isArray(field.config["options"])
    ? (field.config["options"] as { id?: string; label?: string }[])
    : [];
  const hit = opts.find((o) => o.id === id);
  return hit?.label ?? String(id ?? "");
}

function nameOf(v: unknown): string {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["name"] === "string") return o["name"] as string;
    if (typeof o["filename"] === "string") return o["filename"] as string;
    if (typeof o["text"] === "string") return o["text"] as string;
    if (typeof o["label"] === "string") return o["label"] as string;
  }
  return scalar(v);
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * Text form of a value. Numbers stay numbers when `keepNumbers` is set (XLSX).
 * `absoluteUrl` turns relative attachment URLs into absolute ones.
 */
export function exportValue(
  field: ExportField,
  value: unknown,
  opts: { keepNumbers?: boolean; absoluteUrl?: (u: string) => string } = {},
): string | number | boolean | null {
  if (value === undefined || value === null) return field.type === "checkbox" && opts.keepNumbers ? null : "";
  switch (field.type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "autonumber":
    case "count":
      if (typeof value === "number") return opts.keepNumbers ? value : String(value);
      return scalar(value);
    case "checkbox":
      return value === true ? (opts.keepNumbers ? true : "checked") : "";
    case "single_select":
      return guardFormula(optionLabel(field, value));
    case "multi_select":
      return guardFormula((Array.isArray(value) ? value : [value]).map((v) => optionLabel(field, v)).join(", "));
    case "attachment":
      return guardFormula(
        (Array.isArray(value) ? value : [value])
          .map((a) => {
            const o = (a ?? {}) as { filename?: string; url?: string };
            const url = o.url ? (opts.absoluteUrl ? opts.absoluteUrl(o.url) : o.url) : "";
            return url ? `${o.filename ?? "file"} (${url})` : (o.filename ?? "");
          })
          .join(", "),
      );
    case "collaborator":
    case "link":
    case "lookup":
      return guardFormula((Array.isArray(value) ? value : [value]).map(nameOf).join(", "));
    case "created_by":
    case "modified_by":
    case "barcode":
      return guardFormula(nameOf(value));
    default: {
      if (typeof value === "number") return opts.keepNumbers ? value : String(value);
      if (typeof value === "boolean") return value ? "true" : "false";
      if (Array.isArray(value)) return guardFormula(value.map(nameOf).join(", "));
      return guardFormula(scalar(value));
    }
  }
}

export function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: (string | number | boolean | null)[][]): string {
  // BOM so Excel opens UTF-8 correctly.
  return (
    "﻿" +
    rows.map((r) => r.map((v) => escapeCsv(v === null ? "" : String(v))).join(",")).join("\r\n")
  );
}
