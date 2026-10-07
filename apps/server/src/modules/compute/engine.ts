/**
 * Computed-field engine (formula / lookup / rollup / count).
 *
 * Storage (CONTRACTS "Contract changes", B): `records.computed[slot]` holds the
 * unwrapped value; errors live in `records.computed._errors[slot]`.
 *
 * `runComputeInTx` takes the set of (table, records, fields) whose values just
 * changed plus optional "seed" fields to recompute outright, walks the field
 * dependency graph in topological order and recomputes every affected
 * (field, record) pair — including records reached through links in other
 * tables. Large fan-outs are deferred to the compute worker
 * (`data.computed_stale` + a COMPUTE job enqueued after commit).
 */
import { buildFieldGraph, planRecompute, type FieldDependencyEdge } from "@tabula/compute";
import { formatCellValue, plainText } from "@tabula/fields";
import {
  FormulaEvalError,
  evaluateFormula,
  parseFormula,
  type FormulaAst,
  type RuntimeValue,
} from "@tabula/formula";
import type { Database } from "@tabula/db";
import { QueueNames, createQueue } from "@tabula/jobs";
import type { Redis } from "ioredis";
import { sql, type Kysely } from "kysely";
import { pid } from "../../lib/public-ids.js";
import type { Db } from "../schema/table-schema.js";

export const ERRORS_KEY = "_errors";
/** Max (records) computed synchronously per field for propagated changes. */
export const SYNC_TARGET_LIMIT = 2000;
const CHUNK = 500;

export interface ComputeScope {
  baseId: string;
  workspaceId: string;
  /** Register after-commit work (job enqueue). */
  afterCommit?: (fn: () => Promise<void> | void) => void;
  redis?: Redis | null;
}

export interface RecordChange {
  tableId: string;
  recordIds: Iterable<string>;
  fieldIds: Iterable<string>;
}

export interface SeedRequest {
  fieldId: string;
  recordIds: Iterable<string>;
}

export interface ComputeRunResult {
  /** tableId → record ids whose computed values changed. */
  touched: Map<string, Set<string>>;
  deferred: number;
}

interface FieldInfo {
  id: string;
  tableId: string;
  slot: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isComputed: boolean;
}

interface RelationInfo {
  id: string;
  aTableId: string;
  aFieldId: string;
  bTableId: string;
  bFieldId: string | null;
}

interface BaseSchema {
  fieldsById: Map<string, FieldInfo>;
  fieldsByTable: Map<string, FieldInfo[]>;
  primaryByTable: Map<string, string | null>;
  relationByField: Map<string, { rel: RelationInfo; side: "a" | "b" }>;
  edges: FieldDependencyEdge[];
  /** dependent → incoming edges */
  incoming: Map<string, FieldDependencyEdge[]>;
}

interface Row {
  id: string;
  tableId: string;
  rowNumber: number;
  cells: Record<string, unknown>;
  computed: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  dirty: boolean;
}

function db(x: Db): Kysely<Database> {
  return x as Kysely<Database>;
}

