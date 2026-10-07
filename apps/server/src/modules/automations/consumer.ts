import type { TabulaDb } from "@tabula/db";
import { decodePublicId } from "@tabula/types";
import { sql } from "kysely";
import { pid } from "../../lib/public-ids.js";
import { createServiceSession } from "../auth/session.js";
import { AutomationApiClient } from "./api-client.js";
import { drainPendingRuns, normalizeFilterIds, toPid, type EngineDeps } from "./engine.js";
import { evaluateWireFilter } from "./filter-eval.js";
import { nextScheduledRun } from "./schedule.js";
import { MAX_CAUSATION_DEPTH, scheduleSchema, type TriggerDef } from "./types.js";

/**
 * Automation trigger consumer. Reads domain events straight from
 * `data.outbox_events` (independent of the Redis event bus / relay), decides
 * which automations fire, and enqueues `data.automation_runs` rows. Runs are
 * executed by `drainPendingRuns`.
 *
 * Guarantees:
 *  - idempotent per (automation, event[, record]) via the unique trigger_key
 *  - single active consumer via a Postgres advisory lock
 *  - loop guard: events caused by an automation run never re-trigger that same
 *    automation, and causation depth is capped at MAX_CAUSATION_DEPTH.
 */

const LOCK_KEY = 728_431_901; // arbitrary constant
const LOOKBACK_MS = 2 * 60_000; // tolerate late-committing transactions
const BATCH = 200;

interface OutboxRow {
  id: string;
  created_at: Date;
  base_id: string;
  workspace_id: string;
  event_type: string;
  base_seq: string | null;
  payload: Record<string, unknown>;
  actor: Record<string, unknown>;
}

interface ChangeRow {
  session_id: string | null;
  client_mutation_id: string | null;
  via: string;
  actor_id: string | null;
  ops: unknown[];
  table_ids: string[];
}

interface AutomationRow {
  id: string;
  base_id: string;
  workspace_id: string;
  trigger: TriggerDef;
  owner: string | null;
}

type EventKind = "created" | "updated" | "deleted" | "form" | "other";

