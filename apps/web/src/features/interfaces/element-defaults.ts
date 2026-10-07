import type { FieldDto, TableDto } from "../../lib/api.ts";
import {
  newElementId,
  type CollectionConfig,
  type ElementField,
  type ElementType,
  type InterfaceElement,
  type PageKind,
  type PageLayout,
} from "../../lib/api-areas/interfaces.ts";
import { isEditableField } from "../views/view-utils.ts";

export const ELEMENT_PALETTE: Array<{ type: ElementType; label: string; icon: string; hint: string }> = [
  { type: "metric", label: "Number", icon: "#", hint: "A single count, sum or average" },
  { type: "chart", label: "Chart", icon: "▥", hint: "Bar, line, pie or donut" },
  { type: "table", label: "Grid", icon: "▦", hint: "Records in rows and columns" },
  { type: "record_list", label: "List", icon: "☰", hint: "A compact list of records" },
  { type: "gallery", label: "Gallery", icon: "▤", hint: "Records as cards" },
  { type: "record_detail", label: "Record details", icon: "▣", hint: "The record selected in another element" },
  { type: "form", label: "Form", icon: "✎", hint: "Create new records" },
  { type: "button", label: "Button", icon: "⬚", hint: "Open a link or another page" },
  { type: "text", label: "Text", icon: "T", hint: "Headings and notes" },
  { type: "divider", label: "Divider", icon: "—", hint: "A horizontal rule" },
];

export const ELEMENT_LABEL: Record<ElementType, string> = Object.fromEntries(
  ELEMENT_PALETTE.map((p) => [p.type, p.label]),
) as Record<ElementType, string>;

const GROUPABLE = new Set(["single_select", "multi_select", "checkbox", "user", "created_by", "last_modified_by", "date", "single_line_text", "rating"]);
const NUMERIC = new Set(["number", "currency", "percent", "rating", "duration", "count", "autonumber"]);

export function isNumericField(f: FieldDto): boolean {
  return NUMERIC.has(f.type) || (["formula", "rollup", "lookup"].includes(f.type) && (f.config as { resultType?: string })?.resultType === "number");
}

export function groupableFields(table: TableDto): FieldDto[] {
  return table.fields.filter((f) => GROUPABLE.has(f.type));
}

function primary(table: TableDto): FieldDto | undefined {
  return table.fields.find((f) => f.id === table.primaryFieldId) ?? table.fields[0];
}

/** Primary first, then up to `n - 1` other visible fields. */
export function starterFields(table: TableDto, n = 5, editable = false): ElementField[] {
  const p = primary(table);
  const rest = table.fields.filter((f) => f.id !== p?.id && f.type !== "record_id");
  return [p, ...rest]
    .filter((f): f is FieldDto => Boolean(f))
    .slice(0, n)
    .map((f) => ({ fieldId: f.id, editable: editable && isEditableField(f) }));
}

function collection(table: TableDto, fields = 5): CollectionConfig {
  return {
    dataSource: { tableId: table.id },
    fields: starterFields(table, fields),
    permissions: { allowCreate: false, allowDelete: false, allowOpenRecord: true },
    titleFieldId: table.primaryFieldId,
    searchable: true,
    selection: "single",
  };
}

const layout = (w: number) => ({ sectionId: "sec_main", lg: { x: 0, y: 0, w, h: "auto" as const } });

