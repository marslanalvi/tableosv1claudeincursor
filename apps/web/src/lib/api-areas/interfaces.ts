import { request, type FilterAst } from "../api.ts";

/** Interface builder (architecture 13). Mirrors apps/server/src/modules/interfaces/model.ts. */

export type ElementType =
  | "text"
  | "divider"
  | "metric"
  | "chart"
  | "table"
  | "record_list"
  | "gallery"
  | "record_detail"
  | "form"
  | "button";

export type AggFn = "count" | "sum" | "avg" | "min" | "max" | "count_unique";
export type PageKind = "dashboard" | "record_list" | "record_detail" | "form" | "overview" | "blank";

export interface DataSource {
  tableId: string;
  baseViewId?: string | null;
  filter?: FilterAst | null;
  sorts?: Array<{ fieldId: string; direction: "asc" | "desc" }>;
  limit?: number;
}

export interface ElementField {
  fieldId: string;
  label?: string;
  editable: boolean;
  required?: boolean;
}

export interface CollectionConfig {
  dataSource: DataSource;
  fields: ElementField[];
  permissions: { allowCreate: boolean; allowDelete: boolean; allowOpenRecord: boolean };
  titleFieldId?: string | null;
  searchable: boolean;
  selection: "none" | "single";
  emptyText?: string;
}

export interface Measure {
  agg: AggFn;
  fieldId?: string | null;
  label?: string;
}

export interface MetricConfig {
  source: DataSource;
  measure: Measure;
  format?: { style: "number" | "currency" | "percent"; precision?: number; currencyCode?: string };
}

export interface ChartConfig {
  source: DataSource;
  kind: "bar" | "line" | "pie" | "donut";
  x: { fieldId: string; sort: "label" | "value_desc" | "value_asc"; limit: number };
  measures: Measure[];
  options?: { showValues?: boolean; showLegend?: boolean };
}

export interface RecordDetailConfig {
  dataSource: { tableId: string; recordContext: { kind: "selected_in_element"; elementId: string } };
  fields: ElementField[];
}

export interface FormElementConfig {
  mode: "create";
  tableId: string;
  fields: ElementField[];
  submit: { label: string; message: string };
}

export type ButtonAction =
  | { kind: "open_url"; urlTemplate: string; newTab: boolean }
  | { kind: "navigate"; pageId: string };

export interface ButtonConfig {
  label: string;
  style: "primary" | "secondary" | "danger" | "link";
  actions: ButtonAction[];
}

interface ElementBase<T extends ElementType, C> {
  id: string;
  type: T;
  title?: string;
  description?: string;
  layout: { sectionId: string; lg: { x: number; y: number; w: number; h: number | "auto" } };
  style?: { variant?: "plain" | "card" | "outlined" };
  config: C;
}

export type InterfaceElement =
  | ElementBase<"text", { body: string }>
  | ElementBase<"divider", Record<string, never>>
  | ElementBase<"metric", MetricConfig>
  | ElementBase<"chart", ChartConfig>
  | ElementBase<"table", CollectionConfig>
  | ElementBase<"record_list", CollectionConfig>
  | ElementBase<"gallery", CollectionConfig>
  | ElementBase<"record_detail", RecordDetailConfig>
  | ElementBase<"form", FormElementConfig>
  | ElementBase<"button", ButtonConfig>;

export interface PageLayout {
  sections: Array<{ id: string; title?: string }>;
  elements: InterfaceElement[];
}