export async function loadComputeSchema(trx: Db, baseId: string): Promise<BaseSchema> {
  const fr = await sql<{
    id: string;
    table_id: string;
    slot: number;
    name: string;
    type: string;
    config: Record<string, unknown>;
    is_computed: boolean;
  }>`
    SELECT f.id, f.table_id, f.slot, f.name, f.type, f.config, f.is_computed
    FROM data.fields f JOIN data.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
    WHERE f.base_id = ${baseId} AND f.deleted_at IS NULL
  `.execute(db(trx));
  const fieldsById = new Map<string, FieldInfo>();
  const fieldsByTable = new Map<string, FieldInfo[]>();
  for (const r of fr.rows) {
    const f: FieldInfo = {
      id: r.id,
      tableId: r.table_id,
      slot: Number(r.slot),
      name: r.name,
      type: r.type,
      config: r.config ?? {},
      isComputed: r.is_computed,
    };
    fieldsById.set(f.id, f);
    const list = fieldsByTable.get(f.tableId) ?? [];
    list.push(f);
    fieldsByTable.set(f.tableId, list);
  }
  const tr = await sql<{ id: string; primary_field_id: string | null }>`
    SELECT id, primary_field_id FROM data.tables WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(db(trx));
  const primaryByTable = new Map(tr.rows.map((r) => [r.id, r.primary_field_id]));
  const rr = await sql<{ id: string; a_table_id: string; a_field_id: string; b_table_id: string; b_field_id: string | null }>`
    SELECT id, a_table_id, a_field_id, b_table_id, b_field_id FROM data.link_relations WHERE base_id = ${baseId}
  `.execute(db(trx));
  const relationByField = new Map<string, { rel: RelationInfo; side: "a" | "b" }>();
  for (const r of rr.rows) {
    const rel: RelationInfo = {
      id: r.id,
      aTableId: r.a_table_id,
      aFieldId: r.a_field_id,
      bTableId: r.b_table_id,
      bFieldId: r.b_field_id,
    };
    relationByField.set(rel.aFieldId, { rel, side: "a" });
    if (rel.bFieldId) relationByField.set(rel.bFieldId, { rel, side: "b" });
  }
  const er = await sql<{ dependent_field_id: string; depends_on_field_id: string; via_link_field_id: string | null }>`
    SELECT dependent_field_id, depends_on_field_id, via_link_field_id
    FROM data.field_dependencies WHERE base_id = ${baseId}
  `.execute(db(trx));
  const edges: FieldDependencyEdge[] = er.rows
    .filter((e) => fieldsById.has(e.dependent_field_id) && fieldsById.has(e.depends_on_field_id))
    .map((e) => ({
      dependentFieldId: e.dependent_field_id,
      dependsOnFieldId: e.depends_on_field_id,
      viaLinkFieldId: e.via_link_field_id,
    }));
  // A link field displays its peers' primary values, so lookups/rollups that
  // target a link field must refresh when a linked record's primary changes.
  for (const f of fieldsById.values()) {
    if (f.type !== "link" && f.type !== "contact") continue;
    const prim = primaryByTable.get(String(f.config["linkedTableId"] ?? ""));
    if (prim && fieldsById.has(prim) && prim !== f.id) {
      edges.push({ dependentFieldId: f.id, dependsOnFieldId: prim, viaLinkFieldId: f.id });
    }
  }
  const incoming = new Map<string, FieldDependencyEdge[]>();
  for (const e of edges) {
    const list = incoming.get(e.dependentFieldId) ?? [];
    list.push(e);
    incoming.set(e.dependentFieldId, list);
  }
  return { fieldsById, fieldsByTable, primaryByTable, relationByField, edges, incoming };
}

/** Unwrap a stored computed value (legacy `{value,status}` objects too). */
export function unwrapStoredComputed(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "status" in (raw as object)) {
    const o = raw as { value?: unknown; status?: unknown };
    return o.status === "error" ? undefined : o.value;
  }
  return raw;
}

class ComputeRun {
  private rows = new Map<string, Map<string, Row>>();
  private users = new Map<string, string>();
  private attachments = new Map<string, string>();
  private asts = new Map<string, FormulaAst | Error>();
  /** link field id → (record id → ordered live peer ids) */
  private peerCache = new Map<string, Map<string, string[]>>();
  readonly touched = new Map<string, Set<string>>();

  constructor(
    private readonly trx: Db,
    private readonly schema: BaseSchema,
    private readonly now: Date,
  ) {}

  // ---------------- data loading ----------------

  async ensureRows(tableId: string, ids: Iterable<string>): Promise<void> {
    let map = this.rows.get(tableId);
    if (!map) {
      map = new Map();
      this.rows.set(tableId, map);
    }
    const missing = [...new Set(ids)].filter((id) => !map!.has(id));
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      const r = await sql<{
        id: string;
        row_number: string;
        cells: Record<string, unknown>;
        computed: Record<string, unknown>;
        created_at: Date;
        updated_at: Date;
        created_by: string | null;
        updated_by: string | null;
      }>`
        SELECT id, row_number, cells, computed, created_at, updated_at, created_by, updated_by
        FROM data.records
        WHERE table_id = ${tableId} AND id = ANY(${chunk}::uuid[]) AND deleted_at IS NULL
      `.execute(db(this.trx));
      for (const x of r.rows) {
        map.set(x.id, {
          id: x.id,
          tableId,
          rowNumber: Number(x.row_number),
          cells: x.cells ?? {},
          computed: { ...(x.computed ?? {}) },
          createdAt: new Date(x.created_at).toISOString(),
          updatedAt: new Date(x.updated_at).toISOString(),
          createdBy: x.created_by,
          updatedBy: x.updated_by,
          dirty: false,
        });
      }
    }
  }

  row(tableId: string, id: string): Row | undefined {
    return this.rows.get(tableId)?.get(id);
  }

  /** Ordered live peers of `recordIds` through link field `linkFieldId`. */
  async peers(linkFieldId: string, recordIds: Iterable<string>): Promise<Map<string, string[]>> {
    let cache = this.peerCache.get(linkFieldId);
    if (!cache) {
      cache = new Map();
      this.peerCache.set(linkFieldId, cache);
    }
    const info = this.schema.relationByField.get(linkFieldId);
    const ids = [...new Set(recordIds)];
    const missing = ids.filter((id) => !cache!.has(id));
    if (!info) {
      for (const id of missing) cache.set(id, []);
    } else {
      const { rel, side } = info;
      const peerTable = side === "a" ? rel.bTableId : rel.aTableId;
      for (let i = 0; i < missing.length; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK);
        for (const id of chunk) cache.set(id, []);
        const r =
          side === "a"
            ? await sql<{ src: string; dst: string }>`
                SELECT l.a_record_id AS src, l.b_record_id AS dst
                FROM data.record_links l
                JOIN data.records r ON r.table_id = ${peerTable} AND r.id = l.b_record_id AND r.deleted_at IS NULL
                WHERE l.relation_id = ${rel.id} AND l.a_record_id = ANY(${chunk}::uuid[])
                  AND l.deletion_batch_id IS NULL
                ORDER BY l.a_order ASC, l.b_record_id ASC
              `.execute(db(this.trx))
            : await sql<{ src: string; dst: string }>`
                SELECT l.b_record_id AS src, l.a_record_id AS dst
                FROM data.record_links l
                JOIN data.records r ON r.table_id = ${peerTable} AND r.id = l.a_record_id AND r.deleted_at IS NULL
                WHERE l.relation_id = ${rel.id} AND l.b_record_id = ANY(${chunk}::uuid[])
                  AND l.deletion_batch_id IS NULL
                ORDER BY l.b_order ASC, l.a_record_id ASC
              `.execute(db(this.trx));
        for (const x of r.rows) cache.get(x.src)!.push(x.dst);
      }
    }
    const out = new Map<string, string[]>();
    for (const id of ids) out.set(id, cache.get(id) ?? []);
    return out;
  }

  /** Records on `linkFieldId`'s side linked to any of `peerIds`. */
  async owners(linkFieldId: string, peerIds: Iterable<string>): Promise<Set<string>> {
    const info = this.schema.relationByField.get(linkFieldId);
    const out = new Set<string>();
    if (!info) return out;
    const { rel, side } = info;
    const ids = [...new Set(peerIds)];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const r =
        side === "a"
          ? await sql<{ id: string }>`
              SELECT DISTINCT a_record_id AS id FROM data.record_links
              WHERE relation_id = ${rel.id} AND b_record_id = ANY(${chunk}::uuid[])
            `.execute(db(this.trx))
          : await sql<{ id: string }>`
              SELECT DISTINCT b_record_id AS id FROM data.record_links
              WHERE relation_id = ${rel.id} AND a_record_id = ANY(${chunk}::uuid[])
            `.execute(db(this.trx));
      for (const x of r.rows) out.add(x.id);
    }
    return out;
  }

  private async userNames(ids: string[]): Promise<void> {
    const missing = ids.filter((id) => !this.users.has(id));
    if (missing.length === 0) return;
    const r = await sql<{ id: string; display_name: string | null; email: string }>`
      SELECT id, display_name, email FROM core.users WHERE id = ANY(${missing}::uuid[])
    `.execute(db(this.trx));
    for (const id of missing) this.users.set(id, "");
    for (const u of r.rows) this.users.set(u.id, u.display_name || u.email);
  }

  private async attachmentNames(ids: string[]): Promise<void> {
    const missing = ids.filter((id) => !this.attachments.has(id));
    if (missing.length === 0) return;
    const r = await sql<{ id: string; filename: string }>`
      SELECT id, filename FROM data.attachments WHERE id = ANY(${missing}::uuid[])
    `.execute(db(this.trx));
    for (const id of missing) this.attachments.set(id, "");
    for (const a of r.rows) this.attachments.set(a.id, a.filename);
  }

  // ---------------- value access ----------------

  private computedOf(row: Row, f: FieldInfo): { value: unknown; error?: string } {
    const errs = row.computed[ERRORS_KEY] as Record<string, unknown> | undefined;
    const e = errs?.[String(f.slot)];
    if (typeof e === "string" && e) return { value: undefined, error: e };
    return { value: unwrapStoredComputed(row.computed[String(f.slot)]) };
  }

  /** Display text of a record's primary field (link names). */
  async primaryText(tableId: string, recordId: string): Promise<string> {
    const primId = this.schema.primaryByTable.get(tableId);
    const prim = primId ? this.schema.fieldsById.get(primId) : undefined;
    await this.ensureRows(tableId, [recordId]);
    const row = this.row(tableId, recordId);
    if (!row || !prim) return "";
    if (prim.isComputed) {
      const v = this.computedOf(row, prim).value;
      if (v === undefined || v === null) return "";
      const vals = prim.type === "lookup" ? await this.toRuntime(prim, Array.isArray(v) ? v : [v]) : v;
      return Array.isArray(vals) ? vals.map((x) => plainText(x)).filter((x) => x !== "").join(", ") : plainText(vals);
    }
    switch (prim.type) {
      case "autonumber":
        return String(row.rowNumber);
      case "created_time":
        return row.createdAt;
      case "modified_time":
        return row.updatedAt;
      case "link":
      case "contact":
        return "";
      default:
        return formatCellValue(prim.type, row.cells[String(prim.slot)], prim.config);
    }
  }

  /**
   * Stored-form values used by lookups (flattened): raw rec uuids for a link
   * target, `opt_` ids for selects, user uuids for collaborators, etc.
   */
  async lookupValues(target: FieldInfo, peerIds: string[]): Promise<unknown[]> {
    await this.ensureRows(target.tableId, peerIds);
    const out: unknown[] = [];
    if (target.type === "link" || target.type === "contact") {
      const peerMap = await this.peers(target.id, peerIds);
      for (const p of peerIds) for (const q of peerMap.get(p) ?? []) out.push(q);
      return out;
    }
    for (const p of peerIds) {
      const row = this.row(target.tableId, p);
      if (!row) continue;
      let v: unknown;
      if (target.isComputed) {
        const c = this.computedOf(row, target);
        if (c.error) continue;
        v = c.value;
      } else {
        v = this.metaOrCell(row, target);
      }
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) out.push(...v.filter((x) => x !== null && x !== undefined && x !== ""));
      else out.push(v);
    }
    return out;
  }

  private metaOrCell(row: Row, f: FieldInfo): unknown {
    switch (f.type) {
      case "autonumber":
        return row.rowNumber;
      case "created_time":
        return row.createdAt;
      case "modified_time":
        return row.updatedAt;
      case "created_by":
        return row.createdBy ?? undefined;
      case "modified_by":
        return row.updatedBy ?? row.createdBy ?? undefined;
      default:
        return row.cells[String(f.slot)];
    }
  }

  /** Convert stored values of `f` to formula/rollup-friendly runtime values. */
  async toRuntime(f: FieldInfo, values: unknown[]): Promise<RuntimeValue[]> {
    switch (f.type) {
      case "single_select":
      case "multi_select": {
        const opts = (Array.isArray(f.config["options"]) ? f.config["options"] : []) as Array<{ id: string; label: string }>;
        return values.map((v) => opts.find((o) => o.id === v)?.label ?? (typeof v === "string" ? v : null));
      }
      case "collaborator":
      case "created_by":
      case "modified_by": {
        const ids = values.filter((v): v is string => typeof v === "string");
        await this.userNames(ids);
        return ids.map((id) => this.users.get(id) ?? "");
      }
      case "attachment": {
        const ids = values.filter((v): v is string => typeof v === "string");
        await this.attachmentNames(ids);
        return ids.map((id) => this.attachments.get(id) ?? "");
      }
      case "barcode":
        return values.map((v) => (v && typeof v === "object" ? String((v as { text?: unknown }).text ?? "") : String(v)));
      case "json":
        return values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
      case "lookup": {
        const target = this.schema.fieldsById.get(String(f.config["targetFieldId"] ?? f.config["lookupFieldId"] ?? ""));
        return target ? this.toRuntime(target, values) : (values as RuntimeValue[]);
      }
      case "link":
      case "contact": {
        const peerTable = String(f.config["linkedTableId"] ?? "");
        const out: RuntimeValue[] = [];
        for (const v of values) out.push(typeof v === "string" ? await this.primaryText(peerTable, v) : null);
        return out;
      }
      default:
        return values.map((v) => (v === undefined ? null : (v as RuntimeValue)));
    }
  }

  /** Runtime value of field `f` on `row` for formulas. */
  async formulaValue(row: Row, f: FieldInfo): Promise<RuntimeValue> {
    if (f.isComputed) {
      const c = this.computedOf(row, f);
      if (c.error) throw new FormulaEvalError(`{${f.name}} has an error`);
      const v = c.value;
      if (v === undefined || v === null) return null;
      if (f.type === "lookup") return this.toRuntime(f, Array.isArray(v) ? v : [v]);
      return v as RuntimeValue;
    }
    switch (f.type) {
      case "link":
      case "contact": {
        const peerMap = await this.peers(f.id, [row.id]);
        const peerTable = String(f.config["linkedTableId"] ?? "");
        const names: RuntimeValue[] = [];
        for (const p of peerMap.get(row.id) ?? []) names.push(await this.primaryText(peerTable, p));
        return names;
      }
      case "checkbox":
        return row.cells[String(f.slot)] === true;
      case "multi_select":
      case "collaborator":
      case "attachment": {
        const v = row.cells[String(f.slot)];
        return this.toRuntime(f, Array.isArray(v) ? v : v === undefined ? [] : [v]);
      }
      case "single_select":
      case "barcode":
      case "json":
      case "created_by":
      case "modified_by": {
        const v = this.metaOrCell(row, f);
        if (v === undefined || v === null) return null;
        return (await this.toRuntime(f, [v]))[0] ?? null;
      }
      case "button":
        return String(f.config["label"] ?? "");
      default: {
        const v = this.metaOrCell(row, f);
        return v === undefined ? null : (v as RuntimeValue);
      }
    }
  }

  // ---------------- compute ----------------

  private ast(f: FieldInfo): FormulaAst | Error {
    let a = this.asts.get(f.id);
    if (!a) {
      const expr = String(f.config["expression"] ?? f.config["formula"] ?? "");
      try {
        a = expr.trim() ? parseFormula(expr) : ({ kind: "blank" } as FormulaAst);
      } catch (e) {
        a = e instanceof Error ? e : new Error(String(e));
      }
      this.asts.set(f.id, a);
    }
    return a;
  }

  async computeValue(f: FieldInfo, row: Row): Promise<{ value: unknown; error?: string }> {
    try {
      switch (f.type) {
        case "formula": {
          const ast = this.ast(f);
          if (ast instanceof Error) return { value: undefined, error: `#ERROR! ${ast.message}` };
          const tableFields = this.schema.fieldsByTable.get(f.tableId) ?? [];
          const resolved = new Map<string, RuntimeValue>();
          const refs = collectRefs(ast);
          for (const ref of refs) {
            const field =
              this.schema.fieldsById.get(ref.toLowerCase()) ??
              tableFields.find((x) => x.name === ref) ??
              tableFields.find((x) => x.name.toLowerCase() === ref.toLowerCase());
            if (!field || field.tableId !== f.tableId) continue;
            try {
              resolved.set(ref, await this.formulaValue(row, field));
            } catch (e) {
              if (e instanceof FormulaEvalError) resolved.set(ref, new ErrorMarker(e.message) as unknown as RuntimeValue);
              else throw e;
            }
          }
          const modifier = row.updatedBy ?? row.createdBy;
          await this.userNames([row.createdBy, modifier].filter((x): x is string => !!x));
          const value = evaluateFormula(ast, {
            getField: (ref) => {
              const v = resolved.get(ref);
              if (v instanceof ErrorMarker) throw new FormulaEvalError(v.message);
              return v;
            },
            recordId: pid("rec", row.id),
            createdTime: row.createdAt,
            lastModifiedTime: row.updatedAt,
            rowNumber: row.rowNumber,
            ...(row.createdBy ? { createdBy: this.users.get(row.createdBy) ?? "" } : {}),
            ...(modifier ? { modifiedBy: this.users.get(modifier) ?? "" } : {}),
            now: this.now,
          });
          return { value: castResult(value, f.config["resultType"]) };
        }
        case "count": {
          const peerMap = await this.peers(String(f.config["linkFieldId"] ?? ""), [row.id]);
          return { value: (peerMap.get(row.id) ?? []).length };
        }
        case "lookup": {
          const linkId = String(f.config["linkFieldId"] ?? "");
          const target = this.schema.fieldsById.get(String(f.config["targetFieldId"] ?? f.config["lookupFieldId"] ?? ""));
          if (!target) return { value: undefined, error: "#ERROR! Lookup target field was deleted" };
          if (!this.schema.fieldsById.has(linkId)) return { value: undefined, error: "#ERROR! Link field was deleted" };
          const peerMap = await this.peers(linkId, [row.id]);
          const vals = await this.lookupValues(target, peerMap.get(row.id) ?? []);
          return { value: vals.length ? vals : undefined };
        }
        case "rollup": {
          const linkId = String(f.config["linkFieldId"] ?? "");
          const target = this.schema.fieldsById.get(String(f.config["targetFieldId"] ?? f.config["rollupFieldId"] ?? ""));
          if (!target) return { value: undefined, error: "#ERROR! Rollup target field was deleted" };
          if (!this.schema.fieldsById.has(linkId)) return { value: undefined, error: "#ERROR! Link field was deleted" };
          const peers = (await this.peers(linkId, [row.id])).get(row.id) ?? [];
          const stored = await this.lookupValues(target, peers);
          const values = await this.toRuntime(target, stored);
          return { value: aggregate(String(f.config["aggregation"] ?? f.config["function"] ?? "sum"), values, peers.length, f.config["precision"]) };
        }
        default:
          return { value: undefined };
      }
    } catch (e) {
      if (e instanceof FormulaEvalError) {
        return { value: undefined, error: e.message.startsWith("#") ? e.message : `#ERROR! ${e.message}` };
      }
      throw e;
    }
  }

  /** Store a computed result on the cached row; returns true when it changed. */
  apply(f: FieldInfo, row: Row, result: { value: unknown; error?: string }): boolean {
    const key = String(f.slot);
    const before = JSON.stringify([row.computed[key] ?? null, (row.computed[ERRORS_KEY] as Record<string, unknown> | undefined)?.[key] ?? null]);
    const errs = { ...((row.computed[ERRORS_KEY] as Record<string, unknown> | undefined) ?? {}) };
    if (result.error) {
      errs[key] = result.error;
      delete row.computed[key];
    } else {
      delete errs[key];
      if (result.value === undefined || result.value === null) delete row.computed[key];
      else row.computed[key] = result.value;
    }
    if (Object.keys(errs).length) row.computed[ERRORS_KEY] = errs;
    else delete row.computed[ERRORS_KEY];
    const after = JSON.stringify([row.computed[key] ?? null, errs[key] ?? null]);
    if (before !== after) {
      row.dirty = true;
      let set = this.touched.get(row.tableId);
      if (!set) {
        set = new Set();
        this.touched.set(row.tableId, set);
      }
      set.add(row.id);
      return true;
    }
    return false;
  }

  async flush(): Promise<void> {
    for (const [tableId, map] of this.rows) {
      const dirty = [...map.values()].filter((r) => r.dirty);
      for (let i = 0; i < dirty.length; i += CHUNK) {
        const chunk = dirty.slice(i, i + CHUNK).map((r) => ({ id: r.id, computed: r.computed }));
        await sql`
          UPDATE data.records AS r
          SET computed = v.computed
          FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS v(id uuid, computed jsonb)
          WHERE r.table_id = ${tableId} AND r.id = v.id
        `.execute(db(this.trx));
      }
      for (const r of dirty) r.dirty = false;
    }
  }
}

