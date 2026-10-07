import { request } from "../api.ts";

export interface SearchResult {
  kind: "base" | "table" | "record";
  id: string;
  title: string;
  subtitle: string;
  baseId: string;
  tableId: string | null;
  recordId: string | null;
  /** In-app path, e.g. `/bases/bas_…?tableId=tbl_…&recordId=rec_…`. */
  href: string;
}

export function searchAll(q: string, opts: { workspaceId?: string; baseId?: string; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ q });
  if (opts.workspaceId) params.set("workspaceId", opts.workspaceId);
  if (opts.baseId) params.set("baseId", opts.baseId);
  return request<{ results: SearchResult[] }>(`/v1/search?${params.toString()}`, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}
