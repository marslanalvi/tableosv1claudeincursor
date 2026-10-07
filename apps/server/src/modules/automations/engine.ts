import type { Env } from "@tabula/config";
import type { TabulaDb } from "@tabula/db";
import { decodePublicId, generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pid } from "../../lib/public-ids.js";
import { compileForUser } from "../access/compile.js";
import { createServiceSession, revokeSession } from "../auth/session.js";
import { AutomationApiClient, AutomationApiError, type BaseDetailLite } from "./api-client.js";
import { evaluateWireFilter } from "./filter-eval.js";
import { sendEmail } from "./mailer.js";
import {
  compareCondition,
  interpolate,
  interpolateDeep,
  interpolateValue,
  recordContext,
  type TableMeta,
  type WireRecord,
} from "./tokens.js";
import type { ActionDef, StepResult, TriggerDef } from "./types.js";

export interface EngineDeps {
  db: TabulaDb;
  env: Env;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/** Error carrying a retry hint. */
export class StepError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "StepError";
  }
}

interface RunRow {
  id: string;
  automation_id: string;
  base_id: string;
  workspace_id: string;
  trigger_type: string;
  trigger_payload: Record<string, unknown>;
  is_test: boolean;
  causation_depth: number;
  attempts: number;
  max_attempts: number;
  steps: StepResult[];
  a_name: string;
  a_enabled: boolean;
  a_deleted: boolean;
  a_trigger: TriggerDef;
  a_actions: ActionDef[];
  a_owner: string | null;
  org_id: string | null;
}

export function toUuid(id: string | undefined | null, prefix: Parameters<typeof pid>[0]): string | null {
  if (!id) return null;
  if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  try {
    return decodePublicId(id, prefix).uuid;
  } catch {
    return null;
  }
}

export function toPid(id: string | undefined | null, prefix: Parameters<typeof pid>[0]): string | null {
  if (!id) return null;
  if (id.startsWith(`${prefix}_`)) return id;
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    try {
      return pid(prefix, id);
    } catch {
      return null;
    }
  }
  return null;
}