class ErrorMarker {
  constructor(readonly message: string) {}
}

function collectRefs(ast: FormulaAst): string[] {
  const out: string[] = [];
  const walk = (n: FormulaAst): void => {
    if (n.kind === "field") {
      if (!out.includes(n.name)) out.push(n.name);
    } else if (n.kind === "unary") walk(n.expr);
    else if (n.kind === "binary") {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === "call") n.args.forEach(walk);
  };
  walk(ast);
  return out;
}

function castResult(value: unknown, resultType: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const flat = value.filter((x) => x !== null && x !== "");
    if (flat.length === 0) return undefined;
    if (resultType === "text") return flat.map((x) => plainText(x)).join(", ");
    return flat;
  }
  switch (resultType) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case "text":
      return plainText(value);
    case "boolean":
      return value === true || value === 1 || (typeof value === "string" && value !== "");
    default:
      return value === "" ? undefined : value;
  }
}

function toNum(v: RuntimeValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

function isDateLike(v: RuntimeValue): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
}

export function aggregate(agg: string, values: RuntimeValue[], linkedCount: number, precision?: unknown): unknown {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== "");
  const nums = nonEmpty.map(toNum).filter((n): n is number => n !== null);
  const round = (n: number): number =>
    typeof precision === "number" ? Math.round(n * 10 ** precision) / 10 ** precision : Number(n.toPrecision(15));
  switch (agg) {
    case "sum":
      return round(nums.reduce((a, b) => a + b, 0));
    case "avg":
    case "average":
      return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length) : undefined;
    case "min":
    case "max": {
      if (nums.length) return agg === "min" ? Math.min(...nums) : Math.max(...nums);
      const dates = nonEmpty.filter(isDateLike).sort();
      if (dates.length) return agg === "min" ? dates[0] : dates[dates.length - 1];
      return undefined;
    }
    case "count":
      return nums.length;
    case "counta":
      return nonEmpty.length;
    case "countall":
      return Math.max(values.length, linkedCount);
    case "concat":
      return nonEmpty.map((v) => plainText(v)).join(", ") || undefined;
    case "and":
      // An empty linked value (e.g. an unchecked checkbox) counts as false.
      return (
        nonEmpty.length > 0 &&
        nonEmpty.length >= Math.max(values.length, linkedCount) &&
        nonEmpty.every((v) => v === true || (toNum(v) ?? (v ? 1 : 0)) !== 0)
      );
    case "or":
      return nonEmpty.some((v) => v === true || (toNum(v) ?? (v ? 1 : 0)) !== 0);
    case "unique": {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const v of nonEmpty) {
        const k = JSON.stringify(v);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(v);
        }
      }
      return out.length ? out : undefined;
    }
    default:
      return undefined;
  }
}

