import type { FormulaAst, FormulaValue, RuntimeValue } from "./ast.js";

/** Raised during evaluation; surfaces as `#ERROR! …` on the record. */
export class FormulaEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaEvalError";
  }
}

export interface FormulaContext {
  /**
   * Resolve a field reference (the raw text inside `{…}`: an id or a name).
   * Return `undefined` for unknown references (evaluates to an error).
   */
  getField?: (ref: string) => RuntimeValue | undefined;
  /** Legacy resolution: field name → slot, read from `cells`. */
  fieldNameToSlot?: Record<string, string>;
  cells?: Record<string, unknown>;
  /** Current record id (for RECORD_ID). */
  recordId?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  /** Clock override for tests (TODAY/NOW). */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Coercions
// ---------------------------------------------------------------------------

export function isBlank(v: RuntimeValue | undefined): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.every(isBlank));
}

function flatten(v: RuntimeValue | undefined): RuntimeValue[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return [v];
  return v.flatMap((x) => flatten(x));
}

const NUMERIC_RE = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

function isNumericString(v: unknown): boolean {
  return typeof v === "string" && NUMERIC_RE.test(v);
}

function toNumber(v: RuntimeValue | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) {
    const flat = flatten(v).filter((x) => !isBlank(x));
    if (flat.length === 0) return 0;
    if (flat.length === 1) return toNumber(flat[0]);
    throw new FormulaEvalError("Cannot use a list of values as a number");
  }
  if (isNumericString(v)) return Number(v);
  const cleaned = v.replace(/[,$€£%\s]/g, "");
  if (NUMERIC_RE.test(cleaned)) return Number(cleaned);
  throw new FormulaEvalError(`"${v}" is not a number`);
}

function dateToIso(d: Date): string {
  return d.toISOString();
}

function toText(v: RuntimeValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)));
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Date) return dateToIso(v);
  return flatten(v)
    .filter((x) => !isBlank(x))
    .map((x) => toText(x))
    .join(", ");
}

function truthy(v: RuntimeValue | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (v instanceof Date) return true;
  return flatten(v).some((x) => truthy(x));
}

