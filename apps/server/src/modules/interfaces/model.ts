import { z } from "zod";
import { filterSchema, type FilterAstJson } from "../views/config.js";

/**
 * Interface page model (architecture 13 §3–§5), MVP subset.
 * Field / table / view ids are public ids (`fld_`, `tbl_`, `viw_`).
 * Element ids are opaque `elm_…` strings minted by the builder.
 */

export const ELEMENT_TYPES = [
  "text",
  "divider",
  "metric",
  "chart",
  "table",
  "record_list",
  "gallery",
  "record_detail",
  "form",
  "button",
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const PAGE_KINDS = ["dashboard", "record_list", "record_detail", "form", "overview", "blank"] as const;

export const AGG_FNS = ["count", "sum", "avg", "min", "max", "count_unique"] as const;
export type AggFn = (typeof AGG_FNS)[number];

const id = z.string().min(1).max(64);

const dataSource = z.object({
  tableId: id,
  baseViewId: id.nullish(),
  filter: filterSchema.nullish(),
  sorts: z.array(z.object({ fieldId: id, direction: z.enum(["asc", "desc"]) })).max(5).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});
export type DataSource = z.infer<typeof dataSource>;

const elementField = z.object({
  fieldId: id,
  label: z.string().max(255).optional(),
  editable: z.boolean().default(false),
  required: z.boolean().optional(),
});

const permissions = z
  .object({
    allowCreate: z.boolean().default(false),
    allowDelete: z.boolean().default(false),
    allowOpenRecord: z.boolean().default(true),
  })
  .default({});

const collectionConfig = z.object({
  dataSource,
  fields: z.array(elementField).max(50).default([]),
  permissions,
  titleFieldId: id.nullish(),
  searchable: z.boolean().default(true),
  selection: z.enum(["none", "single"]).default("single"),
  emptyText: z.string().max(500).optional(),
});

const measure = z.object({ agg: z.enum(AGG_FNS), fieldId: id.nullish(), label: z.string().max(100).optional() });

const metricConfig = z.object({
  source: dataSource,
  measure,
  format: z
    .object({
      style: z.enum(["number", "currency", "percent"]).default("number"),
      precision: z.number().int().min(0).max(6).optional(),
      currencyCode: z.string().max(3).optional(),
    })
    .optional(),
});

const chartConfig = z.object({
  source: dataSource,
  kind: z.enum(["bar", "line", "pie", "donut"]),
  x: z.object({
    fieldId: id,
    sort: z.enum(["label", "value_desc", "value_asc"]).default("label"),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  measures: z.array(measure).min(1).max(4),
  options: z.object({ showValues: z.boolean().optional(), showLegend: z.boolean().optional() }).optional(),
});

const recordDetailConfig = z.object({
  dataSource: z.object({
    tableId: id,
    recordContext: z.object({ kind: z.literal("selected_in_element"), elementId: id }),
  }),
  fields: z.array(elementField).max(50).default([]),
});

const formConfig = z.object({
  mode: z.literal("create").default("create"),
  tableId: id,
  fields: z.array(elementField).max(50).default([]),
  submit: z
    .object({
      label: z.string().max(100).default("Submit"),
      message: z.string().max(1000).default("Thanks! Your response was recorded."),
    })
    .default({}),
});

const buttonAction = z.union([
  z.object({
    kind: z.literal("open_url"),
    urlTemplate: z
      .string()
      .max(2000)
      .refine((u) => /^(https:|mailto:|tel:)/i.test(u), "Only https:, mailto: and tel: links are allowed"),
    newTab: z.boolean().default(true),
  }),
  z.object({ kind: z.literal("navigate"), pageId: id }),
]);

const buttonConfig = z.object({
  label: z.string().min(1).max(100),
  style: z.enum(["primary", "secondary", "danger", "link"]).default("primary"),
  actions: z.array(buttonAction).min(1).max(5),
});

const textConfig = z.object({ body: z.string().max(20_000).default("") });

const layout = z.object({
  sectionId: z.string().max(64).default("sec_main"),
  lg: z.object({
    x: z.number().int().min(0).max(11).default(0),
    y: z.number().int().min(0).max(10_000).default(0),
    w: z.number().int().min(1).max(12).default(12),
    h: z.union([z.literal("auto"), z.number().int().min(1).max(60)]).default("auto"),
  }),
});

const base = {
  id: z.string().regex(/^elm_[A-Za-z0-9]{6,40}$/),
  title: z.string().max(255).optional(),
  description: z.string().max(1000).optional(),
  layout,
  style: z.object({ variant: z.enum(["plain", "card", "outlined"]).optional() }).optional(),
};

export const elementSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), config: textConfig }),
  z.object({ ...base, type: z.literal("divider"), config: z.object({}).default({}) }),
  z.object({ ...base, type: z.literal("metric"), config: metricConfig }),
  z.object({ ...base, type: z.literal("chart"), config: chartConfig }),
  z.object({ ...base, type: z.literal("table"), config: collectionConfig }),
  z.object({ ...base, type: z.literal("record_list"), config: collectionConfig }),
  z.object({ ...base, type: z.literal("gallery"), config: collectionConfig }),
  z.object({ ...base, type: z.literal("record_detail"), config: recordDetailConfig }),
  z.object({ ...base, type: z.literal("form"), config: formConfig }),
  z.object({ ...base, type: z.literal("button"), config: buttonConfig }),
]);
export type InterfaceElement = z.infer<typeof elementSchema>;

