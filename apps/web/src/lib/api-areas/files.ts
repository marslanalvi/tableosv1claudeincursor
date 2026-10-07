import { ApiProblemError, request } from "../api.ts";

/** CONTRACTS §3 attachment cell element. */
export interface AttachmentWire {
  id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

interface PresignResponse {
  attachmentId: string;
  upload: { url: string; method?: string; headers?: Record<string, string> };
}

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

function absolute(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${API_BASE}${url}`;
}

/** PUT a file with progress (XHR: fetch has no upload progress). */
export function putWithProgress(
  url: string,
  file: Blob,
  opts: { method?: string; headers?: Record<string, string>; onProgress?: (fraction: number) => void; withCredentials?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method ?? "PUT", absolute(url));
    xhr.withCredentials = opts.withCredentials ?? !/^https?:\/\//i.test(url);
    const headers = { ...(opts.headers ?? {}) };
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = file.type || "application/octet-stream";
    }
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status < 300) {
        opts.onProgress?.(1);
        resolve();
        return;
      }
      let detail = `Upload failed (${xhr.status})`;
      try {
        const p = JSON.parse(xhr.responseText) as { detail?: string };
        if (p.detail) detail = p.detail;
      } catch {
        /* ignore */
      }
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(file);
  });
}

/**
 * Upload a file as an attachment of a base: presign → PUT (progress) → complete.
 * Returns the wire object to put in an attachment cell (`[{id}]` or the object).
 * Throws an Error with a readable message (storage unavailable, too large, …).
 */
export async function uploadAttachment(
  baseId: string,
  file: File,
  onProgress?: (fraction: number) => void,
  target?: { tableId?: string; recordId?: string; fieldId?: string },
): Promise<AttachmentWire> {
  const mime = file.type || "application/octet-stream";
  let presign: PresignResponse;
  try {
    presign = await request<PresignResponse>(`/v1/bases/${baseId}/attachments/presign`, {
      method: "POST",
      json: { filename: file.name, mime, size: file.size, ...(target ?? {}) },
    });
  } catch (err) {
    throw new Error(uploadErrorMessage(err));
  }
  await putWithProgress(presign.upload.url, file, {
    method: presign.upload.method ?? "PUT",
    headers: presign.upload.headers ?? { "Content-Type": mime },
    ...(onProgress ? { onProgress } : {}),
  });
  try {
    const done = await request<{ attachment: AttachmentWire }>(`/v1/bases/${baseId}/attachments/complete`, {
      method: "POST",
      json: { attachmentId: presign.attachmentId },
    });
    return done.attachment;
  } catch (err) {
    throw new Error(uploadErrorMessage(err));
  }
}

/** Fresh signed URL + metadata for an attachment. */
export function getAttachment(baseId: string, attachmentId: string) {
  return request<{ attachment: AttachmentWire & { scanStatus: string; createdAt: string } }>(
    `/v1/bases/${baseId}/attachments/${attachmentId}`,
  );
}

export function listRecordAttachments(baseId: string, tableId: string, recordId: string) {
  return request<{ attachments: (AttachmentWire & { fieldId: string })[] }>(
    `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}/attachments`,
  );
}

export function uploadErrorMessage(err: unknown): string {
  if (err instanceof ApiProblemError) {
    if (err.problem.status === 503) return "File uploads are unavailable: storage is not configured on this server.";
    if (err.problem.status === 413) return err.problem.detail ?? "File is too large.";
    if (err.problem.status === 402) return err.problem.detail ?? "Attachment storage limit reached for this plan.";
    return err.problem.detail ?? err.problem.title;
  }
  return err instanceof Error ? err.message : "Upload failed";
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
