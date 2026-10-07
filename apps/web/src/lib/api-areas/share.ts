import { request } from "../api.ts";

export type ShareTargetType = "view" | "form" | "base";

export interface ShareDto {
  id: string;
  token: string | null;
  url: string | null;
  targetType: ShareTargetType;
  targetId: string;
  viewId: string | null;
  tableId: string | null;
  baseId: string;
  accessMode: "public" | "password";
  hasPassword: boolean;
  expiresAt: string | null;
  allowCopy: boolean;
  status: "active" | "revoked" | "expired";
  createdBy: string | null;
  createdAt: string;
}

export interface CreateShareBody {
  targetType: ShareTargetType;
  targetId?: string;
  password?: string;
  expiresAt?: string | null;
  allowCopy?: boolean;
}

export const shareApi = {
  list(baseId: string, filter: { targetId?: string; targetType?: ShareTargetType } = {}) {
    const params = new URLSearchParams();
    if (filter.targetId) params.set("targetId", filter.targetId);
    if (filter.targetType) params.set("targetType", filter.targetType);
    const qs = params.toString();
    return request<{ shares: ShareDto[] }>(`/v1/bases/${baseId}/shares${qs ? `?${qs}` : ""}`);
  },
  create(baseId: string, body: CreateShareBody) {
    return request<{ share: ShareDto }>(`/v1/bases/${baseId}/shares`, { method: "POST", json: body });
  },
  update(
    baseId: string,
    shareId: string,
    body: { password?: string | null; expiresAt?: string | null; allowCopy?: boolean },
  ) {
    return request<{ share: ShareDto }>(`/v1/bases/${baseId}/shares/${shareId}`, {
      method: "PATCH",
      json: body,
    });
  },
  revoke(baseId: string, shareId: string) {
    return request<void>(`/v1/bases/${baseId}/shares/${shareId}`, { method: "DELETE" });
  },
  regenerate(baseId: string, shareId: string) {
    return request<{ share: ShareDto }>(`/v1/bases/${baseId}/shares/${shareId}/regenerate`, {
      method: "POST",
    });
  },
};

const PUBLIC_ORIGIN =
  (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined) ?? "http://localhost:5174";

/** Public URL of a share (server provides `url`; fall back to building it). */
export function shareLink(share: Pick<ShareDto, "url" | "token" | "targetType">): string {
  if (share.url) return share.url;
  if (!share.token) return "";
  return `${PUBLIC_ORIGIN}/${share.targetType === "form" ? "f" : "s"}/${encodeURIComponent(share.token)}`;
}
