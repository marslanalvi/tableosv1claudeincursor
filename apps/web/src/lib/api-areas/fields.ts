import { ApiProblemError, request } from "../api.ts";

/** CONTRACTS §4 FieldDto. */
export interface FieldWire {
  id: string;
  name: string;
  type: string;
  slot?: number;
  config: Record<string, unknown>;
  description?: string | null;
  isPrimary?: boolean;
  isComputed?: boolean;
}

export interface CollaboratorWire {
  id: string;
  name: string;
  email: string;
  role?: string;
}

const tbl = (b: string, t: string) => `/v1/bases/${b}/tables/${t}`;

function unwrapField(res: unknown): FieldWire | null {
  const r = res as { field?: FieldWire } & FieldWire;
  const f = r && r.field ? r.field : r && r.id ? r : null;
  return f ? { ...f, config: (f.config ?? {}) as Record<string, unknown> } : null;
}

/** Re-read a field when a mutation answered without a body. */
async function refetchField(baseId: string, tableId: string, match: (f: FieldWire) => boolean): Promise<FieldWire> {
  const all = await fieldsApi.list(baseId, tableId);
  const hit = all.find(match);
  if (!hit) throw new Error("Field not found after saving");
  return { ...hit, config: hit.config ?? {} };
}

function isNotFound(e: unknown): boolean {
  return e instanceof ApiProblemError && (e.problem.status === 404 || e.problem.status === 405);
}

export const fieldsApi = {
  async list(baseId: string, tableId: string) {
    const res = await request<{ fields: FieldWire[] }>(`${tbl(baseId, tableId)}/fields`);
    return res.fields;
  },

  async create(
    baseId: string,
    tableId: string,
    body: { name: string; type: string; config?: Record<string, unknown>; description?: string | null },
  ) {
    const f = unwrapField(await request(`${tbl(baseId, tableId)}/fields`, { method: "POST", json: body }));
    return f ?? refetchField(baseId, tableId, (x) => x.name === body.name);
  },

  async update(
    baseId: string,
    tableId: string,
    fieldId: string,
    body: { name?: string; type?: string; config?: Record<string, unknown>; description?: string | null },
  ) {
    const f = unwrapField(await request(`${tbl(baseId, tableId)}/fields/${fieldId}`, { method: "PATCH", json: body }));
    return f ?? refetchField(baseId, tableId, (x) => x.id === fieldId);
  },

  async remove(baseId: string, tableId: string, fieldId: string) {
    await request<void>(`${tbl(baseId, tableId)}/fields/${fieldId}`, { method: "DELETE" });
  },

  /** Duplicate a field; falls back to creating a copy of its schema if the route is missing. */
  async duplicate(baseId: string, tableId: string, field: FieldWire, withValues = false) {
    try {
      const f = unwrapField(
        await request(`${tbl(baseId, tableId)}/fields/${field.id}/duplicate`, {
          method: "POST",
          json: { withValues },
        }),
      );
      if (f) return f;
      const all = await fieldsApi.list(baseId, tableId);
      const copy = all[all.length - 1];
      if (!copy) throw new Error("Duplicate not found");
      return { ...copy, config: copy.config ?? {} };
    } catch (e) {
      if (!isNotFound(e)) throw e;
      return fieldsApi.create(baseId, tableId, {
        name: `${field.name} copy`,
        type: field.type,
        config: field.config,
      });
    }
  },

  async reorder(baseId: string, tableId: string, fieldIds: string[]) {
    await request<void>(`${tbl(baseId, tableId)}/fields/reorder`, {
      method: "POST",
      json: { fieldIds },
    });
  },

  async setPrimary(baseId: string, tableId: string, fieldId: string) {
    await request(`${tbl(baseId, tableId)}/primary-field`, { method: "POST", json: { fieldId } });
  },
};

/** `GET /v1/bases/:b/collaborators` (F). Falls back to the signed-in user. */
export async function listBaseCollaborators(baseId: string): Promise<CollaboratorWire[]> {
  try {
    const res = await request<{ collaborators: CollaboratorWire[] }>(`/v1/bases/${baseId}/collaborators`);
    return res.collaborators;
  } catch (e) {
    if (!isNotFound(e)) throw e;
    const me = await request<{ user: CollaboratorWire }>("/v1/auth/me");
    return [me.user];
  }
}