function parseDate(v: RuntimeValue | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (Array.isArray(v)) {
    const f = flatten(v).filter((x) => !isBlank(x));
    return f.length === 1 ? parseDate(f[0]) : null;
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return new Date(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2])));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function requireDate(v: RuntimeValue | undefined, fn: string): Date | null {
  if (isBlank(v)) return null;
  const d = parseDate(v);
  if (!d) throw new FormulaEvalError(`${fn}: "${toText(v)}" is not a valid date`);
  return d;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

type Unit = "ms" | "s" | "m" | "h" | "d" | "w" | "M" | "Q" | "y";

function parseUnit(raw: RuntimeValue | undefined, def: Unit): Unit {
  if (raw === undefined || raw === null || raw === "") return def;
  const s = toText(raw).trim();
  const map: Record<string, Unit> = {
    ms: "ms", millisecond: "ms", milliseconds: "ms",
    s: "s", second: "s", seconds: "s",
    m: "m", minute: "m", minutes: "m",
    h: "h", hour: "h", hours: "h",
    d: "d", day: "d", days: "d",
    w: "w", week: "w", weeks: "w",
    M: "M", month: "M", months: "M",
    Q: "Q", quarter: "Q", quarters: "Q",
    y: "y", year: "y", years: "y",
  };
  const u = map[s] ?? map[s.toLowerCase()];
  if (!u) throw new FormulaEvalError(`Unknown date unit "${s}"`);
  return u;
}

const UNIT_MS: Partial<Record<Unit, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

function dateAdd(d: Date, n: number, unit: Unit): Date {
  if (unit === "M") return addMonths(d, n);
  if (unit === "Q") return addMonths(d, n * 3);
  if (unit === "y") return addMonths(d, n * 12);
  return new Date(d.getTime() + n * UNIT_MS[unit]!);
}

function monthDiff(a: Date, b: Date): number {
  // Whole months from b to a (truncated toward zero).
  let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  const anchor = addMonths(b, months);
  if (months > 0 && anchor.getTime() > a.getTime()) months--;
  else if (months < 0 && anchor.getTime() < a.getTime()) months++;
  return months;
}

function dateDiff(a: Date, b: Date, unit: Unit): number {
  if (unit === "M") return monthDiff(a, b);
  if (unit === "Q") return Math.trunc(monthDiff(a, b) / 3);
  if (unit === "y") return Math.trunc(monthDiff(a, b) / 12);
  return Math.trunc((a.getTime() - b.getTime()) / UNIT_MS[unit]!);
}

function startOf(d: Date, unit: Unit): number {
  switch (unit) {
    case "y":
      return Date.UTC(d.getUTCFullYear(), 0, 1);
    case "Q":
      return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
    case "M":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case "w": {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return day - d.getUTCDay() * 86_400_000;
    }
    case "d":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case "h":
      return Math.floor(d.getTime() / 3_600_000) * 3_600_000;
    case "m":
      return Math.floor(d.getTime() / 60_000) * 60_000;
    case "s":
      return Math.floor(d.getTime() / 1000) * 1000;
    default:
      return d.getTime();
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

export function formatDateTime(d: Date, pattern: string): string {
  const presets: Record<string, string> = {
    L: "MM/DD/YYYY",
    LL: "MMMM D, YYYY",
    LLL: "MMMM D, YYYY h:mm A",
    LLLL: "dddd, MMMM D, YYYY h:mm A",
    l: "M/D/YYYY",
    LT: "h:mm A",
    LTS: "h:mm:ss A",
  };
  const p = presets[pattern] ?? pattern;
  const tokenRe = /\[([^\]]*)]|YYYY|YY|MMMM|MMM|MM|M|DDDD|Do|DD|D|dddd|ddd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z|X|x|Q|wo|ww|w/g;
  const Y = d.getUTCFullYear();
  const Mo = d.getUTCMonth();
  const D = d.getUTCDate();
  const H = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const se = d.getUTCSeconds();
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return p.replace(tokenRe, (tok, lit: string | undefined) => {
    if (lit !== undefined) return lit;
    switch (tok) {
      case "YYYY": return String(Y);
      case "YY": return pad(Y % 100);
      case "MMMM": return MONTHS[Mo]!;
      case "MMM": return MONTHS[Mo]!.slice(0, 3);
      case "MM": return pad(Mo + 1);
      case "M": return String(Mo + 1);
      case "DDDD": {
        const doy = Math.floor((Date.UTC(Y, Mo, D) - Date.UTC(Y, 0, 1)) / 86_400_000) + 1;
        return pad(doy, 3);
      }
      case "Do": return ordinal(D);
      case "DD": return pad(D);
      case "D": return String(D);
      case "dddd": return DAYS[d.getUTCDay()]!;
      case "ddd": return DAYS[d.getUTCDay()]!.slice(0, 3);
      case "d": return String(d.getUTCDay());
      case "HH": return pad(H);
      case "H": return String(H);
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "mm": return pad(mi);
      case "m": return String(mi);
      case "ss": return pad(se);
      case "s": return String(se);
      case "SSS": return pad(d.getUTCMilliseconds(), 3);
      case "A": return H < 12 ? "AM" : "PM";
      case "a": return H < 12 ? "am" : "pm";
      case "ZZ": return "+0000";
      case "Z": return "+00:00";
      case "X": return String(Math.floor(d.getTime() / 1000));
      case "x": return String(d.getTime());
      case "Q": return String(Math.floor(Mo / 3) + 1);
      case "wo": return ordinal(isoWeek(d));
      case "ww": return pad(isoWeek(d));
      case "w": return String(isoWeek(d));
      default: return tok;
    }
  });
}

function parseWithFormat(s: string, fmt: string): Date | null {
  // Build a regex from the format's numeric tokens.
  const order: string[] = [];
  const re = fmt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(
    /YYYY|YY|MM|M|DD|D|HH|H|hh|h|mm|ss|A|a/g,
    (tok) => {
      order.push(tok);
      if (tok === "YYYY") return "(\\d{4})";
      if (tok === "A" || tok === "a") return "([AaPp][Mm])";
      return "(\\d{1,2})";
    },
  );
  const m = new RegExp(`^${re}$`).exec(s.trim());
  if (!m) return null;
  let y = 1970, mo = 1, d = 1, h = 0, mi = 0, se = 0;
  let pm: boolean | null = null;
  order.forEach((tok, i) => {
    const v = m[i + 1]!;
    switch (tok) {
      case "YYYY": y = Number(v); break;
      case "YY": y = 2000 + Number(v); break;
      case "MM": case "M": mo = Number(v); break;
      case "DD": case "D": d = Number(v); break;
      case "HH": case "H": case "hh": case "h": h = Number(v); break;
      case "mm": mi = Number(v); break;
      case "ss": se = Number(v); break;
      case "A": case "a": pm = v.toLowerCase() === "pm"; break;
    }
  });
  if (pm === true && h < 12) h += 12;
  if (pm === false && h === 12) h = 0;
  const out = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return Number.isNaN(out.getTime()) ? null : out;
}

function workdayAdd(start: Date, days: number, holidays: Set<string>): Date {
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const step = days >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.trunc(days));
  while (remaining > 0) {
    d = new Date(d.getTime() + step * 86_400_000);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidays.has(d.toISOString().slice(0, 10))) remaining--;
  }
  return d;
}