/** Normalise field ids inside a filter AST to fld_ public ids. */
export function normalizeFilterIds(filter: unknown): unknown {
  if (!filter || typeof filter !== "object") return filter;
  const f = filter as Record<string, unknown>;
  if (f["kind"] === "condition") {
    const fid = String(f["fieldId"] ?? "");
    return { ...f, fieldId: toPid(fid, "fld") ?? fid };
  }
  if (Array.isArray(f["children"])) {
    return { ...f, children: (f["children"] as unknown[]).map(normalizeFilterIds) };
  }
  return filter;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// SSRF guard for the webhook action (blocks private / loopback / link-local).
// Set AUTOMATION_WEBHOOK_ALLOW_PRIVATE=1 to allow private targets in dev.
// ---------------------------------------------------------------------------
function privateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x))) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind === 6) {
    const n = ip.toLowerCase();
    if (n === "::1" || n === "::") return true;
    if (n.startsWith("fe8") || n.startsWith("fe9") || n.startsWith("fea") || n.startsWith("feb")) return true;
    if (n.startsWith("fc") || n.startsWith("fd")) return true;
    const mapped = n.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateV4(mapped[1]!);
    return false;
  }
  return true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StepError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StepError("Only http(s) URLs are allowed");
  }
  if (process.env["AUTOMATION_WEBHOOK_ALLOW_PRIVATE"] === "1") return url;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new StepError("Requests to private or internal hosts are blocked");
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
    throw new StepError(`Could not resolve host ${host}`, true);
  });
  for (const a of addrs) {
    if (privateIp(a.address)) {
      throw new StepError("Requests to private or internal hosts are blocked");
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  deps: EngineDeps;
  run: RunRow;
  client: AutomationApiClient;
  base: BaseDetailLite;
  baseId: string; // bas_
  triggerTable: TableMeta | undefined;
  triggerRecord: WireRecord | null;
  tokens: Record<string, unknown>;
}

function tableById(base: BaseDetailLite, tableId: string | undefined | null): TableMeta | undefined {
  if (!tableId) return undefined;
  const p = toPid(tableId, "tbl") ?? tableId;
  return base.tables.find((t) => t.id === p);
}

async function buildFieldInput(
  table: TableMeta,
  mapping: Record<string, unknown> | undefined,
  tokens: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(mapping ?? {})) {
    const field =
      table.fields.find((f) => f.id === key) ??
      table.fields.find((f) => f.id === toPid(key, "fld")) ??
      table.fields.find((f) => f.name.toLowerCase() === key.toLowerCase());
    if (!field) throw new StepError(`Field ${key} does not exist in table ${table.name}`);
    let value = interpolateValue(template, tokens);
    // Link/collaborator/attachment fields want arrays of ids.
    if (value && typeof value === "string" && ["link", "collaborator", "attachment", "multi_select"].includes(field.type)) {
      value = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (Array.isArray(value) && ["link", "collaborator", "attachment"].includes(field.type)) {
      value = value.map((v) => (v && typeof v === "object" && "id" in (v as object) ? (v as { id: string }).id : v));
    }
    if (field.type === "number" || field.type === "currency" || field.type === "percent" || field.type === "rating" || field.type === "duration") {
      if (value === "" || value === null) value = null;
      else if (typeof value === "string" && !Number.isNaN(Number(value))) value = Number(value);
    }
    if (field.type === "checkbox" && typeof value === "string") {
      value = ["true", "1", "yes", "checked", "on"].includes(value.trim().toLowerCase());
    }
    out[field.id] = value === "" ? null : value;
  }
  return out;
}

function recordIdFrom(template: string | undefined, tokens: Record<string, unknown>): string {
  const v = interpolateValue(template ?? "{{trigger.record.id}}", tokens);
  const id = Array.isArray(v) ? v[0] : v;
  const s = typeof id === "object" && id ? String((id as { id?: unknown }).id ?? "") : String(id ?? "");
  const p = toPid(s.trim(), "rec");
  if (!p) throw new StepError(`"${s}" is not a record id`);
  return p;
}

async function runAction(ex: ExecCtx, action: ActionDef): Promise<StepResult> {
  const startedAt = nowIso();
  const base: Pick<StepResult, "actionId" | "type" | "startedAt"> & { name?: string } = {
    actionId: action.id,
    type: action.type,
    startedAt,
    ...(action.name ? { name: action.name } : {}),
  };
  const cfg = action.config ?? {};
  try {
    let output: unknown;
    switch (action.type) {
      case "update_record": {
        const table = tableById(ex.base, cfg.tableId) ?? ex.triggerTable;
        if (!table) throw new StepError("Choose a table for “Update record”");
        const recordId = recordIdFrom(cfg.recordId, ex.tokens);
        const fields = await buildFieldInput(table, cfg.fields, ex.tokens);
        if (Object.keys(fields).length === 0) throw new StepError("Choose at least one field to update");
        const rec = await ex.client.updateRecord(ex.baseId, table.id, recordId, fields);
        output = { record: recordContext(table, rec, ex.deps.env.APP_URL, ex.baseId) };
        break;
      }
      case "create_record": {
        const table = tableById(ex.base, cfg.tableId) ?? ex.triggerTable;
        if (!table) throw new StepError("Choose a table for “Create record”");
        const fields = await buildFieldInput(table, cfg.fields, ex.tokens);
        const rec = await ex.client.createRecord(ex.baseId, table.id, fields);
        output = { record: recordContext(table, rec, ex.deps.env.APP_URL, ex.baseId) };
        break;
      }
      case "find_records": {
        const table = tableById(ex.base, cfg.tableId) ?? ex.triggerTable;
        if (!table) throw new StepError("Choose a table for “Find records”");
        const filter = cfg.filter ? normalizeFilterIds(interpolateFilterValues(cfg.filter, ex.tokens)) : undefined;
        const limit = cfg.limit ?? 25;
        const recs = await ex.client.queryRecords(ex.baseId, table.id, {
          ...(filter ? { filter } : {}),
          ...(cfg.viewId ? { viewId: toPid(cfg.viewId, "viw") ?? cfg.viewId } : {}),
          pageSize: limit,
        });
        const records = recs.slice(0, limit).map((r) => recordContext(table, r, ex.deps.env.APP_URL, ex.baseId));
        output = { records, count: records.length, first: records[0] ?? null, ids: records.map((r) => r["id"]) };
        break;
      }
      case "delete_record": {
        const table = tableById(ex.base, cfg.tableId) ?? ex.triggerTable;
        if (!table) throw new StepError("Choose a table for “Delete record”");
        const recordId = recordIdFrom(cfg.recordId, ex.tokens);
        await ex.client.deleteRecord(ex.baseId, table.id, recordId);
        output = { deletedRecordId: recordId };
        break;
      }
      case "notify": {
        output = await notifyAction(ex, cfg);
        break;
      }
      case "send_email": {
        const to = interpolate(cfg.to ?? "", ex.tokens)
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (to.length === 0) throw new StepError("“To” resolved to no email addresses");
        const cc = interpolate(cfg.cc ?? "", ex.tokens)
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const subject = interpolate(cfg.subject ?? `Message from ${ex.run.a_name}`, ex.tokens);
        const text = interpolate(cfg.body ?? "", ex.tokens);
        const res = await sendEmail(ex.deps.db, {
          to,
          cc,
          subject,
          text,
          orgId: ex.run.org_id,
          workspaceId: ex.run.workspace_id,
          source: "automation",
          sourceId: ex.run.automation_id,
        });
        if (res.status === "failed") throw new StepError(`Email delivery failed: ${res.error}`, true);
        output = { emailId: res.id, status: res.status, to, subject };
        break;
      }
      case "webhook": {
        output = await webhookAction(ex, cfg);
        break;
      }
      case "condition": {
        let matched: boolean;
        if (cfg.filter && ex.triggerRecord && ex.triggerTable) {
          matched = evaluateWireFilter(normalizeFilterIds(cfg.filter), ex.triggerRecord, ex.triggerTable.fields);
        } else {
          const conds = cfg.conditions ?? [];
          const results = conds.map((c) =>
            compareCondition(interpolate(c.left, ex.tokens), c.op, c.right === undefined ? undefined : interpolate(c.right, ex.tokens)),
          );
          matched = conds.length === 0 ? true : cfg.match === "any" ? results.some(Boolean) : results.every(Boolean);
        }
        const branch = matched ? cfg.then ?? [] : cfg.else ?? [];
        const nested: StepResult[] = [];
        for (const child of branch) {
          const r = await runAction(ex, child);
          nested.push(r);
          if (r.status === "failed") {
            return {
              ...base,
              status: "failed",
              finishedAt: nowIso(),
              branch: matched ? "then" : "else",
              steps: nested,
              output: { matched },
              error: `${child.name ?? child.type}: ${r.error ?? "failed"}`,
            };
          }
        }
        ex.tokens["steps"] = { ...(ex.tokens["steps"] as object), [action.id]: { matched } };
        return {
          ...base,
          status: "succeeded",
          finishedAt: nowIso(),
          branch: branch.length === 0 && !(matched ? cfg.then?.length : cfg.else?.length) ? "none" : matched ? "then" : "else",
          steps: nested,
          output: { matched },
        };
      }
      default:
        throw new StepError(`Unknown action type ${String(action.type)}`);
    }
    ex.tokens["steps"] = { ...(ex.tokens["steps"] as object), [action.id]: output };
    return { ...base, status: "succeeded", finishedAt: nowIso(), output };
  } catch (err) {
    const retryable =
      err instanceof StepError ? err.retryable : err instanceof AutomationApiError ? err.retryable : false;
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, status: "failed", finishedAt: nowIso(), error: message, ...(retryable ? { output: { retryable: true } } : {}) };
  }
}

