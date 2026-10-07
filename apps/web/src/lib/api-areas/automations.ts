import { request, type FilterAst } from "../api.ts";

/** Workstream G: automations (CONTRACTS §7 key ["automations", baseId]). */

export type TriggerType =
  | "record.created"
  | "record.updated"
  | "record.matches_conditions"
  | "record.enters_view"
  | "form.submitted"
  | "scheduled"
  | "button.clicked"
  | "webhook.received";

export type ActionType =
  | "update_record"
  | "create_record"
  | "find_records"
  | "delete_record"
  | "notify"
  | "send_email"
  | "webhook"
  | "condition";

export interface ScheduleConfig {
  interval: "minutes" | "hourly" | "daily" | "weekly";
  every?: number;
  minute?: number;
  time?: string;
  weekday?: number;
  timeZone?: string;
}

export interface TriggerConfig {
  tableId?: string;
  viewId?: string;
  fieldIds?: string[];
  filter?: FilterAst | null;
  fieldId?: string;
  schedule?: ScheduleConfig;
}

export interface Trigger {
  type: TriggerType;
  config?: TriggerConfig;
}

export interface BranchCondition {
  left: string;
  op: "eq" | "neq" | "contains" | "notContains" | "empty" | "notEmpty" | "gt" | "gte" | "lt" | "lte";
  right?: string;
}

export interface ActionConfig {
  tableId?: string;
  recordId?: string;
  fields?: Record<string, unknown>;
  filter?: FilterAst | null;
  viewId?: string;
  limit?: number;
  userIds?: string[];
  collaboratorFieldId?: string | undefined;
  title?: string;
  message?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  url?: string;
  method?: "POST" | "PUT" | "PATCH" | "GET" | undefined;
  headers?: Record<string, string>;
  timeoutMs?: number;
  match?: "all" | "any";
  conditions?: BranchCondition[];
  then?: AutomationAction[];
  else?: AutomationAction[];
}

export interface AutomationAction {
  id: string;
  type: ActionType;
  name?: string;
  config: ActionConfig;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  actions: AutomationAction[];
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastRunStatus?: string | null;
  webhookUrl?: string | null;
}

export interface StepResult {
  actionId: string;
  type: string;
  name?: string;
  status: "succeeded" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  output?: unknown;
  error?: string;
  branch?: "then" | "else" | "none";
  steps?: StepResult[];
}

export interface AutomationRun {
  id: string;
  triggerType: string;
  trigger: Record<string, unknown>;
  isTest: boolean;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  attempts: number;
  steps: StepResult[];
  error: string | null;
  causationDepth: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const base = (baseId: string) => `/v1/bases/${baseId}/automations`;

export const automationsApi = {
  list(baseId: string) {
    return request<{ automations: Automation[]; limits: { maxAutomations: number; remaining: number } }>(base(baseId));
  },
  create(baseId: string, body: Partial<Pick<Automation, "name" | "enabled" | "trigger" | "actions">>) {
    return request<{ automation: Automation }>(base(baseId), { method: "POST", json: body });
  },
  update(baseId: string, id: string, body: Partial<Pick<Automation, "name" | "enabled" | "trigger" | "actions">>) {
    return request<{ ok: true; automation: Automation }>(`${base(baseId)}/${id}`, { method: "PATCH", json: body });
  },
  duplicate(baseId: string, id: string) {
    return request<{ automation: Automation }>(`${base(baseId)}/${id}/duplicate`, { method: "POST", json: {} });
  },
  remove(baseId: string, id: string) {
    return request<void>(`${base(baseId)}/${id}`, { method: "DELETE" });
  },
  runs(baseId: string, id: string, limit = 50) {
    return request<{ runs: AutomationRun[] }>(`${base(baseId)}/${id}/runs?limit=${limit}`);
  },
  test(baseId: string, id: string, body: { recordId?: string; body?: unknown }) {
    return request<{ run: AutomationRun }>(`${base(baseId)}/${id}/test`, { method: "POST", json: body });
  },
  /** Button field click (`button.clicked` trigger). */
  trigger(baseId: string, id: string, body: { recordId: string; tableId?: string; fieldId?: string }) {
    return request<{ runId: string | null; status: string }>(`${base(baseId)}/${id}/trigger`, {
      method: "POST",
      json: body,
    });
  },
  rotateWebhook(baseId: string, id: string) {
    return request<{ webhookUrl: string }>(`${base(baseId)}/${id}/webhook-token`, { method: "POST", json: {} });
  },
};
