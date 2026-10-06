import { filterKindForField, isUntypedFormula, normalizeFieldType, type FilterKind } from "./kinds.js";
import { selectOptionsOf } from "./prepare.js";

/**
 * Typed SQL value expressions over `data.records` rows (alias `r` by default).
 * Every expression is total: malformed stored values yield NULL, never a cast
 * error. Shared by the filter compiler, the sort planner (`@tabula/query`) and
 * the server's group queries.
 */

export interface SqlLinkInfo {
  relationId: string;
  /** Side of the relation the field sits on. */
  side: "a" | "b";
  peerTableId: string;
  /** Primary field of the peer table (for names). */
  peerPrimary?: SqlFieldInfo | null | undefined;
}

export interface SqlFieldInfo {
  /** Raw uuid. */
  id: string;
  slot: number;
  type: string;
  config: Record<string, unknown>;
  isComputed: boolean;
  link?: SqlLinkInfo | null | undefined;
}

export type SqlKeyType = "text" | "float8" | "int8" | "int4" | "bool" | "timestamptz";

/** Positional parameter collector (`$n::cast`). */
export class SqlParams {
  readonly values: unknown[];
  constructor(values: unknown[] = []) {
    this.values = values;
  }
  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return cast ? `$${this.values.length}::${cast}` : `$${this.values.length}`;
  }
}

const NUM_RE = `'^[-+]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][-+]?[0-9]{1,2})?$'`;
const ISO_RE = `'^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([T ]([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]{1,6})?)?)?(Z|[+-]([01][0-9]|2[0-3])(:?[0-5][0-9])?)?$'`;
const DATE_PREFIX_RE = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}'`;

export function kindOf(f: SqlFieldInfo): FilterKind {
  return filterKindForField(f.type, f.config);
}

function slotKey(f: SqlFieldInfo): string {
  const n = Math.trunc(Number(f.slot));
  if (!Number.isFinite(n)) throw new Error("bad slot");
  return String(n);
}

/** Meta column for meta field types, else null. */
export function metaColumn(f: SqlFieldInfo, a: string): { expr: string; type: SqlKeyType } | null {
  switch (normalizeFieldType(f.type)) {
    case "autonumber":
      return { expr: `${a}.row_number`, type: "int8" };
    case "created_time":
      return { expr: `${a}.created_at`, type: "timestamptz" };
    case "modified_time":
      return { expr: `${a}.updated_at`, type: "timestamptz" };
    case "created_by":
      return { expr: `${a}.created_by`, type: "text" };
    case "modified_by":
      return { expr: `COALESCE(${a}.updated_by, ${a}.created_by)`, type: "text" };
    default:
      return null;
  }
}

/** The stored jsonb value (computed values unwrapped from legacy `{value,status}`). */
export function jsonExpr(f: SqlFieldInfo, a: string): string {
  const k = slotKey(f);
  if (f.isComputed) {
    const raw = `${a}.computed->'${k}'`;
    return `(CASE WHEN jsonb_typeof(${raw}) = 'object' AND (${raw}) ? 'status' THEN ${raw}->'value' ELSE ${raw} END)`;
  }
  return `${a}.cells->'${k}'`;
}

/** jsonb array view of a value (scalars wrapped, null → []). */
export function arrayExpr(j: string): string {
  return `(CASE jsonb_typeof(${j}) WHEN 'array' THEN ${j} WHEN 'null' THEN '[]'::jsonb WHEN 'string' THEN (CASE WHEN ${j} = '""'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(${j}) END) WHEN 'number' THEN jsonb_build_array(${j}) WHEN 'boolean' THEN jsonb_build_array(${j}) WHEN 'object' THEN jsonb_build_array(${j}) ELSE '[]'::jsonb END)`;
}

