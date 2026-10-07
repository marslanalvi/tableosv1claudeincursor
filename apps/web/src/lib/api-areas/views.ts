import {
  ApiProblemError,
  newClientOpId,
  rememberClientOp,
  request,
  type FilterAst,
  type RecordDto,
  type ViewDto,
} from "../api.ts";

/** CONTRACTS §5 */
export type RowHeight = "short" | "medium" | "tall" | "extra";
export type SortSpec = { fieldId: string; direction: "asc" | "desc" };
export type SummaryKind =
  | "none"
  | "count"
  | "empty"
  | "filled"
  | "unique"
  | "sum"
  | "avg"
  | "min"
  | "max";
export type ColorConfig =
  | { mode: "none" }
  | { mode: "select"; fieldId: string }
  | { mode: "conditions"; rules: { filter: FilterAst; color: string }[] };

export interface FormFieldConfig {
  fieldId: string;
  required: boolean;
  label?: string;
  help?: string;
}

export interface ViewConfig {
  filter: FilterAst | null;
  sorts: SortSpec[];
  groups: SortSpec[];
  hiddenFieldIds: string[];
  fieldOrder: string[];
  fieldWidths: Record<string, number>;
  frozenFieldCount: number;
  rowHeight: RowHeight;
  color: ColorConfig;
  summary: Record<string, SummaryKind>;
  kanban?: {
    stackFieldId: string | null;
    coverFieldId?: string | null;
    hideEmptyStacks?: boolean;
    collapsedStacks?: string[];
    cardFieldIds?: string[];
  };
  calendar?: { dateFieldId: string | null; endDateFieldId?: string | null; mode?: "month" | "week" };
  gallery?: { coverFieldId?: string | null; coverFit?: "cover" | "contain"; cardFieldIds?: string[] };
  timeline?: { startFieldId: string | null; endFieldId?: string | null; scale?: "day" | "week" | "month" };
  form?: {
    title: string;
    description: string;
    fields: FormFieldConfig[];
    submitLabel: string;
    successMessage: string;
    allowResubmit: boolean;
  };
}

export interface ViewWire extends ViewDto {
  tableId?: string;
  isDefault?: boolean;
  canEdit?: boolean;
  config?: ViewConfig & Record<string, unknown>;
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  filter: null,
  sorts: [],
  groups: [],
  hiddenFieldIds: [],
  fieldOrder: [],
  fieldWidths: {},
  frozenFieldCount: 1,
  rowHeight: "short",
  color: { mode: "none" },
  summary: {},
};

/** Fill defaults client-side (server already does; this guards old payloads). */
export function viewConfigOf(view: ViewDto | undefined | null): ViewConfig {
  const raw = (view?.config ?? {}) as Partial<ViewConfig>;
  return { ...DEFAULT_VIEW_CONFIG, ...raw };
}

const API_BASE = import.meta.env.VITE_API_URL ?? "";

/**
 * POST for read-only endpoints (records/query). Deliberately bypasses
 * `request()` so no Idempotency-Key / client-op id is attached: reads must not
 * be deduplicated or replayed by the idempotency layer.
 */
async function sendJson<T>(method: string, path: string, json: unknown, opId?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opId) {
    headers["X-Tabula-Client-Op-Id"] = opId;
    rememberClientOp(opId);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers,
    body: JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) {
    let problem;
    try {
      problem = JSON.parse(text);
    } catch {
      problem = { code: "VALIDATION_FAILED", title: res.statusText || "Request failed", status: res.status, detail: text };
    }
    throw new ApiProblemError(problem);
  }
  if (!text) throw new Error("Empty response from server");
  return JSON.parse(text) as T;
}

/** POST for read-only endpoints (records/query): no op id / Idempotency-Key. */
function postRead<T>(path: string, json: unknown): Promise<T> {
  return sendJson<T>("POST", path, json);
}

/**
 * Record writes from views. Sends the client op id (so realtime echoes are
 * skipped) but no Idempotency-Key: the idempotency layer currently returns an
 * empty body when that header is present (see CONTRACTS "Contract changes").
 */
function write<T>(method: string, path: string, json: unknown): Promise<T> {
  return sendJson<T>(method, path, json, newClientOpId());
}

const tablePath = (baseId: string, tableId: string) =>
  `/v1/bases/${baseId}/tables/${tableId}`;

export type ViewVisibility = "collaborative" | "personal" | "locked";