function interpolateFilterValues(filter: unknown, tokens: Record<string, unknown>): unknown {
  if (!filter || typeof filter !== "object") return filter;
  const f = filter as Record<string, unknown>;
  if (f["kind"] === "condition") {
    const v = f["value"];
    return { ...f, value: typeof v === "string" ? interpolateValue(v, tokens) : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? interpolate(x, tokens) : x)) : v };
  }
  if (Array.isArray(f["children"])) {
    return { ...f, children: (f["children"] as unknown[]).map((c) => interpolateFilterValues(c, tokens)) };
  }
  return filter;
}

async function notifyAction(ex: ExecCtx, cfg: ActionDef["config"]): Promise<unknown> {
  const recipients = new Set<string>();
  for (const u of cfg.userIds ?? []) {
    const resolved = interpolate(u, ex.tokens);
    for (const part of resolved.split(",")) {
      const id = toUuid(part.trim(), "usr");
      if (id) recipients.add(id);
    }
  }
  if (cfg.collaboratorFieldId && ex.triggerRecord) {
    const fid = toPid(cfg.collaboratorFieldId, "fld") ?? cfg.collaboratorFieldId;
    const raw = ex.triggerRecord.fields[fid];
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const v of arr) {
      const id = toUuid(typeof v === "object" && v ? String((v as { id?: unknown }).id ?? "") : String(v), "usr");
      if (id) recipients.add(id);
    }
  }
  if (recipients.size === 0) throw new StepError("No recipients: choose users or a collaborator field");
  const title = interpolate(cfg.title ?? ex.run.a_name, ex.tokens).slice(0, 500);
  const message = interpolate(cfg.message ?? "", ex.tokens);
  const delivered: string[] = [];
  const skipped: string[] = [];
  for (const userId of recipients) {
    // Only notify people who can see this base.
    const snap = await compileForUser(ex.deps.db, userId, ex.run.base_id);
    if (!snap.effectiveBaseRole) {
      skipped.push(pid("usr", userId));
      continue;
    }
    await sql`
      INSERT INTO core.notifications (id, user_id, workspace_id, base_id, category, title, body)
      VALUES (
        ${generateUuidV7()}, ${userId}, ${ex.run.workspace_id}, ${ex.run.base_id}, 'automation', ${title},
        ${JSON.stringify({
          text: message,
          message,
          automationId: pid("aut", ex.run.automation_id),
          automationName: ex.run.a_name,
          baseId: ex.baseId,
          tableId: ex.triggerTable?.id ?? null,
          recordId: ex.triggerRecord?.id ?? null,
        })}::jsonb
      )
    `.execute(ex.deps.db);
    delivered.push(pid("usr", userId));
  }
  if (delivered.length === 0) throw new StepError("None of the recipients has access to this base");
  return { notified: delivered, skipped, title };
}

