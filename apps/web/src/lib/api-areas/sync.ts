import { request, type TableSyncInfo } from "../api.ts";

/** Cross-base data: synced tables (read-only mirrors of tables in other bases). */

export interface SyncSourceBase {
  id: string;
  name: string;
  workspaceName: string;
  tables: { id: string; name: string; recordCount: number }[];
}

const b = (id: string) => `/v1/bases/${encodeURIComponent(id)}`;

export const syncApi = {
  sources(baseId: string) {
    return request<{ bases: SyncSourceBase[] }>(`${b(baseId)}/sync-sources`);
  },
  create(baseId: string, body: { sourceTableId: string; name?: string; intervalMinutes?: number }) {
    return request<{ tableId: string; existing?: boolean; error?: string | null }>(`${b(baseId)}/synced-tables`, { method: "POST", json: body });
  },
  runNow(baseId: string, tableId: string) {
    return request<{ sync: TableSyncInfo }>(`${b(baseId)}/tables/${encodeURIComponent(tableId)}/sync/run`, { method: "POST", json: {} });
  },
  update(baseId: string, tableId: string, body: { status?: "active" | "paused"; intervalMinutes?: number }) {
    return request<{ sync: TableSyncInfo }>(`${b(baseId)}/tables/${encodeURIComponent(tableId)}/sync`, { method: "PATCH", json: body });
  },
  stop(baseId: string, tableId: string) {
    return request<void>(`${b(baseId)}/tables/${encodeURIComponent(tableId)}/sync`, { method: "DELETE" });
  },
};
