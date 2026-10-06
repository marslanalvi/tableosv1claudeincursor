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

function unwrapField(res: unknown): FieldWire {
  const r = res as { field?: FieldWire } & FieldWire;
  const f = r && r.field ? r.field : r;
  return { ...f, config: (f.config ?? {}) as Record<string, unknown> };
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
    return unwrapField(
      await request(`${tbl(baseId, tableId)}/fields`, { method: "POST", json: body }),
    );
  },

  async update(
    baseId: string,
    tableId: string,
    fieldId: string,
    body: { name?: string; type?: string; config?: Record<string, unknown>; description?: string | null },
  ) {
    return unwrapField(
      await request(`${tbl(baseId, tableId)}/fields/${fieldId}`, { method: "PATCH", json: body }),
    );
  },

  async remove(baseId: string, tableId: string, fieldId: string) {
    await request<void>(`${tbl(baseId, tableId)}/fields/${fieldId}`, { method: "DELETE" });
  },

  /** Duplicate a field; falls back to creating a copy of its schema if the route is missing. */
  async duplicate(baseId: string, tableId: string, field: FieldWire, withValues = false) {
    try {
      return unwrapField(
        await request(`${tbl(baseId, tableId)}/fields/${field.id}/duplicate`, {
          method: "POST",
          json: { withValues },
        }),
      );
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
