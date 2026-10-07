/**
 * Client-side parsing for the import wizard: RFC 4180 CSV/TSV, a minimal XLSX
 * reader (ZIP + DecompressionStream, first worksheet), and column type
 * detection. Pure helpers are unit-tested in parse.test.ts.
 */

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
}

/** RFC 4180 CSV (quotes, escaped quotes, CRLF/LF, embedded newlines). */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const delim = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty trailing rows.
  while (rows.length && rows[rows.length - 1]!.every((v) => v.trim() === "")) rows.pop();
  return rows;
}

export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [",", "\t", ";", "|"].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0] && counts[0][1] > 0 ? counts[0][0] : ",";
}

/** Normalize a grid into headers + rows (pads ragged rows, names blank headers). */
export function toSheet(grid: string[][], firstRowIsHeader: boolean): ParsedSheet {
  const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  const padded = grid.map(pad);
  let headers: string[];
  let rows: string[][];
  if (firstRowIsHeader && padded.length) {
    headers = padded[0]!.map((h, i) => h.trim() || `Field ${i + 1}`);
    rows = padded.slice(1);
  } else {
    headers = Array.from({ length: width }, (_, i) => `Field ${i + 1}`);
    rows = padded;
  }
  // De-duplicate header names (case-insensitive) since field names are unique.
  const seen = new Map<string, number>();
  headers = headers.map((h) => {
    const k = h.toLowerCase();
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n === 0 ? h : `${h} (${n + 1})`;
  });
  rows = rows.filter((r) => r.some((v) => v.trim() !== ""));
  return { headers, rows };
}

// ── Type detection ──────────────────────────────────────────────────────────

export type DetectedType =
  | "text"
  | "long_text"
  | "number"
  | "currency"
  | "percent"
  | "checkbox"
  | "date"
  | "datetime"
  | "email"
  | "url"
  | "phone"
  | "single_select"
  | "multi_select";

const NUM_RE = /^-?\(?\$?-?[\d,]*\.?\d+\)?$/;
const CURRENCY_RE = /^-?[$€£¥]\s?-?[\d,]*\.?\d+$/;
const PERCENT_RE = /^-?[\d,]*\.?\d+\s?%$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;
const BOOL_VALUES = new Set(["true", "false", "yes", "no", "y", "n", "x", "checked", "unchecked", "0", "1"]);

/** Parse common date spellings to YYYY-MM-DD (null when not a date). */
export function normalizeDate(raw: string): string | null {
  const v = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v);
  if (m) {
    let y = +m[3]!;
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const a = +m[1]!;
    const b = +m[2]!;
    // US by default (M/D/Y); if the first part can't be a month, treat as D/M/Y.
    return a > 12 ? ymd(y, b, a) : ymd(y, a, b);
  }
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(v);
  if (m) {
    const month = monthIndex(m[1]!);
    if (month) return ymd(+m[3]!, month, +m[2]!);
  }
  m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(v);
  if (m) {
    const month = monthIndex(m[2]!);
    if (month) return ymd(+m[3]!, month, +m[1]!);
  }
  return null;
}

function monthIndex(name: string): number | null {
  const i = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
    name.slice(0, 3).toLowerCase(),
  );
  return i >= 0 ? i + 1 : null;
}

function ymd(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isDateTime(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v.trim()) && !Number.isNaN(Date.parse(v.trim()));
}

export function detectType(values: string[]): DetectedType {
  const vals = values.map((v) => v.trim()).filter((v) => v !== "");
  if (vals.length === 0) return "text";
  const all = (fn: (v: string) => boolean) => vals.every(fn);
  if (all((v) => BOOL_VALUES.has(v.toLowerCase())) && !all((v) => v === "0" || v === "1")) return "checkbox";
  if (all((v) => PERCENT_RE.test(v))) return "percent";
  if (all((v) => CURRENCY_RE.test(v))) return "currency";
  if (all((v) => NUM_RE.test(v.replace(/\s/g, "")))) return "number";
  if (all(isDateTime)) return "datetime";
  if (all((v) => normalizeDate(v) !== null)) return "date";
  if (all((v) => EMAIL_RE.test(v))) return "email";
  if (all((v) => URL_RE.test(v))) return "url";
  if (all((v) => PHONE_RE.test(v) && /\d{3}/.test(v) && v.replace(/\D/g, "").length >= 7)) return "phone";
  if (vals.some((v) => v.length > 120 || v.includes("\n"))) return "long_text";
  const distinct = new Set(vals);
  if (vals.length >= 6 && distinct.size <= 12 && distinct.size <= vals.length / 2) {
    if (vals.some((v) => v.includes(",")) && all((v) => v.split(",").every((p) => p.trim().length < 40))) {
      return "multi_select";
    }
    return "single_select";
  }
  return "text";
}

/**
 * Convert a raw string to the input shorthand for a field type (CONTRACTS §3);
 * `undefined` means "leave empty". The server typecasts the rest.
 */