export const viewsApi = {
  list(baseId: string, tableId: string) {
    return request<{ views: ViewWire[] }>(`${tablePath(baseId, tableId)}/views`);
  },
  get(baseId: string, tableId: string, viewId: string) {
    return request<{ view: ViewWire }>(`${tablePath(baseId, tableId)}/views/${viewId}`);
  },
  create(
    baseId: string,
    tableId: string,
    body: { name: string; type: string; visibility?: ViewVisibility; config?: Partial<ViewConfig> },
  ) {
    return request<{ view: ViewWire }>(`${tablePath(baseId, tableId)}/views`, {
      method: "POST",
      json: body,
    });
  },
  patch(
    baseId: string,
    tableId: string,
    viewId: string,
    body: { name?: string; config?: Partial<ViewConfig>; visibility?: ViewVisibility },
  ) {
    return request<{ view: ViewWire }>(`${tablePath(baseId, tableId)}/views/${viewId}`, {
      method: "PATCH",
      json: body,
    });
  },
  remove(baseId: string, tableId: string, viewId: string) {
    return request<void>(`${tablePath(baseId, tableId)}/views/${viewId}`, {
      method: "DELETE",
    });
  },
  duplicate(baseId: string, tableId: string, viewId: string, name?: string) {
    return request<{ view: ViewWire }>(
      `${tablePath(baseId, tableId)}/views/${viewId}/duplicate`,
      { method: "POST", json: name ? { name } : {} },
    );
  },
  reorder(baseId: string, tableId: string, viewIds: string[]) {
    return request<void>(`${tablePath(baseId, tableId)}/views/reorder`, {
      method: "POST",
      json: { viewIds },
    });
  },
  favorite(baseId: string, tableId: string, viewId: string, on: boolean) {
    return request<{ ok: boolean; isFavorite: boolean }>(
      `${tablePath(baseId, tableId)}/views/${viewId}/favorite`,
      { method: on ? "POST" : "DELETE" },
    );
  },
};

/** Records helpers used by non-grid views (wire format CONTRACTS §3). */
export interface RecordQueryBody {
  filter?: FilterAst | null;
  sort?: { field: string; direction: "asc" | "desc" }[];
  search?: string;
  viewId?: string;
  pageSize?: number;
  cursor?: string | null;
  fields?: string[];
}

export type ViewRecord = RecordDto & {
  manualOrder?: string;
  rowNumber?: number;
  updatedAt?: string;
  fields: Record<string, unknown>;
};

export const viewRecordsApi = {
  async queryAll(baseId: string, tableId: string, body: RecordQueryBody, max = 2000) {
    const out: ViewRecord[] = [];
    let cursor: string | null | undefined = undefined;
    const clean: Record<string, unknown> = { ...body, pageSize: 500 };
    if (!body.filter) delete clean.filter;
    if (!body.search) delete clean.search;
    if (!body.sort || body.sort.length === 0) delete clean.sort;
    do {
      const page: { records: ViewRecord[]; nextCursor: string | null } = await postRead(
        `${tablePath(baseId, tableId)}/records/query`,
        cursor ? { ...clean, cursor } : clean,
      );
      out.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor && out.length < max);
    return out;
  },
  async create(baseId: string, tableId: string, fields: Record<string, unknown>, typecast = true) {
    const res = await write<{ record: ViewRecord }>("POST", `${tablePath(baseId, tableId)}/records`, {
      fields,
      typecast,
    });
    return res.record;
  },
  async patch(
    baseId: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
    typecast = true,
  ) {
    const res = await write<{ record: ViewRecord }>(
      "PATCH",
      `${tablePath(baseId, tableId)}/records/${recordId}`,
      { fields, typecast },
    );
    return res.record;
  },
  async move(
    baseId: string,
    tableId: string,
    recordId: string,
    pos: { before?: string | null; after?: string | null },
  ) {
    return write<{ record: ViewRecord }>("POST", `${tablePath(baseId, tableId)}/records/${recordId}/move`, pos);
  },
};

/** Share a form view (E's share endpoint). */
export interface ShareWire {
  id: string;
  token: string;
  targetType?: string;
  targetId?: string;
  url?: string;
  publicUrl?: string;
}

export async function createFormShare(baseId: string, viewId: string): Promise<ShareWire> {
  // Reuse an active form share for this view when one exists.
  try {
    const existing = await request<{ shares: ShareWire[] }>(
      `/v1/bases/${baseId}/shares?targetId=${encodeURIComponent(viewId)}&targetType=form`,
    );
    const found = existing.shares?.find((s) => s.token || s.url);
    if (found) return found;
  } catch {
    /* fall through to create */
  }
  const res = await request<{ share: ShareWire } | ShareWire>(`/v1/bases/${baseId}/shares`, {
    method: "POST",
    json: { targetType: "form", targetId: viewId },
  });
  return "share" in res && res.share ? res.share : (res as ShareWire);
}

export function publicFormUrl(share: ShareWire): string {
  if (share.publicUrl) return share.publicUrl;
  if (share.url) return share.url;
  const host = window.location.hostname || "localhost";
  return `${window.location.protocol}//${host}:5284/f/${share.token}`;
}
