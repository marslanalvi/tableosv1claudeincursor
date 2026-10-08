import { request } from "../api.ts";

/** Owner-only access administration: members, roles, devices, API tokens. */

export type GrantRole = "creator" | "editor" | "commenter" | "viewer";
export type TokenScope = "read" | "write" | "delete";

export interface OrgSummary {
  id: string;
  name: string;
  role: string;
  isOwner: boolean;
}

export interface MemberGrant {
  resourceType: "workspace" | "base";
  resourceId: string;
  role: string;
  expiresAt: string | null;
  expired: boolean;
}

export interface MemberDevice {
  id: string;
  label: string;
  userAgent: string | null;
  lastIp: string | null;
  status: "pending" | "approved" | "revoked";
  firstSeenAt: string;
  lastSeenAt: string;
  decidedAt: string | null;
}

export interface OrgMember {
  id: string;
  email: string;
  name: string;
  orgRole: string;
  isOwner: boolean;
  status: "active" | "suspended";
  joinedAt: string | null;
  grants: MemberGrant[];
  devices: MemberDevice[];
}

export interface OrgAccess {
  org: { id: string; name: string; requireDeviceApproval: boolean };
  workspaces: { id: string; name: string; bases: { id: string; name: string }[] }[];
  members: OrgMember[];
  invitations: { id: string; email: string; role: string; workspaceId: string | null; baseId: string | null; expiresAt: string }[];
  pendingDevices: number;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  baseIds: string[] | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  status: "active" | "revoked" | "expired";
  createdAt: string;
}

export interface PendingDevice {
  orgId: string;
  orgName: string;
  status: "pending" | "revoked";
  label: string;
  ownerName: string | null;
}

const org = (id: string) => `/v1/orgs/${encodeURIComponent(id)}`;

export const adminApi = {
  orgs() {
    return request<{ orgs: OrgSummary[] }>("/v1/orgs");
  },
  currentDevice() {
    return request<{ pending: PendingDevice[] }>("/v1/devices/current");
  },
  access(orgId: string) {
    return request<OrgAccess>(`${org(orgId)}/access`);
  },
  setSettings(orgId: string, body: { requireDeviceApproval: boolean }) {
    return request<{ requireDeviceApproval: boolean }>(`${org(orgId)}/settings`, { method: "PATCH", json: body });
  },
  setGrant(
    orgId: string,
    userId: string,
    body: { workspaceId?: string; baseId?: string; role: GrantRole | null; expiresAt?: string | null },
  ) {
    return request<{ ok: true }>(`${org(orgId)}/members/${encodeURIComponent(userId)}/grants`, { method: "PUT", json: body });
  },
  setMemberStatus(orgId: string, userId: string, status: "active" | "suspended") {
    return request<{ status: string }>(`${org(orgId)}/members/${encodeURIComponent(userId)}`, { method: "PATCH", json: { status } });
  },
  removeMember(orgId: string, userId: string) {
    return request<void>(`${org(orgId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  },
  updateDevice(orgId: string, deviceId: string, body: { status?: "approved" | "revoked"; label?: string }) {
    return request<{ status: string }>(`${org(orgId)}/devices/${encodeURIComponent(deviceId)}`, { method: "PATCH", json: body });
  },
  deleteDevice(orgId: string, deviceId: string) {
    return request<void>(`${org(orgId)}/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  },
  tokens(orgId: string) {
    return request<{ tokens: ApiTokenInfo[] }>(`${org(orgId)}/api-tokens`);
  },
  createToken(orgId: string, body: { name: string; scopes: TokenScope[]; baseIds?: string[] | null; expiresAt?: string | null }) {
    return request<{ token: string; apiToken: ApiTokenInfo }>(`${org(orgId)}/api-tokens`, { method: "POST", json: body });
  },
  revokeToken(orgId: string, tokenId: string) {
    return request<void>(`${org(orgId)}/api-tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
  },
};
