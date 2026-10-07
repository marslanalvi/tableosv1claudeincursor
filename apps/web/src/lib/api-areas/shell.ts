import { request } from "../api.ts";

/** Workstream F: auth, workspaces, bases, tables, undo/redo, trash. */

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

export interface Collaborator {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface UndoResult {
  changeSeq: number;
  description: string;
  tableIds: string[];
}

export interface TrashRecord {
  id: string;
  tableId: string;
  tableName: string;
  name: string;
  deletedAt: string;
  deletedByName: string | null;
  deletionBatchId: string | null;
}

export interface TrashTable {
  id: string;
  name: string;
  deletedAt: string;
  deletedByName: string | null;
}

export interface TrashField {
  id: string;
  name: string;
  type: string;
  tableId: string;
  tableName: string;
  deletedAt: string;
  deletedByName: string | null;
}

/** `GET /v1/bases/:b` also carries the caller's hidden tables. */
export function hiddenTableIdsOf(base: unknown): string[] {
  const ids = (base as { hiddenTableIds?: unknown } | null | undefined)?.hiddenTableIds;
  return Array.isArray(ids) ? (ids as string[]) : [];
}

export interface TrashListing {
  records: TrashRecord[];
  tables: TrashTable[];
  fields: TrashField[];
}

export const shellApi = {
  logout() {
    return request<void>("/v1/auth/logout", { method: "POST", json: {} });
  },

  // Workspaces
  createWorkspace(name: string) {
    return request<{ workspace: { id: string; name: string } }>("/v1/workspaces", {
      method: "POST",
      json: { name },
    });
  },
  renameWorkspace(workspaceId: string, name: string) {
    return request<{ workspace: { id: string; name: string } }>(
      `/v1/workspaces/${workspaceId}`,
      { method: "PATCH", json: { name } },
    );
  },
  deleteWorkspace(workspaceId: string) {
    return request<void>(`/v1/workspaces/${workspaceId}`, { method: "DELETE" });
  },
  workspaceMembers(workspaceId: string) {
    return request<{ members: WorkspaceMember[]; invitations: PendingInvitation[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
  },
  invite(workspaceId: string, email: string, role: string) {
    return request<{ invitation: { id: string; email: string; role: string; acceptToken?: string } }>(
      "/v1/invitations",
      { method: "POST", json: { workspaceId, email, role } },
    );
  },

  // Bases
  renameBase(baseId: string, name: string) {
    return request<{ base: { id: string; name: string } }>(`/v1/bases/${baseId}`, {
      method: "PATCH",
      json: { name },
    });
  },
  deleteBase(baseId: string) {
    return request<void>(`/v1/bases/${baseId}`, { method: "DELETE" });
  },
  duplicateBase(baseId: string, body: { name?: string; withRecords?: boolean } = {}) {
    return request<{ id: string; name: string }>(`/v1/bases/${baseId}/duplicate`, {
      method: "POST",
      json: body,
    });
  },
  collaborators(baseId: string) {
    return request<{ collaborators: Collaborator[] }>(`/v1/bases/${baseId}/collaborators`);
  },

  // Tables (server owned by B)
  renameTable(baseId: string, tableId: string, name: string) {
    return request<unknown>(`/v1/bases/${baseId}/tables/${tableId}`, {
      method: "PATCH",
      json: { name },
    });
  },
  deleteTable(baseId: string, tableId: string) {
    return request<void>(`/v1/bases/${baseId}/tables/${tableId}`, { method: "DELETE" });
  },
  duplicateTable(baseId: string, tableId: string, withRecords: boolean) {
    return request<{ table: { id: string; name: string } }>(
      `/v1/bases/${baseId}/tables/${tableId}/duplicate`,
      { method: "POST", json: { withRecords } },
    );
  },
  reorderTables(baseId: string, tableIds: string[]) {
    return request<void>(`/v1/bases/${baseId}/tables/reorder`, {
      method: "POST",
      json: { tableIds },
    });
  },
  /** Per-user "Hide table"; 409 when it would hide the last visible table. */
  setTableHidden(baseId: string, tableId: string, hidden: boolean) {
    return request<{ tableId: string; hidden: boolean; hiddenTableIds: string[] }>(
      `/v1/bases/${baseId}/tables/${tableId}/hidden`,
      { method: "PUT", json: { hidden } },
    );
  },

  // History
  undoState(baseId: string) {
    return request<UndoState>(`/v1/bases/${baseId}/undo-state`);
  },
  undo(baseId: string) {
    return request<UndoResult>(`/v1/bases/${baseId}/undo`, { method: "POST", json: {} });
  },
  redo(baseId: string) {
    return request<UndoResult>(`/v1/bases/${baseId}/redo`, { method: "POST", json: {} });
  },
  trash(baseId: string) {
    return request<TrashListing>(`/v1/bases/${baseId}/trash`);
  },
  restore(
    baseId: string,
    body: { recordId?: string; tableId?: string; fieldId?: string; deletionBatchId?: string },
  ) {
    return request<{ changeSeq: number; restored: number }>(
      `/v1/bases/${baseId}/trash/restore`,
      { method: "POST", json: body },
    );
  },
};
