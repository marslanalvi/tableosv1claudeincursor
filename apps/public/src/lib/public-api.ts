const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export interface PublicField {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  description: string | null;
  isPrimary: boolean;
  isComputed: boolean;
}

export interface PublicRecord {
  id: string;
  createdAt?: string;
  rowNumber?: number;
  fields: Record<string, unknown>;
  errors?: Record<string, string>;
}

export interface PublicViewRef {
  id: string;
  name: string;
  type: string;
}

export interface PublicViewConfig {
  sorts?: { fieldId: string; direction: "asc" | "desc" }[];
  fieldWidths?: Record<string, number>;
  frozenFieldCount?: number;
  rowHeight?: "short" | "medium" | "tall" | "extra";
}

export interface PublicFormSpec {
  title: string;
  description: string;
  submitLabel: string;
  successMessage: string;
  allowResubmit: boolean;
  fields: { fieldId: string; required: boolean; label: string; help: string }[];
}

export interface PublicBaseTable {
  id: string;
  name: string;
  primaryFieldId: string | null;
  fields: PublicField[];
  views: PublicViewRef[];
}

interface ShareCommon {
  share: { id: string; targetType: "view" | "form" | "base"; allowCopy: boolean; expiresAt: string | null };
  base: { id: string; name: string };
  title: string;
  description: string | null;
  table: { id: string; name: string } | null;
  fields: PublicField[];
}

export type PublicSharePayload =
  | (ShareCommon & {
      kind: "view";
      view: PublicViewRef & { config: PublicViewConfig };
      primaryFieldId: string | null;
    })
  | (ShareCommon & { kind: "form"; view: PublicViewRef; form: PublicFormSpec })
  | (ShareCommon & { kind: "base"; tables: PublicBaseTable[] });

export interface FieldProblem {
  field: string;
  message: string;
}

export class ShareApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  readonly fieldErrors: FieldProblem[];

  constructor(status: number, message: string, reason: string | null, fieldErrors: FieldProblem[] = []) {
    super(message);
    this.name = "ShareApiError";
    this.status = status;
    this.reason = reason;
    this.fieldErrors = fieldErrors;
  }
}

// Unlock tokens for password-protected shares live for the browser session.
const unlockKey = (token: string) => `tabula.share.unlock:${token}`;

export function getUnlockToken(token: string): string | null {
  try {
    return sessionStorage.getItem(unlockKey(token));
  } catch {
    return null;
  }
}

function setUnlockToken(token: string, value: string): void {
  try {
    sessionStorage.setItem(unlockKey(token), value);
  } catch {
    /* storage unavailable: the user re-enters the password on reload */
  }
}

async function toError(response: Response): Promise<ShareApiError> {
  let body: { title?: string; detail?: string; meta?: { reason?: string }; errors?: FieldProblem[] } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    /* non-JSON error body */
  }
  return new ShareApiError(
    response.status,
    body.detail ?? body.title ?? response.statusText ?? "Request failed",
    body.meta?.reason ?? null,
    Array.isArray(body.errors) ? body.errors : [],
  );
}

async function call<T>(token: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const unlock = getUnlockToken(token);
  if (unlock) headers.set("X-Share-Unlock", unlock);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const response = await fetch(`${API_BASE}/v1/public/shares/${encodeURIComponent(token)}${path}`, {
    ...init,
    headers,
    body: body ?? null,
  });
  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function fetchShare(token: string): Promise<PublicSharePayload> {
  return call<PublicSharePayload>(token, "");
}

export async function unlockShare(token: string, password: string): Promise<void> {
  const res = await call<{ unlockToken: string }>(token, "/unlock", { method: "POST", json: { password } });
  setUnlockToken(token, res.unlockToken);
}

export interface QueryRecordsBody {
  tableId?: string;
  viewId?: string;
  search?: string;
  sort?: { field: string; direction: "asc" | "desc" }[];
  pageSize?: number;
  cursor?: string | null;
}

export function queryRecords(token: string, body: QueryRecordsBody) {
  return call<{ records: PublicRecord[]; nextCursor: string | null }>(token, "/records/query", {
    method: "POST",
    json: body,
  });
}

export function fetchRecord(token: string, recordId: string, scope: { tableId?: string; viewId?: string } = {}) {
  const qs = new URLSearchParams();
  if (scope.tableId) qs.set("tableId", scope.tableId);
  if (scope.viewId) qs.set("viewId", scope.viewId);
  const q = qs.toString();
  return call<{ record: PublicRecord }>(token, `/records/${encodeURIComponent(recordId)}${q ? `?${q}` : ""}`);
}

export function submitShareForm(token: string, fields: Record<string, unknown>) {
  return call<{ ok: true; record: { id: string | null }; successMessage: string; allowResubmit: boolean }>(
    token,
    "/submit",
    { method: "POST", json: { fields } },
  );
}

export interface UploadedFile {
  id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  thumbnailUrl: string | null;
}

/** Form attachment upload through the share: presign → PUT (with progress) → complete. */
export async function uploadFormFile(
  token: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<UploadedFile> {
  const mime = file.type || "application/octet-stream";
  const presign = await call<{
    attachmentId: string;
    upload: { url: string; method?: string; headers?: Record<string, string> };
  }>(token, "/attachments/presign", { method: "POST", json: { filename: file.name, mime, size: file.size } });

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = /^https?:\/\//i.test(presign.upload.url) ? presign.upload.url : `${API_BASE}${presign.upload.url}`;
    xhr.open(presign.upload.method ?? "PUT", url);
    const headers = presign.upload.headers ?? { "Content-Type": mime };
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    const unlock = getUnlockToken(token);
    if (unlock && !/^https?:\/\//i.test(presign.upload.url)) xhr.setRequestHeader("X-Share-Unlock", unlock);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        const p = JSON.parse(xhr.responseText) as { detail?: string };
        if (p.detail) message = p.detail;
      } catch {
        /* keep default */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(file);
  });

  const done = await call<{ attachment: UploadedFile }>(token, "/attachments/complete", {
    method: "POST",
    json: { attachmentId: presign.attachmentId },
  });
  return done.attachment;
}

export function fileUrl(url: string | null | undefined): string {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `${API_BASE}${url}`;
}