export interface InterfaceDto {
  id: string;
  name: string;
  description: string;
  icon: string;
  status: "draft_only" | "published" | "unpublished";
  draftRevision: number;
  publishedRevision: number | null;
  publishedAt: string | null;
  publishedVersionNo: number | null;
  hasUnpublishedChanges: boolean;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InterfacePage {
  id: string;
  name: string;
  kind: PageKind;
  layout: PageLayout;
  pageRevision?: number;
}

export interface InterfaceVersion {
  versionNo: number;
  publishedAt: string;
  publishedBy: string | null;
  releaseNote: string;
  current: boolean;
}

export interface Diagnostic {
  elementId?: string;
  pageId?: string;
  severity: "error" | "warning";
  message: string;
}

export interface ElementRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface ChartPoint {
  key: string;
  label: unknown;
  values: Array<number | string | null>;
  count: number;
}

const root = (b: string) => `/v1/bases/${b}/interfaces`;

export const interfacesApi = {
  list(baseId: string) {
    return request<{ canBuild: boolean; interfaces: InterfaceDto[] }>(root(baseId));
  },
  create(baseId: string, body: { name: string; icon?: string; pages?: Array<{ name: string; kind: PageKind; layout?: PageLayout }> }) {
    return request<{ interface: InterfaceDto; pages: InterfacePage[] }>(root(baseId), { method: "POST", json: body });
  },
  get(baseId: string, itf: string) {
    return request<{ canBuild: boolean; interface: InterfaceDto; pages: InterfacePage[] }>(`${root(baseId)}/${itf}`);
  },
  patch(baseId: string, itf: string, body: { name?: string; icon?: string; description?: string }) {
    return request<{ interface: InterfaceDto }>(`${root(baseId)}/${itf}`, { method: "PATCH", json: body });
  },
  remove(baseId: string, itf: string) {
    return request<void>(`${root(baseId)}/${itf}`, { method: "DELETE" });
  },
  createPage(baseId: string, itf: string, body: { name: string; kind?: PageKind; layout?: PageLayout }) {
    return request<{ page: InterfacePage }>(`${root(baseId)}/${itf}/pages`, { method: "POST", json: body });
  },
  patchPage(baseId: string, itf: string, pag: string, body: { name?: string; layout?: PageLayout; expectedRevision?: number }) {
    return request<{ page: InterfacePage }>(`${root(baseId)}/${itf}/pages/${pag}`, { method: "PATCH", json: body });
  },
  removePage(baseId: string, itf: string, pag: string) {
    return request<void>(`${root(baseId)}/${itf}/pages/${pag}`, { method: "DELETE" });
  },
  reorderPages(baseId: string, itf: string, pageIds: string[]) {
    return request<void>(`${root(baseId)}/${itf}/pages/reorder`, { method: "POST", json: { pageIds } });
  },
  publish(baseId: string, itf: string, releaseNote?: string) {
    return request<{ interface: InterfaceDto; versionNo: number; diagnostics: Diagnostic[] }>(`${root(baseId)}/${itf}/publish`, {
      method: "POST",
      json: releaseNote ? { releaseNote } : {},
    });
  },
  unpublish(baseId: string, itf: string) {
    return request<{ interface: InterfaceDto }>(`${root(baseId)}/${itf}/unpublish`, { method: "POST", json: {} });
  },
  versions(baseId: string, itf: string) {
    return request<{ versions: InterfaceVersion[] }>(`${root(baseId)}/${itf}/versions`);
  },
  revert(baseId: string, itf: string, versionNo: number) {
    return request<{ pages: InterfacePage[] }>(`${root(baseId)}/${itf}/versions/${versionNo}/revert`, { method: "POST", json: {} });
  },
  runtime(baseId: string, itf: string) {
    return request<{ interface: InterfaceDto; versionNo: number; pages: InterfacePage[] }>(`${root(baseId)}/${itf}/runtime`);
  },
  queryElement(
    baseId: string,
    itf: string,
    pag: string,
    elm: string,
    body: { draft?: boolean; search?: string; pageSize?: number; cursor?: string | null; context?: { selections?: Record<string, string> } },
  ) {
    return request<{ records: ElementRecord[]; nextCursor: string | null; totalCount?: number }>(
      `${root(baseId)}/${itf}/pages/${pag}/elements/${elm}/query`,
      { method: "POST", json: body },
    );
  },
  aggregateElement(baseId: string, itf: string, pag: string, elm: string, body: { draft?: boolean }) {
    return request<{ value?: number | string | null; count?: number; points?: ChartPoint[]; truncated?: boolean }>(
      `${root(baseId)}/${itf}/pages/${pag}/elements/${elm}/aggregate`,
      { method: "POST", json: body },
    );
  },
};

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newElementId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ID_CHARS[b % 62];
  return `elm_${s}`;
}