export const pageLayoutSchema = z.object({
  sections: z
    .array(z.object({ id: z.string().max(64), title: z.string().max(255).optional() }))
    .max(50)
    .default([{ id: "sec_main" }]),
  elements: z.array(elementSchema).max(200).default([]),
});
export type PageLayout = z.infer<typeof pageLayoutSchema>;

export const EMPTY_LAYOUT: PageLayout = { sections: [{ id: "sec_main" }], elements: [] };

/** Parse stored JSON leniently (bad elements are dropped, never thrown). */
export function readLayout(raw: unknown): PageLayout {
  const parsed = pageLayoutSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const obj = (raw && typeof raw === "object" ? raw : {}) as { sections?: unknown; elements?: unknown };
  const elements = Array.isArray(obj.elements)
    ? obj.elements.flatMap((e) => {
        const r = elementSchema.safeParse(e);
        return r.success ? [r.data] : [];
      })
    : [];
  return { sections: [{ id: "sec_main" }], elements };
}

export function sourceOf(el: InterfaceElement): {
  tableId: string;
  baseViewId?: string | null | undefined;
  filter?: FilterAstJson | null | undefined;
  sorts?: DataSource["sorts"] | undefined;
} | null {
  switch (el.type) {
    case "table":
    case "record_list":
    case "gallery":
      return el.config.dataSource;
    case "metric":
    case "chart":
      return el.config.source;
    case "record_detail":
      return { tableId: el.config.dataSource.tableId };
    case "form":
      return { tableId: el.config.tableId };
    default:
      return null;
  }
}

/** Field ids an element reads (its allowlist). */
export function fieldIdsOf(el: InterfaceElement): string[] {
  switch (el.type) {
    case "table":
    case "record_list":
    case "gallery":
      return [
        ...el.config.fields.map((f) => f.fieldId),
        ...(el.config.titleFieldId ? [el.config.titleFieldId] : []),
      ];
    case "record_detail":
    case "form":
      return el.config.fields.map((f) => f.fieldId);
    case "metric":
      return el.config.measure.fieldId ? [el.config.measure.fieldId] : [];
    case "chart":
      return [el.config.x.fieldId, ...el.config.measures.flatMap((m) => (m.fieldId ? [m.fieldId] : []))];
    default:
      return [];
  }
}

export interface SchemaIndex {
  tables: Map<string, { name: string; fields: Map<string, { name: string; type: string }>; views: Set<string> }>;
}

export interface Diagnostic {
  elementId?: string;
  pageId?: string;
  severity: "error" | "warning";
  message: string;
}

/** Publish-time validation (architecture 13 §13.2 step 3), reference checks only. */
export function validatePages(
  pages: Array<{ id: string; name: string; layout: PageLayout }>,
  schema: SchemaIndex,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const pageIds = new Set(pages.map((p) => p.id));
  for (const page of pages) {
    const ids = new Set<string>();
    const byId = new Map(page.layout.elements.map((e) => [e.id, e]));
    for (const el of page.layout.elements) {
      const at = { pageId: page.id, elementId: el.id };
      const label = el.title || el.type;
      if (ids.has(el.id)) out.push({ ...at, severity: "error", message: `Duplicate element id ${el.id}` });
      ids.add(el.id);
      const src = sourceOf(el);
      if (src) {
        const t = schema.tables.get(src.tableId);
        if (!t) {
          out.push({ ...at, severity: "error", message: `“${label}” uses a table that no longer exists` });
          continue;
        }
        if (src.baseViewId && !t.views.has(src.baseViewId)) {
          out.push({ ...at, severity: "error", message: `“${label}” uses a view that no longer exists` });
        }
        for (const f of fieldIdsOf(el)) {
          if (!t.fields.has(f)) out.push({ ...at, severity: "error", message: `“${label}” uses a deleted field (${f})` });
        }
        if (el.type === "metric" || el.type === "chart") {
          const ms = el.type === "metric" ? [el.config.measure] : el.config.measures;
          for (const m of ms) {
            if (m.agg !== "count" && !m.fieldId) {
              out.push({ ...at, severity: "error", message: `“${label}”: ${m.agg} needs a field` });
            }
          }
        }
        if ((el.type === "table" || el.type === "record_list" || el.type === "gallery" || el.type === "form") && el.config.fields.length === 0) {
          out.push({ ...at, severity: "warning", message: `“${label}” shows no fields` });
        }
      }
      if (el.type === "record_detail") {
        const srcEl = byId.get(el.config.dataSource.recordContext.elementId);
        if (!srcEl || !["table", "record_list", "gallery"].includes(srcEl.type)) {
          out.push({ ...at, severity: "error", message: `“${label}” must follow a list, table or gallery on this page` });
        } else if (sourceOf(srcEl)?.tableId !== el.config.dataSource.tableId) {
          out.push({ ...at, severity: "error", message: `“${label}” and its list must use the same table` });
        }
      }
      if (el.type === "button") {
        for (const a of el.config.actions) {
          if (a.kind === "navigate" && !pageIds.has(a.pageId)) {
            out.push({ ...at, severity: "error", message: `“${label}” links to a deleted page` });
          }
        }
      }
    }
  }
  return out;
}