export function convertValue(type: string, raw: string): unknown {
  const v = raw.trim();
  if (v === "") return undefined;
  switch (type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration": {
      const neg = /^\(.*\)$/.test(v);
      const n = Number(v.replace(/[^\d.eE-]/g, ""));
      if (!Number.isFinite(n)) return v;
      return neg ? -Math.abs(n) : n;
    }
    case "checkbox":
      return ["true", "yes", "y", "x", "checked", "1", "✓", "✔"].includes(v.toLowerCase()) ? true : undefined;
    case "date":
      return normalizeDate(v) ?? v;
    case "datetime": {
      const t = Date.parse(v);
      return Number.isNaN(t) ? v : new Date(t).toISOString();
    }
    case "multi_select":
      return [...new Set(v.split(",").map((p) => p.trim()).filter(Boolean))];
    case "long_text":
      return raw;
    default:
      return v;
  }
}

// ── XLSX reader ─────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readZipEntries(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readZipEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nameLen = dv.getUint16(e.localOffset + 26, true);
  const extraLen = dv.getUint16(e.localOffset + 28, true);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error("Unsupported compression in .xlsx");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel serial date → YYYY-MM-DD (1900 date system). */
export function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return d.toISOString().slice(0, serial % 1 === 0 ? 10 : 19).replace("T", " ");
}

const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export async function parseXlsx(data: ArrayBuffer): Promise<string[][]> {
  const buf = new Uint8Array(data);
  const entries = readZipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const parser = new DOMParser();

  const shared: string[] = [];
  const sst = byName.get("xl/sharedStrings.xml");
  if (sst) {
    const doc = parser.parseFromString(await readZipEntry(buf, sst), "application/xml");
    for (const si of Array.from(doc.getElementsByTagName("si"))) {
      shared.push(Array.from(si.getElementsByTagName("t")).map((t) => t.textContent ?? "").join(""));
    }
  }

  // Date-formatted styles.
  const dateStyles = new Set<number>();
  const stylesEntry = byName.get("xl/styles.xml");
  if (stylesEntry) {
    const doc = parser.parseFromString(await readZipEntry(buf, stylesEntry), "application/xml");
    const customDate = new Set<number>();
    for (const nf of Array.from(doc.getElementsByTagName("numFmt"))) {
      const code = (nf.getAttribute("formatCode") ?? "").toLowerCase();
      if (/[dy]/.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, ""))) customDate.add(Number(nf.getAttribute("numFmtId")));
    }
    const cellXfs = doc.getElementsByTagName("cellXfs")[0];
    if (cellXfs) {
      Array.from(cellXfs.getElementsByTagName("xf")).forEach((xf, i) => {
        const id = Number(xf.getAttribute("numFmtId") ?? 0);
        if (DATE_FORMAT_IDS.has(id) || customDate.has(id)) dateStyles.add(i);
      });
    }
  }

  // First sheet in workbook order.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = byName.get("xl/workbook.xml");
  const rels = byName.get("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const wbDoc = parser.parseFromString(await readZipEntry(buf, wb), "application/xml");
    const relDoc = parser.parseFromString(await readZipEntry(buf, rels), "application/xml");
    const first = wbDoc.getElementsByTagName("sheet")[0];
    const rid =
      first?.getAttribute("r:id") ??
      first?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const rel = Array.from(relDoc.getElementsByTagName("Relationship")).find((r) => r.getAttribute("Id") === rid);
    const target = rel?.getAttribute("Target");
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = byName.get(sheetPath) ?? entries.find((e) => e.name.startsWith("xl/worksheets/sheet"));
  if (!sheet) throw new Error("The workbook has no worksheets");
  const doc = parser.parseFromString(await readZipEntry(buf, sheet), "application/xml");

  const grid: string[][] = [];
  for (const row of Array.from(doc.getElementsByTagName("row"))) {
    const r = Number(row.getAttribute("r") ?? grid.length + 1) - 1;
    const out: string[] = [];
    let nextCol = 0;
    for (const c of Array.from(row.getElementsByTagName("c"))) {
      const ref = c.getAttribute("r");
      const col = ref ? colIndex(ref) : nextCol;
      nextCol = col + 1;
      const t = c.getAttribute("t");
      const s = Number(c.getAttribute("s") ?? -1);
      const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
      let text: string;
      if (t === "s") text = shared[Number(v)] ?? "";
      else if (t === "inlineStr")
        text = Array.from(c.getElementsByTagName("t")).map((x) => x.textContent ?? "").join("");
      else if (t === "b") text = v === "1" ? "true" : "false";
      else if (t === "str" || t === "e") text = v;
      else if (v !== "" && dateStyles.has(s) && Number.isFinite(Number(v))) text = excelSerialToDate(Number(v));
      else text = v;
      out[col] = text;
    }
    grid[r] = Array.from(out, (x) => x ?? "");
  }
  return Array.from(grid, (x) => x ?? []);
}

export async function parseFile(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || file.type.includes("spreadsheetml")) {
    return parseXlsx(await file.arrayBuffer());
  }
  if (name.endsWith(".xls")) {
    throw new Error("Legacy .xls files are not supported. Save the file as .xlsx or .csv and try again.");
  }
  const text = await file.text();
  return parseDelimited(text, name.endsWith(".tsv") ? "\t" : undefined);
}
