import { generateUuidV7 } from "@tabula/types";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authorize, type Action } from "@tabula/permissions";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import {
  forbidden,
  handleRouteError,
  notFound,
  sendApiError,
  unauthorized,
  validationProblem,
} from "../../http/errors.js";
import { compileForUser } from "../access/compile.js";
import { writeAuditEvent } from "../audit/write.js";
import { insertRun } from "./consumer.js";
import { executeRun, type EngineDeps } from "./engine.js";
import { AuthRateLimiter } from "../auth/rate-limit.js";
import { actionsSchema, triggerSchema, type ActionDef, type StepResult, type TriggerDef } from "./types.js";

const MAX_AUTOMATIONS = 150;

const createBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  trigger: triggerSchema.optional(),
  actions: actionsSchema.optional(),
  enabled: z.boolean().optional(),
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  trigger: triggerSchema.optional(),
  actions: actionsSchema.optional(),
  enabled: z.boolean().optional(),
});

const testBody = z.object({
  recordId: z.string().optional(),
  body: z.unknown().optional(),
});

const triggerBody = z.object({
  recordId: z.string(),
  tableId: z.string().optional(),
  fieldId: z.string().optional(),
});

interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerDef;
  actions: ActionDef[];
  webhook_token: string | null;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  next_run_at: Date | null;
  last_status: string | null;
  last_run_created: Date | null;
}