function workdayDiff(a: Date, b: Date, holidays: Set<string>): number {
  let s = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  let e = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  const sign = e >= s ? 1 : -1;
  if (sign < 0) [s, e] = [e, s];
  let count = 0;
  for (let t = s; t <= e; t += 86_400_000) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidays.has(d.toISOString().slice(0, 10))) count++;
  }
  return sign * count;
}

function holidaySet(v: RuntimeValue | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of toText(v).split(",")) {
    const d = parseDate(part.trim());
    if (d) out.add(d.toISOString().slice(0, 10));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function scalarize(v: RuntimeValue): RuntimeValue {
  if (!Array.isArray(v)) return v;
  const f = flatten(v);
  if (f.length === 0) return null;
  if (f.length === 1) return f[0]!;
  return toText(v);
}

function compare(op: string, lRaw: RuntimeValue, rRaw: RuntimeValue): boolean {
  const l = scalarize(lRaw);
  const r = scalarize(rRaw);
  let cmp: number;
  if (l instanceof Date || r instanceof Date) {
    const a = parseDate(l);
    const b = parseDate(r);
    if (!a || !b) {
      if (op === "=") return false;
      if (op === "!=") return true;
      return false;
    }
    cmp = a.getTime() - b.getTime();
  } else if (
    (typeof l === "number" || typeof r === "number" || typeof l === "boolean" || typeof r === "boolean") &&
    (l === null || typeof l === "number" || typeof l === "boolean" || isNumericString(l)) &&
    (r === null || typeof r === "number" || typeof r === "boolean" || isNumericString(r))
  ) {
    if ((op === "=" || op === "!=") && (l === null) !== (r === null)) {
      // BLANK() equals 0 / false in Airtable.
      const other = l === null ? r : l;
      const eq = toNumber(other) === 0;
      return op === "=" ? eq : !eq;
    }
    cmp = toNumber(l) - toNumber(r);
  } else {
    const a = toText(l);
    const b = toText(r);
    if (op === "=" || op === "!=") {
      const eq = a === b;
      return op === "=" ? eq : !eq;
    }
    cmp = a < b ? -1 : a > b ? 1 : 0;
  }
  switch (op) {
    case "=": return cmp === 0;
    case "!=": return cmp !== 0;
    case "<": return cmp < 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case ">=": return cmp >= 0;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function resolveField(name: string, ctx: FormulaContext): RuntimeValue {
  if (ctx.getField) {
    const v = ctx.getField(name);
    if (v === undefined) throw new FormulaEvalError(`Unknown field {${name}}`);
    return v;
  }
  if (ctx.fieldNameToSlot && ctx.cells) {
    const slot = ctx.fieldNameToSlot[name];
    if (slot === undefined) throw new FormulaEvalError(`Unknown field {${name}}`);
    const raw = ctx.cells[slot];
    return raw === undefined ? null : (raw as RuntimeValue);
  }
  throw new FormulaEvalError(`Unknown field {${name}}`);
}

function evalAst(ast: FormulaAst, ctx: FormulaContext): RuntimeValue {
  switch (ast.kind) {
    case "number":
      return ast.value;
    case "string":
      return ast.value;
    case "boolean":
      return ast.value;
    case "blank":
      return null;
    case "field":
      return resolveField(ast.name, ctx);
    case "unary": {
      const v = evalAst(ast.expr, ctx);
      if (ast.op === "not") return !truthy(v);
      if (ast.op === "pos") return toNumber(v);
      return -toNumber(v);
    }
    case "binary": {
      const l = evalAst(ast.left, ctx);
      const r = evalAst(ast.right, ctx);
      switch (ast.op) {
        case "&":
          return toText(l) + toText(r);
        case "+": {
          const ls = scalarize(l);
          const rs = scalarize(r);
          if (ls instanceof Date && !(rs instanceof Date)) return new Date(ls.getTime() + toNumber(rs) * 1000);
          if (
            (typeof ls === "string" && ls !== "" && !isNumericString(ls)) ||
            (typeof rs === "string" && rs !== "" && !isNumericString(rs))
          ) {
            return toText(ls) + toText(rs);
          }
          if (isBlank(ls) && isBlank(rs)) return null;
          return toNumber(ls) + toNumber(rs);
        }
        case "-": {
          const ls = scalarize(l);
          const rs = scalarize(r);
          if (ls instanceof Date && rs instanceof Date) return (ls.getTime() - rs.getTime()) / 1000;
          if (isBlank(ls) && isBlank(rs)) return null;
          return toNumber(ls) - toNumber(rs);
        }
        case "*":
          if (isBlank(l) && isBlank(r)) return null;
          return toNumber(l) * toNumber(r);
        case "/": {
          if (isBlank(l) && isBlank(r)) return null;
          const denom = toNumber(r);
          if (denom === 0) throw new FormulaEvalError("#DIV/0! Division by zero");
          return toNumber(l) / denom;
        }
        default:
          return compare(ast.op, l, r);
      }
    }
    case "call":
      return evalCall(ast.name.toUpperCase(), ast.args, ctx);
    default:
      return null;
  }
}

function argCount(name: string, args: FormulaAst[], min: number, max = Infinity): void {
  if (args.length < min || args.length > max) {
    const range = max === min ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`;
    throw new FormulaEvalError(`${name}() expects ${range} argument${min === 1 && max === 1 ? "" : "s"}`);
  }
}

function roundHalfAway(n: number, digits: number): number {
  const f = 10 ** digits;
  const x = Math.abs(n) * f;
  const r = Math.round(Number(x.toPrecision(15))) / f;
  return n < 0 ? -r : r;
}

function regexOf(pattern: RuntimeValue | undefined, flags = ""): RegExp {
  try {
    return new RegExp(toText(pattern), flags);
  } catch {
    throw new FormulaEvalError(`Invalid regular expression "${toText(pattern)}"`);
  }
}

const KNOWN_FUNCTIONS = new Set<string>();

function evalCall(name: string, argAsts: FormulaAst[], ctx: FormulaContext): RuntimeValue {
  // Lazy / special forms first.
  switch (name) {
    case "IF": {
      argCount(name, argAsts, 2, 3);
      const cond = evalAst(argAsts[0]!, ctx);
      if (truthy(cond)) return evalAst(argAsts[1]!, ctx);
      return argAsts[2] ? evalAst(argAsts[2], ctx) : null;
    }
    case "SWITCH": {
      argCount(name, argAsts, 2);
      const expr = evalAst(argAsts[0]!, ctx);
      let i = 1;
      for (; i + 1 < argAsts.length; i += 2) {
        const when = evalAst(argAsts[i]!, ctx);
        if ((isBlank(expr) && isBlank(when)) || compare("=", expr, when)) return evalAst(argAsts[i + 1]!, ctx);
      }
      return i < argAsts.length ? evalAst(argAsts[i]!, ctx) : null;
    }
    case "ISERROR": {
      argCount(name, argAsts, 1, 1);
      try {
        evalAst(argAsts[0]!, ctx);
        return false;
      } catch (e) {
        if (e instanceof FormulaEvalError) return true;
        throw e;
      }
    }
    case "IFERROR": {
      argCount(name, argAsts, 2, 2);
      try {
        return evalAst(argAsts[0]!, ctx);
      } catch (e) {
        if (e instanceof FormulaEvalError) return evalAst(argAsts[1]!, ctx);
        throw e;
      }
    }
    default:
      break;
  }

  const a = argAsts.map((x) => evalAst(x, ctx));
  const s0 = () => toText(a[0]);
  const n = (i: number, def?: number) => (a[i] === undefined ? (def ?? 0) : toNumber(a[i]));
  const nums = () => flatten(a).filter((v) => !isBlank(v)).map((v) => toNumber(v));
  const now = ctx.now ?? new Date();

  switch (name) {
    // ---- logical ----
    case "AND":
      argCount(name, argAsts, 1);
      return flatten(a).every((v) => truthy(v));
    case "OR":
      argCount(name, argAsts, 1);
      return flatten(a).some((v) => truthy(v));
    case "XOR":
      argCount(name, argAsts, 1);
      return flatten(a).filter((v) => truthy(v)).length % 2 === 1;
    case "NOT":
      argCount(name, argAsts, 1, 1);
      return !truthy(a[0]);
    case "BLANK":
      return null;
    case "TRUE":
      return true;
    case "FALSE":
      return false;
    case "ERROR":
      throw new FormulaEvalError(a.length ? toText(a[0]) : "ERROR()");
    case "ISBLANK":
      argCount(name, argAsts, 1, 1);
      return isBlank(a[0]);

    // ---- numeric ----
    case "ABS":
      argCount(name, argAsts, 1, 1);
      return Math.abs(n(0));
    case "ROUND":
      argCount(name, argAsts, 1, 2);
      return roundHalfAway(n(0), Math.trunc(n(1, 0)));
    case "ROUNDUP": {
      argCount(name, argAsts, 1, 2);
      const f = 10 ** Math.trunc(n(1, 0));
      const v = n(0);
      return (v < 0 ? -Math.ceil(Number((-v * f).toPrecision(15))) : Math.ceil(Number((v * f).toPrecision(15)))) / f;
    }
    case "ROUNDDOWN": {
      argCount(name, argAsts, 1, 2);
      const f = 10 ** Math.trunc(n(1, 0));
      return Math.trunc(Number((n(0) * f).toPrecision(15))) / f;
    }
    case "FLOOR": {
      argCount(name, argAsts, 1, 2);
      const sig = n(1, 1) || 1;
      return Math.floor(n(0) / sig) * sig;
    }
    case "CEILING": {
      argCount(name, argAsts, 1, 2);
      const sig = n(1, 1) || 1;
      return Math.ceil(n(0) / sig) * sig;
    }
    case "INT":
      argCount(name, argAsts, 1, 1);
      return Math.floor(n(0));
    case "EVEN": {
      const v = n(0);
      const r = Math.ceil(Math.abs(v) / 2) * 2;
      return v < 0 ? -r : r;
    }
    case "ODD": {
      const v = n(0);
      let r = Math.ceil(Math.abs(v));
      if (r % 2 === 0) r += 1;
      return v < 0 ? -r : r;
    }
    case "MOD": {
      argCount(name, argAsts, 2, 2);
      const d = n(1);
      if (d === 0) throw new FormulaEvalError("#DIV/0! Division by zero");
      const m = n(0) % d;
      return m !== 0 && Math.sign(m) !== Math.sign(d) ? m + d : m;
    }
    case "POWER":
      argCount(name, argAsts, 2, 2);
      return n(0) ** n(1);
    case "SQRT": {
      const v = n(0);
      if (v < 0) throw new FormulaEvalError("SQRT of a negative number");
      return Math.sqrt(v);
    }
    case "EXP":
      return Math.exp(n(0));
    case "LOG": {
      const v = n(0);
      const base = a[1] === undefined ? 10 : n(1);
      if (v <= 0 || base <= 0 || base === 1) throw new FormulaEvalError("LOG of a non-positive number");
      return Math.log(v) / Math.log(base);
    }
    case "LN": {
      const v = n(0);
      if (v <= 0) throw new FormulaEvalError("LN of a non-positive number");
      return Math.log(v);
    }
    case "SIGN":
      return Math.sign(n(0));
    case "MIN": {
      const v = nums();
      return v.length ? Math.min(...v) : 0;
    }
    case "MAX": {
      const v = nums();
      return v.length ? Math.max(...v) : 0;
    }
    case "SUM":
      return nums().reduce((x, y) => x + y, 0);
    case "AVERAGE": {
      const v = nums();
      return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0;
    }
    case "COUNT":
      return flatten(a).filter((v) => typeof v === "number" || isNumericString(v)).length;
    case "COUNTA":
      return flatten(a).filter((v) => !isBlank(v)).length;
    case "COUNTALL":
      return Array.isArray(a[0]) && a.length === 1 ? (a[0] as RuntimeValue[]).length : a.length;
    case "VALUE": {
      argCount(name, argAsts, 1, 1);
      if (isBlank(a[0])) return null;
      return toNumber(a[0]);
    }

    // ---- text ----
    case "CONCATENATE":
      return a.map((v) => toText(v)).join("");
    case "LEFT":
      argCount(name, argAsts, 1, 2);
      return s0().slice(0, Math.max(0, Math.trunc(n(1, 1))));
    case "RIGHT": {
      argCount(name, argAsts, 1, 2);
      const len = Math.max(0, Math.trunc(n(1, 1)));
      return len === 0 ? "" : s0().slice(-len);
    }
    case "MID": {
      argCount(name, argAsts, 3, 3);
      const start = Math.max(1, Math.trunc(n(1)));
      return s0().substr(start - 1, Math.max(0, Math.trunc(n(2))));
    }
    case "LEN":
      return s0().length;
    case "LOWER":
      return s0().toLowerCase();
    case "UPPER":
      return s0().toUpperCase();
    case "TRIM":
      return s0().trim().replace(/\s+/g, " ");
    case "T":
      return typeof a[0] === "string" ? a[0] : "";
    case "FIND": {
      argCount(name, argAsts, 2, 3);
      const start = a[2] === undefined ? 0 : Math.max(0, Math.trunc(n(2)) - 1);
      const idx = toText(a[1]).indexOf(s0(), start);
      return idx + 1;
    }
    case "SEARCH": {
      argCount(name, argAsts, 2, 3);
      const start = a[2] === undefined ? 0 : Math.max(0, Math.trunc(n(2)) - 1);
      const idx = toText(a[1]).toLowerCase().indexOf(s0().toLowerCase(), start);
      return idx < 0 ? null : idx + 1;
    }
    case "SUBSTITUTE": {
      argCount(name, argAsts, 3, 4);
      const str = s0();
      const search = toText(a[1]);
      const repl = toText(a[2]);
      if (!search) return str;
      if (a[3] === undefined) return str.split(search).join(repl);
      const nth = Math.trunc(n(3));
      let idx = -1;
      for (let k = 0; k < nth; k++) {
        idx = str.indexOf(search, idx + 1);
        if (idx < 0) return str;
      }
      return str.slice(0, idx) + repl + str.slice(idx + search.length);
    }
    case "REPLACE": {
      argCount(name, argAsts, 4, 4);
      const idx = Math.max(1, Math.trunc(n(1))) - 1;
      return s0().slice(0, idx) + toText(a[3]) + s0().slice(idx + Math.max(0, Math.trunc(n(2))));
    }
    case "REPT":
      argCount(name, argAsts, 2, 2);
      return s0().repeat(Math.max(0, Math.min(10_000, Math.trunc(n(1)))));
    case "ENCODE_URL_COMPONENT":
      return encodeURIComponent(s0());
    case "REGEX_MATCH":
      argCount(name, argAsts, 2, 2);
      return regexOf(a[1]).test(s0());
    case "REGEX_EXTRACT": {
      argCount(name, argAsts, 2, 2);
      const m = regexOf(a[1]).exec(s0());
      return m ? m[0] : null;
    }
    case "REGEX_REPLACE":
      argCount(name, argAsts, 3, 3);
      return s0().replace(regexOf(a[1], "g"), toText(a[2]));

    // ---- arrays ----
    case "ARRAYJOIN": {
      const sep = a[1] === undefined ? ", " : toText(a[1]);
      return flatten(a[0]).filter((v) => !isBlank(v)).map((v) => toText(v)).join(sep);
    }
    case "ARRAYUNIQUE": {
      const out: RuntimeValue[] = [];
      const seen = new Set<string>();
      for (const v of flatten(a[0])) {
        const k = `${typeof v}:${toText(v)}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push(v);
        }
      }
      return out;
    }
    case "ARRAYCOMPACT":
      return flatten(a[0]).filter((v) => !isBlank(v));
    case "ARRAYFLATTEN":
      return flatten(a[0]);
    case "ARRAYSLICE": {
      const arr = flatten(a[0]);
      const start = Math.trunc(n(1, 1));
      const s = start > 0 ? start - 1 : arr.length + start;
      if (a[2] === undefined) return arr.slice(s);
      const end = Math.trunc(n(2));
      return arr.slice(s, end >= 0 ? end : arr.length + end + 1);
    }

    // ---- dates ----
    case "TODAY":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case "NOW":
      return new Date(now.getTime());
    case "CREATED_TIME":
      return ctx.createdTime ? parseDate(ctx.createdTime) : null;
    case "LAST_MODIFIED_TIME":
      return ctx.lastModifiedTime ? parseDate(ctx.lastModifiedTime) : null;
    case "RECORD_ID":
      return ctx.recordId ?? null;
    case "DATEADD": {
      argCount(name, argAsts, 3, 3);
      const d = requireDate(a[0], name);
      if (!d) return null;
      return dateAdd(d, n(1), parseUnit(a[2], "d"));
    }
    case "DATETIME_DIFF": {
      argCount(name, argAsts, 2, 3);
      const d1 = requireDate(a[0], name);
      const d2 = requireDate(a[1], name);
      if (!d1 || !d2) return null;
      return dateDiff(d1, d2, parseUnit(a[2], "s"));
    }
    case "DATETIME_FORMAT": {
      argCount(name, argAsts, 1, 2);
      const d = requireDate(a[0], name);
      if (!d) return null;
      return a[1] === undefined ? d.toISOString() : formatDateTime(d, toText(a[1]));
    }
    case "DATETIME_PARSE": {
      argCount(name, argAsts, 1, 3);
      if (isBlank(a[0])) return null;
      const d = a[1] !== undefined && toText(a[1]) ? parseWithFormat(s0(), toText(a[1])) ?? parseDate(a[0]) : parseDate(a[0]);
      if (!d) throw new FormulaEvalError(`DATETIME_PARSE: cannot parse "${s0()}"`);
      return d;
    }
    case "DATESTR": {
      const d = requireDate(a[0], name);
      return d ? d.toISOString().slice(0, 10) : null;
    }
    case "TIMESTR": {
      const d = requireDate(a[0], name);
      return d ? d.toISOString().slice(11, 19) : null;
    }
    case "YEAR": {
      const d = requireDate(a[0], name);
      return d ? d.getUTCFullYear() : null;
    }
    case "MONTH": {
      const d = requireDate(a[0], name);
      return d ? d.getUTCMonth() + 1 : null;
    }
    case "DAY": {
      const d = requireDate(a[0], name);
      return d ? d.getUTCDate() : null;
    }
    case "HOUR": {
      const d = requireDate(a[0], name);
      return d ? d.getUTCHours() : null;
    }
    case "MINUTE": {
      const d = requireDate(a[0], name);
      return d ? d.getUTCMinutes() : null;
    }
    case "SECOND": {
      const d = requireDate(a[0], name);
      return d ? d.getUTCSeconds() : null;
    }
    case "WEEKDAY": {
      const d = requireDate(a[0], name);
      if (!d) return null;
      const startMonday = toText(a[1]).toLowerCase() === "monday";
      return startMonday ? (d.getUTCDay() + 6) % 7 : d.getUTCDay();
    }
    case "WEEKNUM": {
      const d = requireDate(a[0], name);
      if (!d) return null;
      const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
      const offset = new Date(jan1).getUTCDay();
      const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - jan1) / 86_400_000);
      return Math.floor((doy + offset) / 7) + 1;
    }
    case "WORKDAY": {
      argCount(name, argAsts, 2, 3);
      const d = requireDate(a[0], name);
      if (!d) return null;
      return workdayAdd(d, n(1), holidaySet(a[2]));
    }
    case "WORKDAY_DIFF": {
      argCount(name, argAsts, 2, 3);
      const d1 = requireDate(a[0], name);
      const d2 = requireDate(a[1], name);
      if (!d1 || !d2) return null;
      return workdayDiff(d1, d2, holidaySet(a[2]));
    }
    case "IS_BEFORE":
    case "IS_AFTER": {
      argCount(name, argAsts, 2, 2);
      const d1 = requireDate(a[0], name);
      const d2 = requireDate(a[1], name);
      if (!d1 || !d2) return false;
      return name === "IS_BEFORE" ? d1.getTime() < d2.getTime() : d1.getTime() > d2.getTime();
    }
    case "IS_SAME": {
      argCount(name, argAsts, 2, 3);
      const d1 = requireDate(a[0], name);
      const d2 = requireDate(a[1], name);
      if (!d1 || !d2) return false;
      const unit = parseUnit(a[2], "ms");
      return startOf(d1, unit) === startOf(d2, unit);
    }
    case "SET_TIMEZONE":
    case "SET_LOCALE":
      return a[0] ?? null;
    case "TONOW":
    case "FROMNOW": {
      const d = requireDate(a[0], name);
      if (!d) return null;
      return Math.abs(dateDiff(now, d, "d"));
    }
    default:
      throw new FormulaEvalError(`Unknown function ${name}()`);
  }
}