const CREATED = new Set(["record.created", "records.created", "records.batch_created", "record.restored", "records.restored"]);
const UPDATED = new Set([
  "record.updated",
  "records.updated",
  "records.batch_updated",
  "record.links_changed",
  "records.links_changed",
  "record.moved",
]);
const DELETED = new Set(["record.deleted", "records.deleted", "records.batch_deleted"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectRecordIds(payload: Record<string, unknown>, ops: unknown[]): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const p = toPid(v, "rec");
    if (p) out.add(p);
  };
  add(payload["recordId"]);
  for (const k of ["recordIds", "ids", "createdIds", "updatedIds"]) {
    const arr = payload[k];
    if (Array.isArray(arr)) arr.forEach(add);
  }
  if (Array.isArray(payload["records"])) {
    for (const r of payload["records"] as unknown[]) add((r as { id?: unknown })?.id);
  }
  for (const op of ops ?? []) {
    if (!op || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    if (typeof o["op"] === "string" && !/record/.test(o["op"])) continue;
    add(o["recordId"]);
    if (Array.isArray(o["recordIds"])) (o["recordIds"] as unknown[]).forEach(add);
  }
  return [...out];
}

/** Changed field ids (fld_) or null when unknown. */
function collectChangedFields(
  payload: Record<string, unknown>,
  ops: unknown[],
  slotToField: Map<string, string>,
): Set<string> | null {
  const out = new Set<string>();
  let known = false;
  for (const k of ["changedFieldIds", "fieldIds"]) {
    const arr = payload[k];
    if (Array.isArray(arr)) {
      known = true;
      for (const f of arr) {
        const p = typeof f === "string" ? toPid(f, "fld") : null;
        if (p) out.add(p);
      }
    }
  }
  for (const op of ops ?? []) {
    if (!op || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    for (const key of ["cells", "fields", "changes"]) {
      const cells = o[key];
      if (cells && typeof cells === "object" && !Array.isArray(cells)) {
        known = true;
        for (const k of Object.keys(cells)) {
          const viaSlot = slotToField.get(k);
          if (viaSlot) out.add(viaSlot);
          const p = toPid(k, "fld");
          if (p) out.add(p);
        }
      }
    }
    for (const key of ["fieldId", "linkFieldId"]) {
      if (typeof o[key] === "string") {
        known = true;
        const p = toPid(o[key] as string, "fld");
        if (p) out.add(p);
      }
    }
  }
  return known ? out : null;
}

export class AutomationConsumer {
  private sessions = new Map<string, { token: string; expiresAt: number }>();
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EngineDeps) {}

  private get db(): TabulaDb {
    return this.deps.db;
  }

  private async clientFor(ownerId: string): Promise<AutomationApiClient> {
    const cached = this.sessions.get(ownerId);
    if (cached && cached.expiresAt > Date.now() + 120_000) {
      return new AutomationApiClient(this.deps.env.API_URL, cached.token, "aut:eval");
    }
    const s = await createServiceSession(this.db, ownerId, 30);
    this.sessions.set(ownerId, { token: s.token, expiresAt: Date.now() + 30 * 60_000 });
    return new AutomationApiClient(this.deps.env.API_URL, s.token, "aut:eval");
  }

  /** One consumer pass. Returns the number of events processed. */
  async tick(): Promise<number> {
    let processed = 0;
    await this.db.connection().execute(async (conn) => {
      const lock = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`.execute(conn);
      if (!lock.rows[0]?.ok) return;
      try {
        processed = await this.processEvents(conn as unknown as TabulaDb);
        await this.processSchedules(conn as unknown as TabulaDb);
      } finally {
        await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(conn);
      }
    });
    await drainPendingRuns(this.deps, 5);
    return processed;
  }

  private async processEvents(db: TabulaDb): Promise<number> {
    const state = await sql<{ value: { cursor?: string } }>`
      SELECT value FROM data.automation_engine_state WHERE key = 'outbox_cursor'
    `.execute(db);
    let cursor = state.rows[0]?.value.cursor ? new Date(state.rows[0].value.cursor) : null;
    if (!cursor) {
      cursor = new Date();
      await sql`
        INSERT INTO data.automation_engine_state (key, value)
        VALUES ('outbox_cursor', ${JSON.stringify({ cursor: cursor.toISOString() })}::jsonb)
        ON CONFLICT (key) DO NOTHING
      `.execute(db);
      return 0;
    }
    const since = new Date(cursor.getTime() - LOOKBACK_MS);
    const events = await sql<OutboxRow>`
      SELECT o.id, o.created_at, o.base_id, o.workspace_id, o.event_type, o.base_seq, o.payload, o.actor
      FROM data.outbox_events o
      WHERE o.created_at > ${since}
        AND o.base_id IN (SELECT base_id FROM data.automations WHERE enabled AND deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM data.automation_processed_events p WHERE p.event_id = o.id)
      ORDER BY o.created_at, o.id
      LIMIT ${BATCH}
    `.execute(db);

    let maxSeen = cursor;
    const automationsByBase = new Map<string, AutomationRow[]>();
    for (const ev of events.rows) {
      try {
        let autos = automationsByBase.get(ev.base_id);
        if (!autos) {
          autos = (
            await sql<AutomationRow>`
              SELECT id, base_id, workspace_id, trigger, COALESCE(updated_by, created_by) AS owner
              FROM data.automations
              WHERE base_id = ${ev.base_id} AND enabled AND deleted_at IS NULL
            `.execute(db)
          ).rows;
          automationsByBase.set(ev.base_id, autos);
        }
        if (autos.length > 0) await this.handleEvent(db, ev, autos);
      } catch (err) {
        this.deps.log.error({ err, eventId: ev.id }, "automation trigger evaluation failed");
      }
      await sql`
        INSERT INTO data.automation_processed_events (event_id) VALUES (${ev.id}) ON CONFLICT DO NOTHING
      `.execute(db);
      if (ev.created_at > maxSeen) maxSeen = ev.created_at;
    }
    // Advance the cursor (never past "now - lookback" for in-flight transactions).
    const next = events.rows.length > 0 ? maxSeen : new Date(Math.max(cursor.getTime(), Date.now() - LOOKBACK_MS));
    if (next.getTime() !== cursor.getTime()) {
      await sql`
        UPDATE data.automation_engine_state
        SET value = ${JSON.stringify({ cursor: next.toISOString() })}::jsonb, updated_at = now()
        WHERE key = 'outbox_cursor'
      `.execute(db);
    }
    if (Math.random() < 0.01) {
      await sql`DELETE FROM data.automation_processed_events WHERE processed_at < now() - interval '1 day'`.execute(db);
    }
    return events.rows.length;
  }

  private async handleEvent(db: TabulaDb, ev: OutboxRow, autos: AutomationRow[]): Promise<void> {
    const payload = ev.payload ?? {};
    let change: ChangeRow | null = null;
    if (ev.base_seq !== null) {
      const c = await sql<ChangeRow>`
        SELECT session_id, client_mutation_id, via, actor_id, ops, table_ids
        FROM data.base_changes WHERE base_id = ${ev.base_id} AND seq = ${ev.base_seq}
      `.execute(db);
      change = c.rows[0] ?? null;
    }
    const ops = Array.isArray(change?.ops) ? change!.ops : [];

    // --- causation (loop guard) ---
    let causedBy: { automationId: string; depth: number } | null = null;
    const cm = (payload["clientMutationId"] as string | undefined) ?? change?.client_mutation_id ?? null;
    const runIdFromCm = cm && cm.startsWith("aut:") ? cm.slice(4) : null;
    if (runIdFromCm && UUID_RE.test(runIdFromCm)) {
      const r = await sql<{ automation_id: string; causation_depth: number }>`
        SELECT automation_id, causation_depth FROM data.automation_runs WHERE id = ${runIdFromCm}
      `.execute(db);
      if (r.rows[0]) causedBy = { automationId: r.rows[0].automation_id, depth: r.rows[0].causation_depth };
    } else if (change?.session_id) {
      const r = await sql<{ automation_id: string; causation_depth: number }>`
        SELECT automation_id, causation_depth FROM data.automation_runs WHERE session_id = ${change.session_id} LIMIT 1
      `.execute(db);
      if (r.rows[0]) causedBy = { automationId: r.rows[0].automation_id, depth: r.rows[0].causation_depth };
    }
    const depth = causedBy ? causedBy.depth + 1 : 0;

    // --- classify ---
    let kind: EventKind = "other";
    if (ev.event_type === "form.submitted") kind = "form";
    else if (CREATED.has(ev.event_type)) kind = "created";
    else if (UPDATED.has(ev.event_type)) kind = "updated";
    else if (DELETED.has(ev.event_type)) kind = "deleted";
    const viaForm =
      kind === "form" ||
      (kind === "created" &&
        (change?.via === "form" || payload["via"] === "form" || typeof payload["formViewId"] === "string"));
    if (kind === "other") return;

    const tableRaw =
      (payload["tableId"] as string | undefined) ?? (change?.table_ids?.length === 1 ? change.table_ids[0] : undefined);
    const tableId = toPid(tableRaw ?? null, "tbl");
    const recordIds = collectRecordIds(payload, ops);
    const actorId = change?.actor_id ?? ((ev.actor?.["id"] as string | undefined) ?? null);

    for (const auto of autos) {
      const trig = auto.trigger ?? { type: "record.created" };
      const cfg = trig.config ?? {};
      const autoTable = toPid(cfg.tableId ?? null, "tbl");
      if (causedBy && causedBy.automationId === auto.id) continue;
      if (depth > MAX_CAUSATION_DEPTH) {
        this.deps.log.warn({ automationId: auto.id, eventId: ev.id, depth }, "automation loop guard: depth exceeded");
        continue;
      }
      const tableMatches = !autoTable || autoTable === tableId;

      if (kind === "deleted") {
        if (recordIds.length > 0) {
          await sql`
            DELETE FROM data.automation_record_state
            WHERE automation_id = ${auto.id}
              AND record_id = ANY(${recordIds.map((r) => toUuidSafe(r)).filter(Boolean) as string[]}::uuid[])
          `.execute(db);
        }
        continue;
      }

      const enqueue = async (recordId: string | null, extra: Record<string, unknown> = {}) => {
        await insertRun(db, {
          automationId: auto.id,
          baseId: auto.base_id,
          workspaceId: auto.workspace_id,
          triggerType: trig.type,
          triggerKey: `evt:${ev.id}:${recordId ?? "-"}`,
          payload: {
            eventId: ev.id,
            eventType: ev.event_type,
            ...(tableId ? { tableId } : {}),
            ...(recordId ? { recordId } : {}),
            ...(actorId && UUID_RE.test(actorId) ? { userId: pid("usr", actorId) } : {}),
            ...extra,
          },
          depth,
        });
      };

      switch (trig.type) {
        case "record.created":
          if ((kind === "created" || kind === "form") && tableMatches) {
            for (const r of recordIds) await enqueue(r);
          }
          break;
        case "form.submitted": {
          if (!viaForm || !tableMatches) break;
          const wantView = toPid(cfg.viewId ?? null, "viw");
          const gotView = toPid(
            (payload["formViewId"] as string | undefined) ?? (payload["viewId"] as string | undefined) ?? null,
            "viw",
          );
          if (wantView && gotView && wantView !== gotView) break;
          for (const r of recordIds) await enqueue(r, gotView ? { viewId: gotView } : {});
          break;
        }
        case "record.updated": {
          if (kind !== "updated" || !tableMatches) break;
          const watched = (cfg.fieldIds ?? []).map((f) => toPid(f, "fld")).filter(Boolean) as string[];
          let changed: Set<string> | null = null;
          if (watched.length > 0) {
            const slotMap = await slotToFieldMap(db, tableRaw ?? null);
            changed = collectChangedFields(payload, ops, slotMap);
            if (changed && !watched.some((w) => changed!.has(w))) break;
          }
          for (const r of recordIds) {
            await enqueue(r, changed ? { changedFieldIds: [...changed] } : {});
          }
          break;
        }
        case "record.matches_conditions":
        case "record.enters_view": {
          if (!(kind === "created" || kind === "updated" || kind === "form") || !tableMatches || !tableId) break;
          if (!auto.owner) break;
          const client = await this.clientFor(auto.owner);
          const basePid = pid("bas", auto.base_id);
          const base = await client.getBase(basePid);
          const table = base.tables.find((t) => t.id === tableId);
          if (!table) break;
          let filter: unknown = null;
          if (trig.type === "record.matches_conditions") {
            filter = normalizeFilterIds(cfg.filter ?? null);
          } else {
            const viewId = toPid(cfg.viewId ?? null, "viw");
            const view = table.views.find((v) => v.id === viewId);
            if (!view) break;
            filter = normalizeFilterIds((view.config?.["filter"] as unknown) ?? null);
          }
          for (const r of recordIds) {
            const rec = await client.getRecord(basePid, table.id, r);
            if (!rec) continue;
            const matched =
              trig.type === "record.matches_conditions" && !filter
                ? false // no conditions configured yet → never fire
                : evaluateWireFilter(filter, rec, table.fields);
            const rid = toUuidSafe(r);
            if (!rid) continue;
            const prev = await sql<{ matched: boolean }>`
              SELECT matched FROM data.automation_record_state
              WHERE automation_id = ${auto.id} AND record_id = ${rid}
            `.execute(db);
            const was = prev.rows[0]?.matched ?? false;
            await sql`
              INSERT INTO data.automation_record_state (automation_id, record_id, matched)
              VALUES (${auto.id}, ${rid}, ${matched})
              ON CONFLICT (automation_id, record_id) DO UPDATE SET matched = EXCLUDED.matched, updated_at = now()
            `.execute(db);
            if (matched && !was) await enqueue(r);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private async processSchedules(db: TabulaDb): Promise<void> {
    const due = await sql<{ id: string; base_id: string; workspace_id: string; trigger: TriggerDef; next_run_at: Date | null }>`
      SELECT id, base_id, workspace_id, trigger, next_run_at
      FROM data.automations
      WHERE enabled AND deleted_at IS NULL AND trigger->>'type' = 'scheduled'
        AND (next_run_at IS NULL OR next_run_at <= now())
      LIMIT 100
    `.execute(db);
    for (const a of due.rows) {
      const parsed = scheduleSchema.safeParse(a.trigger.config?.schedule ?? {});
      const schedule = parsed.success ? parsed.data : scheduleSchema.parse({});
      const now = new Date();
      if (a.next_run_at) {
        await insertRun(db, {
          automationId: a.id,
          baseId: a.base_id,
          workspaceId: a.workspace_id,
          triggerType: "scheduled",
          triggerKey: `sched:${a.next_run_at.toISOString()}`,
          payload: { scheduledAt: a.next_run_at.toISOString() },
          depth: 0,
        });
      }
      const next = nextScheduledRun(schedule, now);
      await sql`UPDATE data.automations SET next_run_at = ${next} WHERE id = ${a.id}`.execute(db);
    }
  }

  start(intervalMs = 1000): void {
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        this.deps.log.error({ err }, "automation engine tick failed");
      }
      if (!this.stopped) this.timer = setTimeout(() => void loop(), intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

function toUuidSafe(recPid: string): string | null {
  if (UUID_RE.test(recPid)) return recPid;
  try {
    // decode via toPid's inverse
    return decodeRec(recPid);
  } catch {
    return null;
  }
}

function decodeRec(p: string): string {
  return decodePublicId(p, "rec").uuid;
}

const slotCache = new Map<string, { at: number; map: Map<string, string> }>();
async function slotToFieldMap(db: TabulaDb, tableId: string | null): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!tableId) return map;
  const tableUuid = UUID_RE.test(tableId) ? tableId : (() => {
    try {
      return decodePublicId(tableId, "tbl").uuid;
    } catch {
      return null;
    }
  })();
  if (!tableUuid) return map;
  const cached = slotCache.get(tableUuid);
  if (cached && Date.now() - cached.at < 30_000) return cached.map;
  const rows = await sql<{ id: string; slot: number }>`
    SELECT id, slot FROM data.fields WHERE table_id = ${tableUuid}
  `.execute(db);
  for (const r of rows.rows) map.set(String(r.slot), pid("fld", r.id));
  slotCache.set(tableUuid, { at: Date.now(), map });
  return map;
}

export async function insertRun(
  db: TabulaDb,
  run: {
    automationId: string;
    baseId: string;
    workspaceId: string;
    triggerType: string;
    triggerKey: string;
    payload: Record<string, unknown>;
    depth: number;
    isTest?: boolean;
  },
): Promise<string | null> {
  const res = await sql<{ id: string }>`
    INSERT INTO data.automation_runs (
      automation_id, base_id, workspace_id, trigger_type, trigger_key, trigger_payload,
      causation_depth, is_test
    ) VALUES (
      ${run.automationId}, ${run.baseId}, ${run.workspaceId}, ${run.triggerType}, ${run.triggerKey},
      ${JSON.stringify(run.payload)}::jsonb, ${run.depth}, ${run.isTest ?? false}
    )
    ON CONFLICT (automation_id, trigger_key) DO NOTHING
    RETURNING id
  `.execute(db);
  return res.rows[0]?.id ?? null;
}

/** Start the automation engine (consumer + scheduler + executor) in this process. */
export function startAutomationEngine(deps: EngineDeps, intervalMs = 1000): AutomationConsumer {
  const consumer = new AutomationConsumer(deps);
  consumer.start(intervalMs);
  deps.log.info({ intervalMs }, "Automation engine started (outbox consumer, scheduler, executor)");
  return consumer;
}