async function webhookAction(ex: ExecCtx, cfg: ActionDef["config"]): Promise<unknown> {
  const rawUrl = interpolate(cfg.url ?? "", ex.tokens).trim();
  if (!rawUrl) throw new StepError("Enter a URL for “Send webhook”");
  const url = await assertPublicUrl(rawUrl);
  const method = cfg.method ?? "POST";
  let body: string | undefined;
  if (method !== "GET") {
    if (cfg.body && cfg.body.trim()) {
      body = interpolate(cfg.body, ex.tokens);
    } else {
      body = JSON.stringify({
        automation: { id: pid("aut", ex.run.automation_id), name: ex.run.a_name },
        runId: pid("run", ex.run.id),
        trigger: ex.tokens["trigger"],
        steps: ex.tokens["steps"],
      });
    }
  }
  const headers: Record<string, string> = {
    "user-agent": "Tabula-Automations/1.0",
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
  };
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    if (/^(host|content-length|cookie)$/i.test(k)) continue;
    headers[k] = interpolate(v, ex.tokens);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "TimeoutError" ? "Request timed out" : err.message) : String(err);
    throw new StepError(`Webhook request failed: ${msg}`, true);
  }
  const text = (await res.text().catch(() => "")).slice(0, 4000);
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (res.status >= 300) {
    throw new StepError(`Webhook responded with HTTP ${res.status}`, res.status >= 500 || res.status === 429);
  }
  return { status: res.status, body: json ?? text };
}