/** Every function name the evaluator understands (for editor autocomplete / validation). */
export const FORMULA_FUNCTIONS: readonly string[] = [
  "IF", "SWITCH", "AND", "OR", "XOR", "NOT", "BLANK", "TRUE", "FALSE", "ERROR", "ISERROR", "IFERROR", "ISBLANK",
  "ABS", "ROUND", "ROUNDUP", "ROUNDDOWN", "FLOOR", "CEILING", "INT", "EVEN", "ODD", "MOD", "POWER", "SQRT", "EXP",
  "LOG", "LN", "SIGN", "MIN", "MAX", "SUM", "AVERAGE", "COUNT", "COUNTA", "COUNTALL", "VALUE",
  "CONCATENATE", "LEFT", "RIGHT", "MID", "LEN", "LOWER", "UPPER", "TRIM", "T", "FIND", "SEARCH", "SUBSTITUTE",
  "REPLACE", "REPT", "ENCODE_URL_COMPONENT", "REGEX_MATCH", "REGEX_EXTRACT", "REGEX_REPLACE",
  "ARRAYJOIN", "ARRAYUNIQUE", "ARRAYCOMPACT", "ARRAYFLATTEN", "ARRAYSLICE",
  "TODAY", "NOW", "CREATED_TIME", "LAST_MODIFIED_TIME", "RECORD_ID", "DATEADD", "DATETIME_DIFF",
  "DATETIME_FORMAT", "DATETIME_PARSE", "DATESTR", "TIMESTR", "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND",
  "WEEKDAY", "WEEKNUM", "WORKDAY", "WORKDAY_DIFF", "IS_BEFORE", "IS_AFTER", "IS_SAME", "SET_TIMEZONE",
  "SET_LOCALE", "TONOW", "FROMNOW",
];
for (const f of FORMULA_FUNCTIONS) KNOWN_FUNCTIONS.add(f);