interface RunRow {
  id: string;
  trigger_type: string;
  trigger_payload: Record<string, unknown>;
  is_test: boolean;
  status: string;
  attempts: number;
  steps: StepResult[];
  error: string | null;
  causation_depth: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function runDto(r: RunRow) {
  return {
    id: pid("run", r.id),
    triggerType: r.trigger_type,
    trigger: r.trigger_payload,
    isTest: r.is_test,
    status: r.status,
    attempts: r.attempts,
    steps: r.steps ?? [],
    error: r.error,
    causationDepth: r.causation_depth,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

/** Assign stable ids to actions (and nested branch actions) that lack one. */
function ensureActionIds(actions: ActionDef[]): ActionDef[] {
  const seen = new Set<string>();
  const walk = (list: ActionDef[]): ActionDef[] =>
    list.map((a) => {
      let id = a.id;
      if (!id || seen.has(id)) id = `a${randomBytes(4).toString("hex")}`;
      seen.add(id);
      const config = { ...(a.config ?? {}) };
      if (Array.isArray(config.then)) config.then = walk(config.then);
      if (Array.isArray(config.else)) config.else = walk(config.else);
      return { ...a, id, config };
    });
  return walk(actions);
}

export async function registerAutomationsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const deps: EngineDeps = { db: ctx.db, env: ctx.env, log: ctx.log };
  const hookLimiter = new AuthRateLimiter(ctx.redis, "tabula:rl:hook:");

  const webhookUrl = (token: string | null) =>
    token ? `${ctx.env.API_URL}/v1/hooks/${token}` : null;

  function dto(r: AutomationRow) {
    return {
      id: pid("aut", r.id),
      name: r.name,
      enabled: r.enabled,
      trigger: r.trigger,
      actions: r.actions,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      lastRunAt: r.last_run_at?.toISOString() ?? null,
      nextRunAt: r.next_run_at?.toISOString() ?? null,
      lastRunStatus: r.last_status,
      webhookUrl: r.trigger?.type === "webhook.received" ? webhookUrl(r.webhook_token) : null,
    };
  }

  /** Resolve base + permission; sends 401/404/403 and returns null on failure. */
  async function requireBase(
    request: FastifyRequest<{ Params: { baseId: string } }>,
    reply: FastifyReply,
    action: Action,
  ): Promise<{ baseId: string; workspaceId: string; userId: string } | null> {
    const user = request.user;
    if (!user) {
      unauthorized(request, reply);
      return null;
    }
    const baseId = parsePid(request.params.baseId, "bas");
    const snap = await compileForUser(ctx.db, user.id, baseId);
    if (!snap.effectiveBaseRole) {
      notFound(request, reply, "Base not found");
      return null;
    }
    if (!authorize(snap, action)) {
      forbidden(request, reply, `Missing permission: ${action}`);
      return null;
    }
    return { baseId, workspaceId: snap.workspaceId, userId: user.id };
  }

  async function loadAutomation(baseId: string, automationId: string): Promise<AutomationRow | null> {
    const res = await sql<AutomationRow>`
      SELECT a.id, a.name, a.enabled, a.trigger, a.actions, a.webhook_token, a.created_at, a.updated_at,
             a.last_run_at, a.next_run_at,
             lr.status AS last_status, lr.created_at AS last_run_created
      FROM data.automations a
      LEFT JOIN LATERAL (
        SELECT status, created_at FROM data.automation_runs
        WHERE automation_id = a.id AND NOT is_test ORDER BY created_at DESC LIMIT 1
      ) lr ON true
      WHERE a.id = ${automationId} AND a.base_id = ${baseId} AND a.deleted_at IS NULL
    `.execute(ctx.db);
    return res.rows[0] ?? null;
  }

  app.get<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/automations",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.read");
        if (!base) return;
        const result = await sql<AutomationRow>`
          SELECT a.id, a.name, a.enabled, a.trigger, a.actions, a.webhook_token, a.created_at, a.updated_at,
                 a.last_run_at, a.next_run_at,
                 lr.status AS last_status, lr.created_at AS last_run_created
          FROM data.automations a
          LEFT JOIN LATERAL (
            SELECT status, created_at FROM data.automation_runs
            WHERE automation_id = a.id AND NOT is_test ORDER BY created_at DESC LIMIT 1
          ) lr ON true
          WHERE a.base_id = ${base.baseId} AND a.deleted_at IS NULL
          ORDER BY a.created_at ASC
        `.execute(ctx.db);
        void reply.send({
          automations: result.rows.map(dto),
          limits: {
            maxAutomations: MAX_AUTOMATIONS,
            remaining: Math.max(0, MAX_AUTOMATIONS - result.rows.length),
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.read");
        if (!base) return;
        const row = await loadAutomation(base.baseId, parsePid(request.params.automationId, "aut"));
        if (!row) {
          notFound(request, reply, "Automation not found");
          return;
        }
        void reply.send({ automation: dto(row) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/automations",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.manage_schema");
        if (!base) return;
        const body = createBody.parse(request.body ?? {});

        const count = await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM data.automations
          WHERE base_id = ${base.baseId} AND deleted_at IS NULL
        `.execute(ctx.db);
        if (Number(count.rows[0]?.n ?? 0) >= MAX_AUTOMATIONS) {
          sendApiError(request, reply, 422, "PLAN_LIMIT_EXCEEDED", `This base can have up to ${MAX_AUTOMATIONS} automations`);
          return;
        }

        const id = generateUuidV7();
        const name = body.name?.trim() || "Untitled automation";
        const trigger: TriggerDef = body.trigger ?? { type: "record.created", config: {} };
        const actions = ensureActionIds(body.actions ?? []);
        const token = trigger.type === "webhook.received" ? randomBytes(24).toString("base64url") : null;

        await sql`
          INSERT INTO data.automations (
            id, workspace_id, base_id, name, enabled, trigger, actions, created_by, updated_by, webhook_token
          ) VALUES (
            ${id}, ${base.workspaceId}, ${base.baseId}, ${name}, ${body.enabled ?? false},
            ${JSON.stringify(trigger)}::jsonb, ${JSON.stringify(actions)}::jsonb, ${base.userId}, ${base.userId},
            ${token}
          )
        `.execute(ctx.db);
        await writeAuditEvent(ctx.db, {
          workspaceId: base.workspaceId,
          actorUserId: base.userId,
          action: "automation.created",
          targetType: "automation",
          targetId: id,
          metadata: { name, trigger: trigger.type },
        });

        const row = await loadAutomation(base.baseId, id);
        void reply.code(201).send({ automation: row ? dto(row) : { id: pid("aut", id), name } });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.manage_schema");
        if (!base) return;
        const automationId = parsePid(request.params.automationId, "aut");
        const body = patchBody.parse(request.body ?? {});
        const existing = await loadAutomation(base.baseId, automationId);
        if (!existing) {
          notFound(request, reply, "Automation not found");
          return;
        }

        const trigger = body.trigger ?? existing.trigger;
        const triggerChanged = body.trigger !== undefined && JSON.stringify(body.trigger) !== JSON.stringify(existing.trigger);
        const actions = body.actions !== undefined ? ensureActionIds(body.actions) : existing.actions;
        const enabled = body.enabled ?? existing.enabled;
        const token =
          trigger.type === "webhook.received"
            ? existing.webhook_token ?? randomBytes(24).toString("base64url")
            : existing.webhook_token;

        await sql`
          UPDATE data.automations
          SET name = ${body.name ?? existing.name},
              enabled = ${enabled},
              trigger = ${JSON.stringify(trigger)}::jsonb,
              actions = ${JSON.stringify(actions)}::jsonb,
              webhook_token = ${token},
              next_run_at = ${triggerChanged || (enabled && !existing.enabled) ? null : existing.next_run_at},
              updated_by = ${base.userId},
              updated_at = now()
          WHERE id = ${automationId}
        `.execute(ctx.db);
        if (triggerChanged) {
          await sql`DELETE FROM data.automation_record_state WHERE automation_id = ${automationId}`.execute(ctx.db);
        }
        if (body.enabled !== undefined && body.enabled !== existing.enabled) {
          await writeAuditEvent(ctx.db, {
            workspaceId: base.workspaceId,
            actorUserId: base.userId,
            action: body.enabled ? "automation.enabled" : "automation.disabled",
            targetType: "automation",
            targetId: automationId,
          });
        }
        const row = await loadAutomation(base.baseId, automationId);
        void reply.send({ ok: true, automation: row ? dto(row) : null });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId/duplicate",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.manage_schema");
        if (!base) return;
        const existing = await loadAutomation(base.baseId, parsePid(request.params.automationId, "aut"));
        if (!existing) {
          notFound(request, reply, "Automation not found");
          return;
        }
        const id = generateUuidV7();
        const token = existing.trigger?.type === "webhook.received" ? randomBytes(24).toString("base64url") : null;
        await sql`
          INSERT INTO data.automations (id, workspace_id, base_id, name, enabled, trigger, actions, created_by, updated_by, webhook_token)
          VALUES (${id}, ${base.workspaceId}, ${base.baseId}, ${`${existing.name} (copy)`.slice(0, 200)}, false,
                  ${JSON.stringify(existing.trigger)}::jsonb, ${JSON.stringify(existing.actions)}::jsonb,
                  ${base.userId}, ${base.userId}, ${token})
        `.execute(ctx.db);
        const row = await loadAutomation(base.baseId, id);
        void reply.code(201).send({ automation: row ? dto(row) : null });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.manage_schema");
        if (!base) return;
        const automationId = parsePid(request.params.automationId, "aut");
        const res = await sql`
          UPDATE data.automations
          SET deleted_at = now(), deleted_by = ${base.userId}, enabled = false, updated_at = now()
          WHERE id = ${automationId} AND base_id = ${base.baseId} AND deleted_at IS NULL
        `.execute(ctx.db);
        if (Number(res.numAffectedRows ?? 0n) === 0) {
          notFound(request, reply, "Automation not found");
          return;
        }
        await sql`
          UPDATE data.automation_runs SET status = 'skipped', error = 'Automation deleted', finished_at = now()
          WHERE automation_id = ${automationId} AND status = 'pending'
        `.execute(ctx.db);
        await writeAuditEvent(ctx.db, {
          workspaceId: base.workspaceId,
          actorUserId: base.userId,
          action: "automation.deleted",
          targetType: "automation",
          targetId: automationId,
        });
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string; automationId: string }; Querystring: { limit?: string; includeTests?: string } }>(
    "/v1/bases/:baseId/automations/:automationId/runs",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.read");
        if (!base) return;
        const automationId = parsePid(request.params.automationId, "aut");
        const exists = await loadAutomation(base.baseId, automationId);
        if (!exists) {
          notFound(request, reply, "Automation not found");
          return;
        }
        const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
        const includeTests = request.query.includeTests !== "false";
        const res = await sql<RunRow>`
          SELECT id, trigger_type, trigger_payload, is_test, status, attempts, steps, error,
                 causation_depth, created_at, started_at, finished_at
          FROM data.automation_runs
          WHERE automation_id = ${automationId} AND (${includeTests} OR NOT is_test)
          ORDER BY created_at DESC
          LIMIT ${limit}
        `.execute(ctx.db);
        void reply.send({ runs: res.rows.map(runDto) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string; automationId: string; runId: string } }>(
    "/v1/bases/:baseId/automations/:automationId/runs/:runId",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.read");
        if (!base) return;
        const automationId = parsePid(request.params.automationId, "aut");
        const runId = parsePid(request.params.runId, "run");
        const res = await sql<RunRow>`
          SELECT r.id, r.trigger_type, r.trigger_payload, r.is_test, r.status, r.attempts, r.steps, r.error,
                 r.causation_depth, r.created_at, r.started_at, r.finished_at
          FROM data.automation_runs r
          WHERE r.id = ${runId} AND r.automation_id = ${automationId} AND r.base_id = ${base.baseId}
        `.execute(ctx.db);
        if (!res.rows[0]) {
          notFound(request, reply, "Run not found");
          return;
        }
        void reply.send({ run: runDto(res.rows[0]) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  /**
   * Test run: executes the automation's actions right now (synchronously) with
   * the chosen record (or webhook body) as the trigger, even when turned off.
   */
  app.post<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId/test",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.manage_schema");
        if (!base) return;
        const automationId = parsePid(request.params.automationId, "aut");
        const body = testBody.parse(request.body ?? {});
        const auto = await loadAutomation(base.baseId, automationId);
        if (!auto) {
          notFound(request, reply, "Automation not found");
          return;
        }
        const tableId = auto.trigger?.config?.tableId;
        const needsRecord = !["scheduled", "webhook.received"].includes(auto.trigger?.type);
        if (needsRecord && !body.recordId) {
          validationProblem(request, reply, "Choose a record to test with");
          return;
        }
        if (needsRecord && !tableId) {
          validationProblem(request, reply, "Choose a table for the trigger first");
          return;
        }
        const payload: Record<string, unknown> = {
          ...(tableId ? { tableId } : {}),
          ...(body.recordId ? { recordId: body.recordId } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(auto.trigger?.type === "scheduled" ? { scheduledAt: new Date().toISOString() } : {}),
          userId: pid("usr", base.userId),
          userName: request.user!.displayName,
          userEmail: request.user!.email,
        };
        const runId = await insertRun(ctx.db, {
          automationId,
          baseId: base.baseId,
          workspaceId: base.workspaceId,
          triggerType: auto.trigger?.type ?? "record.created",
          triggerKey: `test:${generateUuidV7()}`,
          payload,
          depth: 0,
          isTest: true,
        });
        if (!runId) throw new Error("Could not create test run");
        await sql`
          UPDATE data.automation_runs
          SET status = 'running', attempts = 1, started_at = now(), locked_until = now() + interval '5 minutes'
          WHERE id = ${runId}
        `.execute(ctx.db);
        await executeRun(deps, runId);
        const res = await sql<RunRow>`
          SELECT id, trigger_type, trigger_payload, is_test, status, attempts, steps, error,
                 causation_depth, created_at, started_at, finished_at
          FROM data.automation_runs WHERE id = ${runId}
        `.execute(ctx.db);
        void reply.send({ run: runDto(res.rows[0]!) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  /** Button field click → run a `button.clicked` automation for that record. */
  app.post<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId/trigger",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "record.update");
        if (!base) return;
        const automationId = parsePid(request.params.automationId, "aut");
        const body = triggerBody.parse(request.body ?? {});
        parsePid(body.recordId, "rec");
        const auto = await loadAutomation(base.baseId, automationId);
        if (!auto) {
          notFound(request, reply, "Automation not found");
          return;
        }
        if (auto.trigger?.type !== "button.clicked") {
          validationProblem(request, reply, "This automation is not triggered by a button");
          return;
        }
        if (!auto.enabled) {
          sendApiError(request, reply, 409, "AUTOMATION_DISABLED", "This automation is turned off");
          return;
        }
        const tableId = auto.trigger.config?.tableId ?? body.tableId;
        const runId = await insertRun(ctx.db, {
          automationId,
          baseId: base.baseId,
          workspaceId: base.workspaceId,
          triggerType: "button.clicked",
          triggerKey: `button:${generateUuidV7()}`,
          payload: {
            ...(tableId ? { tableId } : {}),
            recordId: body.recordId,
            ...(body.fieldId ? { fieldId: body.fieldId } : {}),
            userId: pid("usr", base.userId),
            userName: request.user!.displayName,
            userEmail: request.user!.email,
          },
          depth: 0,
        });
        void reply.code(202).send({ runId: runId ? pid("run", runId) : null, status: "pending" });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId/webhook-token",
    async (request, reply) => {
      try {
        const base = await requireBase(request, reply, "base.manage_schema");
        if (!base) return;
        const automationId = parsePid(request.params.automationId, "aut");
        const token = randomBytes(24).toString("base64url");
        const res = await sql`
          UPDATE data.automations SET webhook_token = ${token}, updated_at = now()
          WHERE id = ${automationId} AND base_id = ${base.baseId} AND deleted_at IS NULL
        `.execute(ctx.db);
        if (Number(res.numAffectedRows ?? 0n) === 0) {
          notFound(request, reply, "Automation not found");
          return;
        }
        void reply.send({ webhookUrl: webhookUrl(token) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  /** Public incoming webhook → enqueue a run of the matching automation. */
  app.post<{ Params: { token: string } }>("/v1/hooks/:token", async (request, reply) => {
    try {
      const token = request.params.token;
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
        notFound(request, reply, "Webhook not found");
        return;
      }
      const rl = await hookLimiter.hit(token, 300, 60);
      if (!rl.allowed) {
        void reply.header("retry-after", String(rl.retryAfterSec));
        sendApiError(request, reply, 429, "RATE_LIMITED", "Too many webhook calls");
        return;
      }
      const res = await sql<{ id: string; base_id: string; workspace_id: string; enabled: boolean; trigger: TriggerDef }>`
        SELECT id, base_id, workspace_id, enabled, trigger FROM data.automations
        WHERE webhook_token = ${token} AND deleted_at IS NULL
        LIMIT 1
      `.execute(ctx.db);
      const auto = res.rows[0];
      if (!auto || auto.trigger?.type !== "webhook.received") {
        notFound(request, reply, "Webhook not found");
        return;
      }
      if (!auto.enabled) {
        sendApiError(request, reply, 409, "AUTOMATION_DISABLED", "This automation is turned off");
        return;
      }
      const raw = request.body;
      const bodySize = raw === undefined ? 0 : JSON.stringify(raw).length;
      if (bodySize > 100_000) {
        sendApiError(request, reply, 413, "BAD_REQUEST", "Webhook body is too large (max 100 KB)");
        return;
      }
      const runId = await insertRun(ctx.db, {
        automationId: auto.id,
        baseId: auto.base_id,
        workspaceId: auto.workspace_id,
        triggerType: "webhook.received",
        triggerKey: `hook:${generateUuidV7()}`,
        payload: { body: raw ?? null, query: request.query ?? {} },
        depth: 0,
      });
      void reply.code(202).send({ ok: true, runId: runId ? pid("run", runId) : null });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });
}