async function loadRun(db: TabulaDb, runId: string): Promise<RunRow | null> {
  const res = await sql<RunRow>`
    SELECT r.id, r.automation_id, r.base_id, r.workspace_id, r.trigger_type, r.trigger_payload,
           r.is_test, r.causation_depth, r.attempts, r.max_attempts, r.steps,
           a.name AS a_name, a.enabled AS a_enabled, (a.deleted_at IS NOT NULL) AS a_deleted,
           a.trigger AS a_trigger, a.actions AS a_actions,
           COALESCE(a.updated_by, a.created_by) AS a_owner,
           bd.org_id
    FROM data.automation_runs r
    JOIN data.automations a ON a.id = r.automation_id
    LEFT JOIN core.base_directory bd ON bd.base_id = r.base_id
    WHERE r.id = ${runId}
  `.execute(db);
  return res.rows[0] ?? null;
}

async function finishRun(
  db: TabulaDb,
  run: RunRow,
  status: "succeeded" | "failed" | "skipped" | "pending",
  steps: StepResult[],
  error: string | null,
  retryDelayMs?: number,
): Promise<void> {
  if (status === "pending") {
    await sql`
      UPDATE data.automation_runs
      SET status = 'pending', steps = ${JSON.stringify(steps)}::jsonb, error = ${error},
          next_attempt_at = now() + make_interval(secs => ${Math.round((retryDelayMs ?? 30_000) / 1000)}),
          locked_until = NULL
      WHERE id = ${run.id}
    `.execute(db);
    return;
  }
  await sql`
    UPDATE data.automation_runs
    SET status = ${status}, steps = ${JSON.stringify(steps)}::jsonb, error = ${error},
        finished_at = now(), locked_until = NULL
    WHERE id = ${run.id}
  `.execute(db);
  await sql`UPDATE data.automations SET last_run_at = now() WHERE id = ${run.automation_id}`.execute(db);
}

/**
 * Execute one claimed run (status already 'running'). Successful steps of a
 * previous attempt are not repeated on retry.
 */