export function isKnownFunction(name: string): boolean {
  return KNOWN_FUNCTIONS.has(name.toUpperCase());
}

/** Convert a runtime value to the stored/output representation. */
export function toOutputValue(v: RuntimeValue): FormulaValue {
  if (v instanceof Date) return dateToIso(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new FormulaEvalError("#NUM! Result is not a finite number");
    return Number(v.toPrecision(15));
  }
  if (Array.isArray(v)) return flatten(v).map((x) => toOutputValue(x));
  return v;
}

/** Evaluate; throws FormulaEvalError on formula errors. */
export function evaluateFormulaRaw(ast: FormulaAst, ctx: FormulaContext): RuntimeValue {
  return evalAst(ast, ctx);
}

/** Evaluate to an output value; throws FormulaEvalError on formula errors. */
export function evaluateFormula(ast: FormulaAst, ctx: FormulaContext): FormulaValue {
  return toOutputValue(evalAst(ast, ctx));
}

/** Throws FormulaEvalError for calls to unknown functions or bad arities found statically. */
export function validateFormulaAst(ast: FormulaAst): void {
  const walk = (node: FormulaAst): void => {
    if (node.kind === "call") {
      if (!KNOWN_FUNCTIONS.has(node.name.toUpperCase())) {
        throw new FormulaEvalError(`Unknown function ${node.name}()`);
      }
      node.args.forEach(walk);
    } else if (node.kind === "unary") walk(node.expr);
    else if (node.kind === "binary") {
      walk(node.left);
      walk(node.right);
    }
  };
  walk(ast);
}