function addAll(map: Map<string, Set<string>>, key: string, ids: Iterable<string>): void {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  for (const id of ids) s.add(id);
}

/**
 * Recompute everything affected by `changes` (+ `seeds`) inside `trx`.
 * Fields whose target set exceeds `syncLimit` are deferred to the worker.
 */
export async function runComputeInTx(
  trx: Db,
  scope: ComputeScope,
  input: { changes?: RecordChange[]; seeds?: SeedRequest[]; syncLimit?: number; schema?: BaseSchema },
): Promise<ComputeRunResult> {
  const changes = input.changes ?? [];
  const seeds = input.seeds ?? [];
  const syncLimit = input.syncLimit ?? SYNC_TARGET_LIMIT;
  const changedRecs = new Map<string, Set<string>>();
  for (const c of changes) for (const f of c.fieldIds) addAll(changedRecs, f, c.recordIds);
  const forced = new Map<string, Set<string>>();
  for (const s of seeds) addAll(forced, s.fieldId, s.recordIds);
  if (changedRecs.size === 0 && forced.size === 0) return { touched: new Map(), deferred: 0 };

  const schema = input.schema ?? (await loadComputeSchema(trx, scope.baseId));
  const graph = buildFieldGraph([...schema.fieldsById.keys()], schema.edges);
  const order = planRecompute(
    graph,
    [...changedRecs.keys()].filter((id) => schema.fieldsById.has(id)),
    [...forced.keys()].filter((id) => schema.fieldsById.has(id)),
  );
  if (order.length === 0) return { touched: new Map(), deferred: 0 };

  const run = new ComputeRun(trx, schema, new Date());
  let deferred = 0;
  const staleRows: Array<{ tableId: string; recordId: string; fieldId: string }> = [];

  for (const fieldId of order) {
    const f = schema.fieldsById.get(fieldId);
    if (!f) continue;
    const isLink = f.type === "link" || f.type === "contact";
    if (!isLink && (!f.isComputed || f.type === "ai_generated")) continue;
    const targets = new Set<string>(isLink ? [] : (forced.get(fieldId) ?? []));
    for (const e of schema.incoming.get(fieldId) ?? []) {
      const recs = changedRecs.get(e.dependsOnFieldId);
      if (!recs || recs.size === 0) continue;
      if (!e.viaLinkFieldId) {
        const dep = schema.fieldsById.get(e.dependsOnFieldId);
        if (dep && dep.tableId === f.tableId) for (const r of recs) targets.add(r);
      } else {
        const owners = await run.owners(e.viaLinkFieldId, recs);
        for (const r of owners) targets.add(r);
      }
    }
    if (targets.size === 0) continue;
    if (isLink) {
      // Displayed names changed; nothing is stored, but dependents must refresh.
      addAll(changedRecs, fieldId, targets);
      addAll(run.touched, f.tableId, targets);
      continue;
    }

    if (targets.size > syncLimit && !forced.has(fieldId)) {
      for (const r of targets) staleRows.push({ tableId: f.tableId, recordId: r, fieldId });
      deferred += targets.size;
      continue;
    }

    const ids = [...targets];
    const changedHere = new Set<string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      await run.ensureRows(f.tableId, chunk);
      for (const id of chunk) {
        const row = run.row(f.tableId, id);
        if (!row) continue;
        const result = await run.computeValue(f, row);
        if (run.apply(f, row, result)) changedHere.add(id);
      }
    }
    if (changedHere.size) addAll(changedRecs, fieldId, changedHere);
  }

  await run.flush();

  if (staleRows.length) {
    for (let i = 0; i < staleRows.length; i += CHUNK) {
      const chunk = staleRows.slice(i, i + CHUNK).map((s) => ({
        table_id: s.tableId,
        record_id: s.recordId,
        field_id: s.fieldId,
      }));
      await sql`
        INSERT INTO data.computed_stale (table_id, record_id, field_id, workspace_id, base_id)
        SELECT v.table_id, v.record_id, v.field_id, ${scope.workspaceId}, ${scope.baseId}
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS v(table_id uuid, record_id uuid, field_id uuid)
        ON CONFLICT (table_id, record_id, field_id) DO UPDATE SET enqueued_at = now()
      `.execute(db(trx));
    }
    scheduleComputeJob(scope);
  }

  return { touched: run.touched, deferred };
}

