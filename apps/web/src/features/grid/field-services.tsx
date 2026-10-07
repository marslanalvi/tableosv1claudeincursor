import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  FieldUiServicesProvider,
  cellValueToText,
  nextOptionColor,
  randomOptionId,
  type AttachmentValue,
  type FieldLike,
  type FieldUiServices,
  type SelectOption,
  type TableLike,
} from "@tabula/field-ui";
import { api, request, type BaseDetail } from "../../lib/api.ts";
import { fieldsApi, listBaseCollaborators } from "../../lib/api-areas/fields.ts";
import { recordsApi } from "../../lib/api-areas/records.ts";

type UploadFn = (baseId: string, file: File, onProgress?: (f: number) => void) => Promise<AttachmentValue>;

// E owns `lib/api-areas/files.ts` (uploadAttachment). Load it lazily when present.
const filesModules = import.meta.glob("../../lib/api-areas/files.ts");

async function fallbackUpload(baseId: string, file: File, onProgress?: (f: number) => void): Promise<AttachmentValue> {
  const mime = file.type || "application/octet-stream";
  const presign = await request<{
    attachmentId: string;
    upload: { url: string; method?: string; headers?: Record<string, string> };
  }>(`/v1/bases/${baseId}/attachments/presign`, {
    method: "POST",
    json: { filename: file.name, mime, size: file.size },
  });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(presign.upload.method ?? "PUT", presign.upload.url);
    for (const [k, v] of Object.entries(presign.upload.headers ?? {})) xhr.setRequestHeader(k, v);
    if (!presign.upload.headers?.["Content-Type"]) xhr.setRequestHeader("Content-Type", mime);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
  const done = await request<{ attachment?: AttachmentValue }>(`/v1/bases/${baseId}/attachments/complete`, {
    method: "POST",
    json: { attachmentId: presign.attachmentId },
  });
  if (done?.attachment?.id) return done.attachment;
  let url: string | null = null;
  try {
    const got = await request<{ attachment?: { url?: string }; url?: string }>(
      `/v1/bases/${baseId}/attachments/${presign.attachmentId}`,
    );
    url = got.attachment?.url ?? got.url ?? null;
  } catch {
    /* URL resolves later from the record payload */
  }
  return { id: presign.attachmentId, filename: file.name, mime, size: file.size, url, thumbnailUrl: null };
}

export async function uploadAttachment(baseId: string, file: File, onProgress?: (f: number) => void) {
  const loader = filesModules["../../lib/api-areas/files.ts"];
  if (loader) {
    const mod = (await loader()) as { uploadAttachment?: UploadFn };
    if (mod.uploadAttachment) {
      const att = await mod.uploadAttachment(baseId, file, onProgress);
      if (att?.id) return att;
    }
  }
  return fallbackUpload(baseId, file, onProgress);
}

export function useBaseDetail(baseId: string) {
  return useQuery({
    queryKey: ["bases", baseId],
    queryFn: () => api.getBase(baseId),
    staleTime: 30_000,
  });
}

export type BaseRole = "owner" | "creator" | "editor" | "commenter" | "viewer";

/** The signed-in user's effective role in the base (`GET /v1/bases/:b/collaborators` + `/v1/auth/me`). */
export function useBaseRole(baseId: string) {
  const q = useQuery({
    queryKey: ["base-role", baseId],
    queryFn: async () => {
      const [list, me] = await Promise.all([
        listBaseCollaborators(baseId),
        request<{ user?: { id: string } }>("/v1/auth/me"),
      ]);
      const mine = list.find((c) => c.id === me.user?.id);
      return (mine?.role ?? "viewer") as BaseRole;
    },
    staleTime: 60_000,
  });
  const role = q.data;
  return {
    role,
    /** `undefined` until the role has loaded. */
    canEditRecords: role === undefined ? undefined : role === "owner" || role === "creator" || role === "editor",
    canEditSchema: role === undefined ? undefined : role === "owner" || role === "creator",
  };
}

export function primaryFieldOf(table: { primaryFieldId?: string; fields: FieldLike[] }): FieldLike | undefined {
  return table.fields.find((f) => f.id === table.primaryFieldId) ?? table.fields.find((f) => f.isPrimary) ?? table.fields[0];
}

export function recordTitle(table: { primaryFieldId?: string; fields: FieldLike[] }, rec: { fields: Record<string, unknown> }): string {
  const pf = primaryFieldOf(table);
  return pf ? cellValueToText(pf, rec.fields[pf.id]) : "";
}

export function useFieldServices(baseId: string): FieldUiServices {
  const qc = useQueryClient();
  const base = useBaseDetail(baseId);
  const tables = base.data?.tables;
  return useMemo<FieldUiServices>(() => {
    const tableById = (id: string) =>
      (qc.getQueryData<BaseDetail>(["bases", baseId])?.tables ?? tables ?? []).find((t) => t.id === id);
    return {
      tables: (tables ?? []) as unknown as TableLike[],
      portal: (node) => createPortal(node, document.body),
      async searchRecords(tableId, query) {
        const t = tableById(tableId);
        const page = await recordsApi.query(baseId, tableId, { search: query, pageSize: 50 });
        let rows = page.records;
        if (query && t) {
          // Guard in case search isn't applied server-side.
          const q = query.toLowerCase();
          rows = rows.filter((r) => recordTitle(t, r).toLowerCase().includes(q) || JSON.stringify(r.fields).toLowerCase().includes(q));
        }
        return rows.map((r) => ({ id: r.id, name: t ? recordTitle(t, r) : r.id }));
      },
      async createRecord(tableId, name) {
        const t = tableById(tableId);
        const pf = t ? primaryFieldOf(t) : undefined;
        const rec = await recordsApi.create(baseId, tableId, pf && name ? { [pf.id]: name } : {}, true);
        void qc.invalidateQueries({ queryKey: ["records", baseId, tableId] });
        if (!rec) throw new Error("The new record could not be read back; try again.");
        return { id: rec.id, name };
      },
      async listCollaborators() {
        const list = await listBaseCollaborators(baseId);
        return list.map((c) => ({ id: c.id, name: c.name, email: c.email }));
      },
      uploadAttachment: (file, onProgress) => uploadAttachment(baseId, file, onProgress),
      async createSelectOption(field, label) {
        const tableId = (qc.getQueryData<BaseDetail>(["bases", baseId])?.tables ?? []).find((t) =>
          t.fields.some((f) => f.id === field.id),
        )?.id;
        if (!tableId) throw new Error("Field not found");
        const options = ((field.config?.["options"] ?? []) as SelectOption[]).slice();
        const opt: SelectOption = { id: randomOptionId(), label, color: nextOptionColor(options.length) };
        const updated = await fieldsApi.update(baseId, tableId, field.id, {
          config: { ...(field.config ?? {}), options: [...options, opt] },
        });
        await qc.invalidateQueries({ queryKey: ["bases", baseId] });
        // Server may assign its own id; match by label.
        const saved = ((updated.config["options"] ?? []) as SelectOption[]).find((o) => o.label === label);
        return saved ?? opt;
      },
    };
  }, [baseId, qc, tables]);
}

export function FieldServices({ baseId, children }: { baseId: string; children: ReactNode }) {
  const services = useFieldServices(baseId);
  return <FieldUiServicesProvider value={services}>{children}</FieldUiServicesProvider>;
}