/** Text of a jsonb value; arrays joined with ", " (mirrors evaluator `textOf`). */
export function textOfJson(j: string): string {
  return `(CASE jsonb_typeof(${j})
    WHEN 'string' THEN ${j}#>>'{}'
    WHEN 'number' THEN ${j}#>>'{}'
    WHEN 'boolean' THEN ${j}#>>'{}'
    WHEN 'object' THEN COALESCE(${j}->>'name', ${j}->>'text', ${j}->>'filename')
    WHEN 'array' THEN (SELECT NULLIF(string_agg(x.t, ', ' ORDER BY x.o), '') FROM (
      SELECT e.o, (CASE jsonb_typeof(e.v) WHEN 'object' THEN COALESCE(e.v->>'name', e.v->>'text', e.v->>'filename') WHEN 'null' THEN NULL WHEN 'array' THEN NULL ELSE e.v#>>'{}' END) AS t
      FROM jsonb_array_elements(${j}) WITH ORDINALITY AS e(v, o)) x WHERE x.t IS NOT NULL AND x.t <> '')
    ELSE NULL END)`;
}

export function numOfJson(j: string): string {
  return `(CASE WHEN jsonb_typeof(${j}) = 'number' THEN (${j}#>>'{}')::float8 WHEN jsonb_typeof(${j}) = 'string' AND btrim(${j}#>>'{}') ~ ${NUM_RE} THEN btrim(${j}#>>'{}')::float8 END)`;
}

/** Safe text → timestamptz (NULL for malformed / impossible dates). */
export function tsOfText(s: string): string {
  return `(CASE WHEN ${s} ~ ${ISO_RE} AND substr(${s}, 9, 2)::int <= extract(day FROM (to_date(substr(${s}, 1, 7), 'YYYY-MM') + interval '1 month - 1 day'))::int THEN (${s})::timestamptz END)`;
}

export function textExpr(f: SqlFieldInfo, a: string): string {
  const m = metaColumn(f, a);
  if (m) return m.type === "timestamptz" ? `to_char(${m.expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` : `(${m.expr})::text`;
  return textOfJson(jsonExpr(f, a));
}

export function numExpr(f: SqlFieldInfo, a: string): string {
  const m = metaColumn(f, a);
  if (m && m.type === "int8") return `(${m.expr})::float8`;
  return numOfJson(jsonExpr(f, a));
}

/** `YYYY-MM-DD` text of a date-kind value (no time zone shift). */
export function dateExpr(f: SqlFieldInfo, a: string): string {
  const j = jsonExpr(f, a);
  return `(CASE WHEN jsonb_typeof(${j}) = 'string' AND (${j}#>>'{}') ~ ${DATE_PREFIX_RE} THEN left(${j}#>>'{}', 10) END)`;
}

