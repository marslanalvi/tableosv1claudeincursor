import { z } from "zod";

/**
 * Automation definition (stored in data.automations.trigger / .actions).
 * All ids in configs are PUBLIC ids (tbl_/fld_/viw_/usr_).
 */
export const TRIGGER_TYPES = [
  "record.created",
  "record.updated",
  "record.matches_conditions",
  "record.enters_view",
  "form.submitted",
  "scheduled",
  "button.clicked",
  "webhook.received",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const ACTION_TYPES = [
  "update_record",
  "create_record",
  "find_records",
  "delete_record",
  "notify",
  "send_email",
  "webhook",
  "condition",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const filterAst: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("condition"),
      fieldId: z.string(),
      op: z.string(),
      value: z.unknown().optional(),
    }),
    z.object({
      kind: z.enum(["and", "or"]),
      children: z.array(filterAst),
    }),
  ]),
);

export const scheduleSchema = z.object({
  /** minutes: every N minutes · hourly: at minute M · daily: at HH:MM · weekly: weekday + HH:MM */
  interval: z.enum(["minutes", "hourly", "daily", "weekly"]).default("daily"),
  every: z.number().int().min(1).max(1440).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  /** IANA zone used for daily/weekly times (default UTC). */
  timeZone: z.string().max(100).optional(),
});
export type ScheduleConfig = z.infer<typeof scheduleSchema>;

export const triggerConfigSchema = z
  .object({
    tableId: z.string().optional(),
    viewId: z.string().optional(),
    /** record.updated: only fire when one of these fields changed (empty = any). */
    fieldIds: z.array(z.string()).max(100).optional(),
    /** record.matches_conditions */
    filter: filterAst.nullable().optional(),
    /** button.clicked: restrict to a button field */
    fieldId: z.string().optional(),
    schedule: scheduleSchema.optional(),
  })
  .passthrough();

export const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  config: triggerConfigSchema.optional(),
});
export type TriggerDef = z.infer<typeof triggerSchema>;

const fieldMap = z.record(z.string(), z.unknown());

export const actionSchema: z.ZodType<ActionDef> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(64),
    type: z.enum(ACTION_TYPES),
    name: z.string().max(200).optional(),
    config: z
      .object({
        tableId: z.string().optional(),
        recordId: z.string().max(2000).optional(),
        fields: fieldMap.optional(),
        filter: filterAst.nullable().optional(),
        viewId: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        // notify
        userIds: z.array(z.string()).max(100).optional(),
        collaboratorFieldId: z.string().optional(),
        title: z.string().max(500).optional(),
        message: z.string().max(10_000).optional(),
        // email
        to: z.string().max(5000).optional(),
        cc: z.string().max(5000).optional(),
        subject: z.string().max(1000).optional(),
        body: z.string().max(100_000).optional(),
        // webhook
        url: z.string().max(2000).optional(),
        method: z.enum(["POST", "PUT", "PATCH", "GET"]).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().int().min(500).max(30_000).optional(),
        // condition
        match: z.enum(["all", "any"]).optional(),
        conditions: z
          .array(
            z.object({
              left: z.string().max(2000),
              op: z.enum([
                "eq",
                "neq",
                "contains",
                "notContains",
                "empty",
                "notEmpty",
                "gt",
                "gte",
                "lt",
                "lte",
              ]),
              right: z.string().max(2000).optional(),
            }),
          )
          .max(50)
          .optional(),
        then: z.array(actionSchema).max(25).optional(),
        else: z.array(actionSchema).max(25).optional(),
      })
      .passthrough(),
  }),
);

export interface ActionDef {
  id: string;
  type: ActionType;
  name?: string | undefined;
  config: {
    tableId?: string | undefined;
    recordId?: string | undefined;
    fields?: Record<string, unknown> | undefined;
    filter?: unknown;
    viewId?: string | undefined;
    limit?: number | undefined;
    userIds?: string[] | undefined;
    collaboratorFieldId?: string | undefined;
    title?: string | undefined;
    message?: string | undefined;
    to?: string | undefined;
    cc?: string | undefined;
    subject?: string | undefined;
    body?: string | undefined;
    url?: string | undefined;
    method?: "POST" | "PUT" | "PATCH" | "GET" | undefined;
    headers?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    match?: "all" | "any" | undefined;
    conditions?: { left: string; op: string; right?: string | undefined }[] | undefined;
    then?: ActionDef[] | undefined;
    else?: ActionDef[] | undefined;
    [k: string]: unknown;
  };
}

export const actionsSchema = z.array(actionSchema).max(25);

export interface StepResult {
  actionId: string;
  type: string;
  name?: string;
  status: "succeeded" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  output?: unknown;
  error?: string;
  /** For `condition` steps: which branch ran, and the nested step results. */
  branch?: "then" | "else" | "none";
  steps?: StepResult[];
}

export const MAX_CAUSATION_DEPTH = 8;