export function makeElement(type: ElementType, table: TableDto | undefined, existing: InterfaceElement[]): InterfaceElement | null {
  const id = newElementId();
  switch (type) {
    case "text":
      return { id, type, layout: layout(12), config: { body: "## Heading\nWrite something helpful for the people using this page." } };
    case "divider":
      return { id, type, layout: layout(12), config: {} };
    case "button":
      return {
        id,
        type,
        layout: layout(3),
        config: { label: "Open link", style: "primary", actions: [{ kind: "open_url", urlTemplate: "https://example.com", newTab: true }] },
      };
  }
  if (!table) return null;
  switch (type) {
    case "metric":
      return { id, type, title: `Total ${table.name}`, layout: layout(3), config: { source: { tableId: table.id }, measure: { agg: "count" } } };
    case "chart": {
      const x = groupableFields(table)[0] ?? primary(table);
      if (!x) return null;
      return {
        id,
        type,
        title: `${table.name} by ${x.name}`,
        layout: layout(6),
        config: { source: { tableId: table.id }, kind: "bar", x: { fieldId: x.id, sort: "label", limit: 20 }, measures: [{ agg: "count" }] },
      };
    }
    case "table":
      return { id, type, title: table.name, layout: layout(12), config: collection(table, 6) };
    case "record_list":
      return { id, type, title: table.name, layout: layout(4), config: collection(table, 3) };
    case "gallery":
      return { id, type, title: table.name, layout: layout(12), config: collection(table, 4) };
    case "record_detail": {
      const src = existing.find(
        (e) => (e.type === "table" || e.type === "record_list" || e.type === "gallery") && e.config.dataSource.tableId === table.id,
      ) ?? existing.find((e) => e.type === "table" || e.type === "record_list" || e.type === "gallery");
      if (!src || (src.type !== "table" && src.type !== "record_list" && src.type !== "gallery")) return null;
      const srcTable = src.config.dataSource.tableId;
      return {
        id,
        type,
        title: "Details",
        layout: layout(8),
        config: {
          dataSource: { tableId: srcTable, recordContext: { kind: "selected_in_element", elementId: src.id } },
          fields: srcTable === table.id ? starterFields(table, 8, true) : [],
        },
      };
    }
    case "form":
      return {
        id,
        type,
        title: `New ${table.name}`,
        layout: layout(6),
        config: {
          mode: "create",
          tableId: table.id,
          fields: table.fields.filter(isEditableField).slice(0, 8).map((f) => ({ fieldId: f.id, editable: true, required: f.id === table.primaryFieldId })),
          submit: { label: "Submit", message: "Thanks! Your response was recorded." },
        },
      };
  }
  return null;
}

export type TemplateId = "blank" | "dashboard" | "review" | "form";

export const TEMPLATES: Array<{ id: TemplateId; label: string; hint: string; kind: PageKind }> = [
  { id: "dashboard", label: "Dashboard", hint: "Numbers, a chart and a grid of records", kind: "dashboard" },
  { id: "review", label: "Record review", hint: "A list of records beside the selected record's details", kind: "record_list" },
  { id: "form", label: "Form", hint: "A page that creates new records", kind: "form" },
  { id: "blank", label: "Blank", hint: "Start from an empty page", kind: "blank" },
];

/** Pack elements left-to-right into 12-column rows, writing x/y so the stored layout matches what's on screen. */
export function packLayout(elements: InterfaceElement[]): InterfaceElement[] {
  let x = 0;
  let y = 0;
  return elements.map((el) => {
    const w = Math.min(12, Math.max(1, el.layout.lg.w));
    if (x + w > 12) {
      x = 0;
      y += 1;
    }
    const next = { ...el, layout: { ...el.layout, lg: { ...el.layout.lg, x, y, w } } } as InterfaceElement;
    x += w;
    if (x >= 12) {
      x = 0;
      y += 1;
    }
    return next;
  });
}

export function templateLayout(template: TemplateId, table: TableDto | undefined): PageLayout {
  const els: InterfaceElement[] = [];
  const add = (type: ElementType, patch?: (el: InterfaceElement) => InterfaceElement) => {
    const el = makeElement(type, table, els);
    if (el) els.push(patch ? patch(el) : el);
  };
  if (template === "dashboard" && table) {
    add("text", (el) => (el.type === "text" ? { ...el, config: { body: `# ${table.name} overview` } } : el));
    add("metric");
    const num = table.fields.find(isNumericField);
    if (num) {
      add("metric", (el) =>
        el.type === "metric" ? { ...el, title: `Sum of ${num.name}`, config: { ...el.config, measure: { agg: "sum", fieldId: num.id } } } : el,
      );
    }
    add("chart", (el) => ({ ...el, layout: { ...el.layout, lg: { ...el.layout.lg, w: num ? 6 : 9 } } }));
    add("table");
  } else if (template === "review" && table) {
    add("record_list");
    add("record_detail");
  } else if (template === "form" && table) {
    add("form", (el) => ({ ...el, layout: { ...el.layout, lg: { ...el.layout.lg, w: 8 } } }));
  }
  return { sections: [{ id: "sec_main" }], elements: packLayout(els) };
}
