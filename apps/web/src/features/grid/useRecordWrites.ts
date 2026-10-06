import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { toInputValue, type FieldLike } from "@tabula/field-ui";
import { ApiProblemError } from "../../lib/api.ts";
import {
  errorMessage,
  putRecordInCaches,
  recordsApi,
  updateRecordCaches,
  type RecordWire,
} from "../../lib/api-areas/records.ts";
import { toastError } from "./toast.tsx";

type Overrides = Map<string, Record<string, { v: unknown; seq: number }>>;

// Shared across hook instances so the grid and the drawer serialize together.
const chains = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();
let writeSeq = 0;

export function noteRecordVersion(recordId: string, version: number | undefined): void {
  if (typeof version !== "number") return;
  if ((versions.get(recordId) ?? -1) < version) versions.set(recordId, version);
}

function enqueue<T>(ids: string[], task: () => Promise<T>): Promise<T> {
  const prev = Promise.all(ids.map((id) => chains.get(id) ?? Promise.resolve())).catch(() => undefined);
  const next = prev.then(task);
  const settled = next.catch(() => undefined);
  for (const id of ids) chains.set(id, settled);
  void settled.then(() => {
    for (const id of ids) if (chains.get(id) === settled) chains.delete(id);
  });
  return next;
}

/**
 * Cell writes with optimistic overlay, per-record serialization (so
 * back-to-back edits never 409 on our own version), 409 recovery, rollback
 * and an error toast.
 */
export function useRecordWrites(
  baseId: string,
  tableId: string,
  fields: FieldLike[],
  lookup: (recordId: string) => RecordWire | undefined,
) {
  const qc = useQueryClient();
  const [overrides, setOverrides] = useState<Overrides>(() => new Map());
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;

  const setOverlay = useCallback((recordId: string, patch: Record<string, unknown>, seq: number) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      const cur = { ...(next.get(recordId) ?? {}) };
      for (const [k, v] of Object.entries(patch)) cur[k] = { v, seq };
      next.set(recordId, cur);
      return next;
    });
  }, []);

  const clearOverlay = useCallback((recordId: string, keys: string[], seq: number) => {
    setOverrides((prev) => {
      const cur = prev.get(recordId);
      if (!cur) return prev;
      const rest = { ...cur };
      let changed = false;
      for (const k of keys) {
        if (rest[k] && rest[k]!.seq === seq) {
          delete rest[k];
          changed = true;
        }
      }
      if (!changed) return prev;
      const next = new Map(prev);
      if (Object.keys(rest).length) next.set(recordId, rest);
      else next.delete(recordId);
      return next;
    });
  }, []);

  /** Apply a successful write locally (server copy if it has fields, else our patch). */
  const applyResult = useCallback(
    (recordId: string, patch: Record<string, unknown>, rec: RecordWire | undefined) => {
      if (rec && rec.fields && rec.id) {
        noteRecordVersion(rec.id, rec.version);
        putRecordInCaches(qc, baseId, tableId, rec);
        return;
      }
      updateRecordCaches(qc, baseId, tableId, (r) => {
        if (r.id !== recordId) return r;
        const f = { ...r.fields };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0)) delete f[k];
          else f[k] = v;
        }
        return { ...r, fields: f, ...(rec && typeof rec.version === "number" ? { version: rec.version } : {}) };
      });
      if (rec && typeof rec.version === "number") noteRecordVersion(recordId, rec.version);
    },
    [qc, baseId, tableId],
  );

  const toInput = useCallback((patch: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const f = fieldsRef.current.find((x) => x.id === k);
      out[k] = f ? toInputValue(f, v) : v;
    }
    return out;
  }, []);

  /** Write one record's cells. `patch` holds output-shaped values (null clears). */
  const writeRecord = useCallback(
    (recordId: string, patch: Record<string, unknown>, opts: { typecast?: boolean } = {}) => {
      const seq = ++writeSeq;
      setOverlay(recordId, patch, seq);
      const keys = Object.keys(patch);
      return enqueue([recordId], async () => {
        const currentVersion = () =>
          Math.max(versions.get(recordId) ?? -1, lookupRef.current(recordId)?.version ?? -1);
        const send = (version: number) =>
          recordsApi.patch(baseId, tableId, recordId, toInput(patch), {
            ...(version >= 0 ? { version } : {}),
            ...(opts.typecast ? { typecast: true } : {}),
          });
        try {
          let rec: RecordWire;
          try {
            rec = await send(currentVersion());
          } catch (e) {
            if (!(e instanceof ApiProblemError && e.problem.status === 409)) throw e;
            // Someone else changed the record: refresh its version and retry once.
            const fresh = await recordsApi.get(baseId, tableId, recordId);
            noteRecordVersion(fresh.id, fresh.version);
            putRecordInCaches(qc, baseId, tableId, fresh);
            rec = await send(fresh.version);
          }
          applyResult(recordId, patch, rec);
        } catch (e) {
          toastError(`Couldn't save: ${errorMessage(e)}`);
          void qc.invalidateQueries({ queryKey: ["records", baseId, tableId] });
          void qc.invalidateQueries({ queryKey: ["record", baseId, tableId, recordId] });
          throw e;
        } finally {
          clearOverlay(recordId, keys, seq);
        }
      }).catch(() => undefined);
    },
    [baseId, tableId, qc, setOverlay, clearOverlay, toInput, applyResult],
  );

  /** Bulk write (paste, fill, clear). */
  const writeMany = useCallback(
    (rows: { id: string; fields: Record<string, unknown> }[], opts: { typecast?: boolean; raw?: Record<string, Record<string, unknown>> } = {}) => {
      if (rows.length === 0) return Promise.resolve();
      if (rows.length === 1 && !opts.raw) return writeRecord(rows[0]!.id, rows[0]!.fields, opts);
      const seq = ++writeSeq;
      for (const r of rows) setOverlay(r.id, r.fields, seq);
      const ids = rows.map((r) => r.id);
      return enqueue(ids, async () => {
        try {
          const payload = rows.map((r) => ({ id: r.id, fields: { ...toInput(r.fields), ...(opts.raw?.[r.id] ?? {}) } }));
          const recs = await recordsApi.patchMany(baseId, tableId, payload, opts.typecast ?? false);
          const byId = new Map(recs.map((r) => [r.id, r]));
          for (const r of rows) applyResult(r.id, r.fields, byId.get(r.id));
          if (opts.raw) void qc.invalidateQueries({ queryKey: ["records", baseId, tableId] });
        } catch (e) {
          toastError(`Couldn't save ${rows.length} records: ${errorMessage(e)}`);
          void qc.invalidateQueries({ queryKey: ["records", baseId, tableId] });
          throw e;
        } finally {
          for (const r of rows) clearOverlay(r.id, Object.keys(r.fields), seq);
        }
      }).catch(() => undefined);
    },
    [baseId, tableId, qc, setOverlay, clearOverlay, toInput, applyResult, writeRecord],
  );

  /** Overlay pending values on a server record. */
  const withOverrides = useCallback(
    <R extends { id: string; fields: Record<string, unknown> }>(rec: R): R => {
      const o = overrides.get(rec.id);
      if (!o) return rec;
      const f = { ...rec.fields };
      for (const [k, { v }] of Object.entries(o)) {
        if (v === null || v === undefined) delete f[k];
        else f[k] = v;
      }
      return { ...rec, fields: f };
    },
    [overrides],
  );

  return { writeRecord, writeMany, withOverrides, overrides };
}
