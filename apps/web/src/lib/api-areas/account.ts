import { request } from "../api.ts";

/** Workstream G: account security, sessions, MFA, invitations. */

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  mfaEnabled?: boolean;
  hasPassword?: boolean;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  authMethod: string;
  mfa: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface InvitationPreview {
  id: string;
  email: string;
  workspaceId: string | null;
  baseId: string | null;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  workspaceName: string | null;
  baseName: string | null;
  inviterName: string | null;
}

/** Login either signs in (`user`) or asks for the second factor. */
export type LoginResult =
  | { user: AccountUser; mfaRequired?: undefined }
  | { mfaRequired: true; mfaToken: string; user?: undefined };

export const accountApi = {
  me() {
    return request<{ user: AccountUser }>("/v1/auth/me");
  },
  updateProfile(name: string) {
    return request<{ user: AccountUser }>("/v1/auth/me", { method: "PATCH", json: { name } });
  },
  changePassword(currentPassword: string, newPassword: string) {
    return request<{ ok: true; otherSessionsRevoked: number }>("/v1/auth/password", {
      method: "POST",
      json: { currentPassword, newPassword },
    });
  },
  login(email: string, password: string) {
    return request<LoginResult>("/v1/auth/login", { method: "POST", json: { email, password } });
  },
  verifyMfa(mfaToken: string, code: string) {
    return request<{ user: AccountUser }>("/v1/auth/mfa/verify", { method: "POST", json: { mfaToken, code } });
  },
  logout() {
    return request<{ ok: true }>("/v1/auth/logout", { method: "POST", json: {} });
  },
  mfaStatus() {
    return request<{ enabled: boolean }>("/v1/auth/mfa");
  },
  mfaSetup() {
    return request<{ secret: string; otpauthUrl: string }>("/v1/auth/mfa/setup", { method: "POST", json: {} });
  },
  mfaEnable(code: string) {
    return request<{ ok: true; enabled: true }>("/v1/auth/mfa/enable", { method: "POST", json: { code } });
  },
  mfaDisable(body: { code?: string; password?: string }) {
    return request<{ ok: true; enabled: false }>("/v1/auth/mfa/disable", { method: "POST", json: body });
  },
  sessions() {
    return request<{ sessions: SessionInfo[] }>("/v1/auth/sessions");
  },
  revokeSession(id: string) {
    return request<void>(`/v1/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  revokeOtherSessions() {
    return request<{ revoked: number }>("/v1/auth/sessions/revoke-others", { method: "POST", json: {} });
  },
  previewInvitation(token: string) {
    return request<{ invitation: InvitationPreview }>(`/v1/public/invitations/${encodeURIComponent(token)}`);
  },
  acceptInvitation(token: string) {
    return request<{ ok: true; workspaceId: string | null; baseId: string | null; role: string }>(
      "/v1/invitations/accept",
      { method: "POST", json: { token } },
    );
  },
  createInvitation(body: { email: string; role: string; workspaceId?: string; baseId?: string }) {
    return request<{ invitation: InvitationPreview & { acceptUrl: string } }>("/v1/invitations", {
      method: "POST",
      json: body,
    });
  },
  listInvitations(q: { workspaceId?: string; baseId?: string }) {
    const qs = q.baseId ? `baseId=${q.baseId}` : `workspaceId=${q.workspaceId ?? ""}`;
    return request<{ invitations: InvitationPreview[] }>(`/v1/invitations?${qs}`);
  },
  revokeInvitation(id: string) {
    return request<void>(`/v1/invitations/${id}`, { method: "DELETE" });
  },
};