/** timestamptz of a datetime-kind value. */
export function tsExpr(f: SqlFieldInfo, a: string): string {
  const m = metaColumn(f, a);
  if (m && m.type === "timestamptz") return m.expr;
  const j = jsonExpr(f, a);
  return `(CASE WHEN jsonb_typeof(${j}) = 'string' THEN ${tsOfText(`(${j}#>>'{}')`)} END)`;
}

/** Calendar date (`YYYY-MM-DD`) of a datetime value in a zone given as SQL expr. */
export function tsDateExpr(f: SqlFieldInfo, a: string, tzSql: string): string {
  return `to_char(${tsExpr(f, a)} AT TIME ZONE ${tzSql}, 'YYYY-MM-DD')`;
}

export function boolExpr(f: SqlFieldInfo, a: string): string {
  const j = jsonExpr(f, a);
  return `COALESCE(${j} IN ('true'::jsonb, '"true"'::jsonb, '1'::jsonb), false)`;
}

/** Single-select option id (first element if an array slipped in). */
export function selectIdExpr(f: SqlFieldInfo, a: string): string {
  const j = jsonExpr(f, a);
  return `NULLIF(CASE jsonb_typeof(${j}) WHEN 'string' THEN ${j}#>>'{}' WHEN 'array' THEN ${j}->>0 END, '')`;
}

/** Set of element ids of an array-valued field (select ids, user ids, attachment ids). */
export function elemIdsSql(f: SqlFieldInfo, a: string): string {
  return `(SELECT COALESCE(e.v->>'id', e.v#>>'{}') AS id, e.o FROM jsonb_array_elements(${arrayExpr(jsonExpr(f, a))}) WITH ORDINALITY AS e(v, o) WHERE jsonb_typeof(e.v) <> 'null')`;
}

/** Linked peer ids (+ order) of a link field, live peers only. */
export function linkPeersSql(f: SqlFieldInfo, a: string, p: SqlParams): string | null {
  const l = f.link;
  if (!l) return null;
  const self = l.side === "a" ? "a_record_id" : "b_record_id";
  const peer = l.side === "a" ? "b_record_id" : "a_record_id";
  const ord = l.side === "a" ? "a_order" : "b_order";
  return `(SELECT lk.${peer} AS id, lk.${ord} AS o, pt.cells, pt.computed, pt.row_number, pt.created_at, pt.updated_at, pt.created_by, pt.updated_by
    FROM data.record_links lk
    JOIN data.records pt ON pt.table_id = ${p.add(l.peerTableId, "uuid")} AND pt.id = lk.${peer} AND pt.deleted_at IS NULL
    WHERE lk.relation_id = ${p.add(l.relationId, "uuid")} AND lk.${self} = ${a}.id AND lk.deletion_batch_id IS NULL)`;
}

function userNameSql(idText: string): string {
  return `(SELECT COALESCE(NULLIF(u.display_name, ''), u.email) FROM core.users u WHERE ${idText} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND u.id = (${idText})::uuid)`;
}

/**
 * Display text (what a user sees): select labels, collaborator names, linked
 * record names. Used for search, link-name filters and text sorts.
 */
export function displayExpr(f: SqlFieldInfo, a: string, p: SqlParams, depth = 0): string {
  const kind = kindOf(f);
  switch (kind) {
    case "single_select":
    case "multi_select": {
      const opts = selectOptionsOf(f.config);
      const ids = p.add(opts.map((o) => o.id), "text[]");
      const labels = p.add(opts.map((o) => o.label), "text[]");
      const label = (x: string) =>
        `COALESCE((SELECT o.l FROM unnest(${ids}, ${labels}) AS o(i, l) WHERE o.i = ${x} LIMIT 1), ${x})`;
      if (kind === "single_select") return label(selectIdExpr(f, a));
      return `(SELECT NULLIF(string_agg(${label("s.id")}, ', ' ORDER BY s.o), '') FROM ${elemIdsSql(f, a)} s)`;
    }
    case "collaborator":
      return `(SELECT NULLIF(string_agg(${userNameSql("s.id")}, ', ' ORDER BY s.o), '') FROM ${elemIdsSql(f, a)} s)`;
    case "user": {
      const m = metaColumn(f, a);
      return m ? userNameSql(`(${m.expr})::text`) : "NULL";
    }
    case "link": {
      const peers = linkPeersSql(f, a, p);
      const prim = f.link?.peerPrimary;
      if (!peers || !prim || depth > 0) return "NULL";
      return `(SELECT NULLIF(string_agg(${displayExpr(prim, "pp", p, depth + 1)}, ', ' ORDER BY pp.o, pp.id), '') FROM ${peers} pp)`;
    }
    case "checkbox":
      return "NULL";
    case "attachment":
      return textOfJson(jsonExpr(f, a));
    default:
      return textExpr(f, a);
  }
}

/** True when the value is empty (mirrors evaluator `isEmptyFor`). */
export function emptyExpr(f: SqlFieldInfo, a: string, p: SqlParams): string {
  const kind = kindOf(f);
  switch (kind) {
    case "number":
      return `(${numExpr(f, a)} IS NULL)`;
    case "date":
      return `(${dateExpr(f, a)} IS NULL)`;
    case "datetime":
      return `(${tsExpr(f, a)} IS NULL)`;
    case "checkbox":
      return `(NOT ${boolExpr(f, a)})`;
    case "single_select":
      return `(${selectIdExpr(f, a)} IS NULL)`;
    case "multi_select":
    case "collaborator":
    case "attachment":
    case "array":
      return `(NOT EXISTS (SELECT 1 FROM ${elemIdsSql(f, a)} s WHERE s.id IS NOT NULL AND s.id <> ''))`;
    case "user": {
      const m = metaColumn(f, a);
      return m ? `(${m.expr} IS NULL)` : "TRUE";
    }
    case "link": {
      const peers = linkPeersSql(f, a, p);
      return peers ? `(NOT EXISTS (SELECT 1 FROM ${peers} pe))` : "TRUE";
    }
    default: {
      const t = textExpr(f, a);
      return `(${t} IS NULL OR ${t} = '')`;
    }
  }
}

export interface SortKeySql {
  expr: string;
  type: SqlKeyType;
}

/**
 * Typed sort keys for a field (one or more; compare left to right).
 * NULL = empty (callers order NULLS LAST).
 */
export function sortKeysFor(f: SqlFieldInfo, a: string, p: SqlParams): SortKeySql[] {
  const kind = kindOf(f);
  const m = metaColumn(f, a);
  switch (kind) {
    case "number":
      if (m) return [{ expr: m.expr, type: "int8" }];
      return [{ expr: numExpr(f, a), type: "float8" }];
    case "date":
      return [{ expr: dateExpr(f, a), type: "text" }];
    case "datetime":
      return [{ expr: tsExpr(f, a), type: "timestamptz" }];
    case "checkbox":
      return [{ expr: boolExpr(f, a), type: "bool" }];
    case "single_select":
    case "multi_select": {
      const opts = selectOptionsOf(f.config);
      const ids = p.add(opts.map((o) => o.id), "text[]");
      const labels = p.add(opts.map((o) => o.label), "text[]");
      const pos = (x: string) => `COALESCE(array_position(${ids}, ${x}), array_position(${labels}, ${x}))`;
      if (kind === "single_select") return [{ expr: pos(selectIdExpr(f, a)), type: "int4" }];
      return [{ expr: `(SELECT ${pos("s.id")} FROM ${elemIdsSql(f, a)} s ORDER BY s.o LIMIT 1)`, type: "int4" }];
    }
    case "collaborator":
      return [{ expr: `(SELECT lower(${userNameSql("s.id")}) FROM ${elemIdsSql(f, a)} s ORDER BY s.o LIMIT 1)`, type: "text" }];
    case "user":
      return [{ expr: `lower(${displayExpr(f, a, p)})`, type: "text" }];
    case "link": {
      const peers = linkPeersSql(f, a, p);
      const prim = f.link?.peerPrimary;
      if (!peers || !prim) return [{ expr: "NULL::text", type: "text" }];
      return [
        {
          expr: `(SELECT NULLIF(lower(${displayExpr(prim, "pp", p, 1)}), '') FROM ${peers} pp ORDER BY pp.o, pp.id LIMIT 1)`,
          type: "text",
        },
      ];
    }
    case "attachment":
      return [
        {
          expr: `(SELECT NULLIF(count(*), 0)::int FROM ${elemIdsSql(f, a)} s)`,
          type: "int4",
        },
      ];
    default: {
      const keys: SortKeySql[] = [];
      if (isUntypedFormula(f.type, f.config)) keys.push({ expr: numExpr(f, a), type: "float8" });
      keys.push({ expr: `NULLIF(lower(${textExpr(f, a)}), '')`, type: "text" });
      return keys;
    }
  }
}

/**
 * Group key (exact value) + its display-order sort key for GROUP BY.
 * The key is returned as jsonb so every kind groups uniformly.
 */
export function groupKeyFor(f: SqlFieldInfo, a: string, p: SqlParams): { key: string; sort: SortKeySql } {
  const kind = kindOf(f);
  const sort = sortKeysFor(f, a, p)[0] ?? { expr: "NULL::text", type: "text" as const };
  const m = metaColumn(f, a);
  switch (kind) {
    case "number":
      return { key: `to_jsonb(${m ? m.expr : numExpr(f, a)})`, sort };
    case "date":
      return { key: `to_jsonb(${dateExpr(f, a)})`, sort };
    case "datetime":
      return { key: `to_jsonb(${tsExpr(f, a)})`, sort };
    case "checkbox":
      return { key: `to_jsonb(${boolExpr(f, a)})`, sort };
    case "single_select":
      return { key: `to_jsonb(${selectIdExpr(f, a)})`, sort };
    case "multi_select":
    case "collaborator":
    case "attachment":
      return {
        key: `(SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_agg(s.id ORDER BY s.o) END FROM ${elemIdsSql(f, a)} s WHERE s.id <> '')`,
        sort,
      };
    case "user":
      return { key: m ? `to_jsonb((${m.expr})::text)` : "NULL::jsonb", sort };
    case "link": {
      const peers = linkPeersSql(f, a, p);
      return {
        key: peers ? `(SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_agg(pg.id::text ORDER BY pg.o, pg.id) END FROM ${peers} pg)` : "NULL::jsonb",
        sort,
      };
    }
    default:
      return { key: `to_jsonb(NULLIF(${textExpr(f, a)}, ''))`, sort };
  }
}