export async function executeRun(deps: EngineDeps, runId: string): Promise<{ status: string; error: string | null; steps: StepResult[] }> {
  const run = await loadRun(deps.db, runId);
  if (!run) return { status: "missing", error: "Run not found", steps: [] };

  if (run.a_deleted || (!run.a_enabled && !run.is_test)) {
    await finishRun(deps.db, run, "skipped", run.steps ?? [], "Automation is turned off");
    return { status: "skipped", error: "Automation is turned off", steps: [] };
  }
  if (!run.a_owner) {
    await finishRun(deps.db, run, "failed", [], "Automation has no owner");
    return { status: "failed", error: "Automation has no owner", steps: [] };
  }

  const session = await createServiceSession(deps.db, run.a_owner, 15);
  await sql`UPDATE data.automation_runs SET session_id = ${session.sessionId} WHERE id = ${run.id}`.execute(deps.db);
  const client = new AutomationApiClient(deps.env.API_URL, session.token, `aut:${run.id}`);
  const baseId = pid("bas", run.base_id);
  const previous = (run.steps ?? []).filter((s) => s.status === "succeeded");
  const steps: StepResult[] = [];

  try {
    let base: BaseDetailLite;
    try {
      base = await client.getBase(baseId);
    } catch (err) {
      const retry = err instanceof AutomationApiError && err.retryable;
      throw new StepError(`Cannot open base as the automation owner: ${err instanceof Error ? err.message : String(err)}`, retry);
    }

    const payload = run.trigger_payload ?? {};
    const triggerTable = tableById(base, (payload["tableId"] as string | undefined) ?? (run.a_trigger.config?.tableId as string | undefined));
    let triggerRecord: WireRecord | null = null;
    const recId = toPid(payload["recordId"] as string | undefined, "rec");
    if (recId && triggerTable) {
      triggerRecord = await client.getRecord(baseId, triggerTable.id, recId);
      if (!triggerRecord) throw new StepError("The triggering record no longer exists");
    }

    const tokens: Record<string, unknown> = {
      trigger: {
        type: run.trigger_type,
        ...(triggerRecord && triggerTable
          ? { record: recordContext(triggerTable, triggerRecord, deps.env.APP_URL, baseId) }
          : {}),
        ...(payload["body"] !== undefined ? { body: payload["body"] } : {}),
        ...(payload["query"] !== undefined ? { query: payload["query"] } : {}),
        ...(payload["userId"] ? { user: { id: payload["userId"], name: payload["userName"], email: payload["userEmail"] } } : {}),
        ...(payload["scheduledAt"] ? { scheduledAt: payload["scheduledAt"] } : {}),
        time: new Date().toISOString(),
      },
      automation: { id: pid("aut", run.automation_id), name: run.a_name },
      base: { id: baseId, name: base.name },
      steps: {},
      now: new Date().toISOString(),
      today: new Date().toISOString().slice(0, 10),
    };
    for (const p of previous) {
      if (p.output !== undefined) (tokens["steps"] as Record<string, unknown>)[p.actionId] = p.output;
    }

    const ex: ExecCtx = { deps, run, client, base, baseId, triggerTable, triggerRecord, tokens };
    const actions = Array.isArray(run.a_actions) ? run.a_actions : [];
    if (actions.length === 0) {
      await finishRun(deps.db, run, "succeeded", [], null);
      return { status: "succeeded", error: null, steps: [] };
    }
    for (const action of actions) {
      const done = previous.find((p) => p.actionId === action.id);
      if (done) {
        steps.push(done);
        continue;
      }
      const result = await runAction(ex, action);
      steps.push(result);
      if (result.status === "failed") {
        const retryable = Boolean((result.output as { retryable?: boolean } | undefined)?.retryable);
        const canRetry = retryable && !run.is_test && run.attempts < run.max_attempts;
        const error = `${action.name ?? action.type}: ${result.error ?? "failed"}`;
        if (canRetry) {
          const delay = 30_000 * 2 ** Math.max(0, run.attempts - 1);
          await finishRun(deps.db, run, "pending", steps, `${error} (retrying)`, delay);
          return { status: "pending", error, steps };
        }
        await finishRun(deps.db, run, "failed", steps, error);
        return { status: "failed", error, steps };
      }
    }
    await finishRun(deps.db, run, "succeeded", steps, null);
    return { status: "succeeded", error: null, steps };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof StepError ? err.retryable : err instanceof AutomationApiError ? err.retryable : true;
    if (retryable && !run.is_test && run.attempts < run.max_attempts) {
      await finishRun(deps.db, run, "pending", steps, `${message} (retrying)`, 30_000 * 2 ** Math.max(0, run.attempts - 1));
      return { status: "pending", error: message, steps };
    }
    await finishRun(deps.db, run, "failed", steps, message);
    deps.log.warn({ runId: run.id, err: message }, "automation run failed");
    return { status: "failed", error: message, steps };
  } finally {
    await revokeSession(deps.db, session.sessionId).catch(() => undefined);
  }
}

/** Claim pending runs (SKIP LOCKED) and execute them. Returns how many ran. */
export async function drainPendingRuns(deps: EngineDeps, limit = 5): Promise<number> {
  // Recover runs whose worker died mid-execution.
  await sql`
    UPDATE data.automation_runs SET status = 'pending', locked_until = NULL
    WHERE status = 'running' AND locked_until < now()
  `.execute(deps.db);
  const claimed = await sql<{ id: string }>`
    UPDATE data.automation_runs SET status = 'running', attempts = attempts + 1,
           started_at = COALESCE(started_at, now()), locked_until = now() + interval '5 minutes'
    WHERE id IN (
      SELECT id FROM data.automation_runs
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `.execute(deps.db);
  await Promise.all(
    claimed.rows.map(async (r) => {
      try {
        const res = await executeRun(deps, r.id);
        deps.log.info({ runId: r.id, status: res.status }, "automation run finished");
      } catch (err) {
        deps.log.error({ err, runId: r.id }, "automation run crashed");
        await sql`
          UPDATE data.automation_runs SET status = 'failed', error = ${err instanceof Error ? err.message : String(err)},
                 finished_at = now(), locked_until = NULL
          WHERE id = ${r.id}
        `.execute(deps.db).catch(() => undefined);
      }
    }),
  );
  return claimed.rows.length;
}
