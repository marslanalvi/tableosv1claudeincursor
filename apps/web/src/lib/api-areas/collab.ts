import { request } from "../api.ts";

// ── Comments ────────────────────────────────────────────────────────────────

export interface CommentAuthor {
  id: string;
  name: string;
  email: string;
  initials: string;
}

export interface CommentReaction {
  emoji: string;
  count: number;
  userIds: string[];
  userNames: string[];
  reactedByMe: boolean;
}

export interface CommentWire {
  id: string;
  parentId: string | null;
  body: string;
  createdBy: string | null;
  author: CommentAuthor | null;
  authorName: string;
  createdAt: string;
  updatedAt: string | null;
  edited: boolean;
  isMine: boolean;
  reactions: CommentReaction[];
  mentions: { id: string; name: string; email: string }[];
}

export const commentsApi = {
  list(baseId: string, tableId: string, recordId: string) {
    return request<{ comments: CommentWire[] }>(
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}/comments`,
    );
  },
  create(baseId: string, tableId: string, recordId: string, body: string, parentId?: string | null) {
    return request<{ comment: CommentWire }>(
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}/comments`,
      { method: "POST", json: { body, ...(parentId ? { parentId } : {}) } },
    );
  },
  update(baseId: string, commentId: string, body: string) {
    return request<{ comment: CommentWire }>(`/v1/bases/${baseId}/comments/${commentId}`, {
      method: "PATCH",
      json: { body },
    });
  },
  remove(baseId: string, commentId: string) {
    return request<void>(`/v1/bases/${baseId}/comments/${commentId}`, { method: "DELETE" });
  },
  toggleReaction(baseId: string, commentId: string, emoji: string) {
    return request<{ ok: boolean; active: boolean }>(
      `/v1/bases/${baseId}/comments/${commentId}/reactions`,
      { method: "POST", json: { emoji, toggle: true } },
    );
  },
};

export interface Collaborator {
  id: string;
  name: string;
  email: string;
  role?: string;
}

export function listCollaborators(baseId: string) {
  return request<{ collaborators: Collaborator[] }>(`/v1/bases/${baseId}/collaborators`);
}

// ── Notifications ───────────────────────────────────────────────────────────

export interface NotificationWire {
  id: string;
  category: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  baseId: string | null;
  actor: { id: string; name: string; email: string } | null;
}

export const notificationsApi = {
  list() {
    return request<{ notifications: NotificationWire[]; unreadCount: number }>("/v1/notifications");
  },
  markRead(id: string) {
    return request<{ ok: true }>(`/v1/notifications/${id}/read`, { method: "POST" });
  },
  markUnread(id: string) {
    return request<{ ok: true }>(`/v1/notifications/${id}/unread`, { method: "POST" });
  },
  markAllRead() {
    return request<{ ok: true }>("/v1/notifications/read-all", { method: "POST" });
  },
};

// ── Contacts ────────────────────────────────────────────────────────────────

export interface ContactWire {
  id: string;
  workspaceId: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ContactInput = Partial<Pick<ContactWire, "name" | "email" | "phone" | "company" | "title" | "notes">>;

export const contactsApi = {
  list(workspaceId: string, q?: string) {
    const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
    return request<{ contacts: ContactWire[]; contactDirectoryBaseId: string }>(
      `/v1/workspaces/${workspaceId}/contacts${qs}`,
    );
  },
  create(workspaceId: string, body: ContactInput) {
    return request<{ contact: ContactWire }>(`/v1/workspaces/${workspaceId}/contacts`, {
      method: "POST",
      json: body,
    });
  },
  update(workspaceId: string, id: string, body: ContactInput) {
    return request<{ contact: ContactWire }>(`/v1/workspaces/${workspaceId}/contacts/${id}`, {
      method: "PATCH",
      json: body,
    });
  },
  remove(workspaceId: string, id: string) {
    return request<void>(`/v1/workspaces/${workspaceId}/contacts/${id}`, { method: "DELETE" });
  },
  merge(workspaceId: string, survivorContactId: string, mergedContactId: string) {
    return request<{ ok: true; contact: ContactWire; relinked: number }>(
      `/v1/workspaces/${workspaceId}/contacts/merge`,
      { method: "POST", json: { survivorContactId, mergedContactId } },
    );
  },
};

// ── Import / export ─────────────────────────────────────────────────────────

export interface ImportChunkResult {
  importJobId: string;
  rowsImported: number;
  rowsFailed: number;
  errors: { row: number; message: string }[];
  totalImported: number;
  totalFailed: number;
  status: "running" | "succeeded" | "failed";
}

export function importRows(
  baseId: string,
  body: {
    tableId: string;
    rows: Record<string, unknown>[];
    filename?: string;
    importJobId?: string;
    rowOffset?: number;
    totalRows?: number;
    final?: boolean;
    typecast?: boolean;
  },
) {
  return request<ImportChunkResult>(`/v1/bases/${baseId}/import`, { method: "POST", json: body });
}

export function exportUrl(baseId: string, tableId: string, format: "csv" | "xlsx", viewId?: string): string {
  const api = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
  const params = new URLSearchParams({ format });
  if (viewId) params.set("viewId", viewId);
  return `${api}/v1/bases/${baseId}/tables/${tableId}/export?${params.toString()}`;
}

// ── Relative time ───────────────────────────────────────────────────────────

export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(new Date(t).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}
