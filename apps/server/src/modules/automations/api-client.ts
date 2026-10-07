import { SESSION_COOKIE_NAME } from "@tabula/auth";
import { resolveLookupTargets } from "./filter-eval.js";
import type { TableMeta, WireRecord } from "./tokens.js";

/**
 * Automations perform record reads/writes through the public HTTP API (as the
 * automation's owner, with a short-lived service session) so they get exactly
 * the same validation, typecast, compute, links, permissions and realtime
 * fan-out as a user edit. Writes carry `X-Tabula-Client-Op-Id: aut:<runId>`,
 * which the kernel stores as the change's client mutation id — that is how the
 * automation consumer recognises (and loop-guards) changes caused by a run.
 */
export class AutomationApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AutomationApiError";
  }

  /** 4xx (except 408/409/429) are permanent; everything else is retryable. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 409 || this.status === 429;
  }
}

export interface BaseDetailLite {
  id: string;
  name: string;
  tables: TableMeta[];
}

export class AutomationApiClient {
  private baseCache: BaseDetailLite | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly sessionToken: string,
    private readonly clientOpId: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      cookie: `${SESSION_COOKIE_NAME}=${this.sessionToken}`,
      "x-tabula-client-op-id": this.clientOpId,
      "user-agent": "tabula-automation",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new AutomationApiError(0, `API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const p = json as { detail?: string; title?: string; errors?: { field?: string; message: string }[] } | undefined;
      const extra = p?.errors?.length ? ` (${p.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; ")})` : "";
      throw new AutomationApiError(res.status, `${p?.detail ?? p?.title ?? `HTTP ${res.status}`}${extra}`);
    }
    return json as T;
  }

  async getBase(baseId: string): Promise<BaseDetailLite> {
    if (this.baseCache && this.baseCache.id === baseId) return this.baseCache;
    const raw = await this.request<Record<string, unknown>>("GET", `/v1/bases/${baseId}`);
    const b = ((raw["base"] as Record<string, unknown> | undefined) ?? raw) as Record<string, unknown>;
    const tables = ((b["tables"] ?? raw["tables"] ?? []) as Record<string, unknown>[]).map((t) => ({
      id: String(t["id"]),
      name: String(t["name"] ?? ""),
      fields: ((t["fields"] ?? []) as Record<string, unknown>[]).map((f) => ({
        id: String(f["id"]),
        name: String(f["name"] ?? ""),
        type: String(f["type"] ?? "text"),
        ...(typeof f["slot"] === "number" ? { slot: f["slot"] as number } : {}),
        config: (f["config"] ?? {}) as Record<string, unknown>,
      })),
      views: ((t["views"] ?? []) as Record<string, unknown>[]).map((v) => ({
        id: String(v["id"]),
        name: String(v["name"] ?? ""),
        ...(typeof v["type"] === "string" ? { type: v["type"] as string } : {}),
        config: (v["config"] ?? {}) as Record<string, unknown>,
      })),
    }));
    this.baseCache = { id: baseId, name: String(b["name"] ?? ""), tables: resolveLookupTargets(tables) };
    return this.baseCache;
  }

  async getRecord(baseId: string, tableId: string, recordId: string): Promise<WireRecord | null> {
    try {
      const res = await this.request<{ record: WireRecord }>(
        "GET",
        `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}`,
      );
      return normalizeRecord(res.record);
    } catch (err) {
      if (err instanceof AutomationApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createRecord(baseId: string, tableId: string, fields: Record<string, unknown>): Promise<WireRecord> {
    const res = await this.request<{ record: WireRecord }>(
      "POST",
      `/v1/bases/${baseId}/tables/${tableId}/records`,
      { fields, typecast: true },
    );
    const rec = normalizeRecord(res.record);
    if (Object.keys(rec.fields).length === 0 && rec.id) {
      return (await this.getRecord(baseId, tableId, rec.id)) ?? rec;
    }
    return rec;
  }

  async updateRecord(
    baseId: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<WireRecord> {
    const res = await this.request<{ record: WireRecord }>(
      "PATCH",
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}`,
      { fields, typecast: true },
    );
    const rec = normalizeRecord(res.record);
    if (Object.keys(rec.fields).length === 0) {
      // Older write responses omit fields; read the record back.
      return (await this.getRecord(baseId, tableId, recordId)) ?? rec;
    }
    return rec;
  }

  async deleteRecord(baseId: string, tableId: string, recordId: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}`);
  }

  async queryRecords(
    baseId: string,
    tableId: string,
    body: { filter?: unknown; viewId?: string; pageSize?: number },
  ): Promise<WireRecord[]> {
    const res = await this.request<{ records: WireRecord[] }>(
      "POST",
      `/v1/bases/${baseId}/tables/${tableId}/records/query`,
      body,
    );
    return (res.records ?? []).map(normalizeRecord);
  }
}

function normalizeRecord(r: WireRecord | undefined): WireRecord {
  const rec = (r ?? { id: "", fields: {} }) as WireRecord & { cells?: Record<string, unknown> };
  return {
    id: rec.id,
    ...(rec.createdAt ? { createdAt: rec.createdAt } : {}),
    ...(rec.updatedAt ? { updatedAt: rec.updatedAt } : {}),
    fields: rec.fields ?? rec.cells ?? {},
  };
}