/** Enqueue the compute worker for `scope.baseId` after commit (no-op without redis). */
export function scheduleComputeJob(scope: ComputeScope): void {
  const redis = scope.redis;
  if (!redis) return;
  const enqueue = async () => {
    const queue = createQueue(QueueNames.COMPUTE, redis);
    await queue.add(
      "recompute-base",
      { baseId: scope.baseId, workspaceId: scope.workspaceId },
      { removeOnComplete: 1000, removeOnFail: 5000, jobId: `compute-${scope.baseId}-${Date.now()}` },
    );
  };
  if (scope.afterCommit) scope.afterCommit(enqueue);
  else void enqueue().catch(() => undefined);
}

/**
 * Backfill computed `fieldIds` (same table) for every record. Synchronous for
 * tables up to `syncLimit` records; larger tables are marked stale and handed
 * to the compute worker.
 */
export async function backfillFieldsInTx(
  trx: Db,
  scope: ComputeScope,
  tableId: string,
  fieldIds: string[],
  syncLimit = 5000,
): Promise<{ sync: boolean; touched: Map<string, Set<string>> }> {
  if (fieldIds.length === 0) return { sync: true, touched: new Map() };
  const cnt = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM data.records WHERE table_id = ${tableId} AND deleted_at IS NULL
  `.execute(db(trx));
  const n = Number(cnt.rows[0]?.n ?? 0);
  if (n === 0) return { sync: true, touched: new Map() };
  if (n <= syncLimit) {
    const ids = await sql<{ id: string }>`
      SELECT id FROM data.records WHERE table_id = ${tableId} AND deleted_at IS NULL
    `.execute(db(trx));
    const recordIds = ids.rows.map((r) => r.id);
    const res = await runComputeInTx(trx, scope, {
      seeds: fieldIds.map((fieldId) => ({ fieldId, recordIds })),
      syncLimit: Math.max(SYNC_TARGET_LIMIT, syncLimit),
    });
    return { sync: true, touched: res.touched };
  }
  for (const fieldId of fieldIds) {
    await sql`
      INSERT INTO data.computed_stale (table_id, record_id, field_id, workspace_id, base_id)
      SELECT ${tableId}, id, ${fieldId}, ${scope.workspaceId}, ${scope.baseId}
      FROM data.records WHERE table_id = ${tableId} AND deleted_at IS NULL
      ON CONFLICT (table_id, record_id, field_id) DO UPDATE SET enqueued_at = now()
    `.execute(db(trx));
  }
  scheduleComputeJob(scope);
  return { sync: false, touched: new Map() };
}
