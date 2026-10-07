import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { BaseDetail } from "../../lib/api.ts";
import { fieldsApi, type FieldWire } from "../../lib/api-areas/fields.ts";
import { errorMessage } from "../../lib/api-areas/records.ts";
import { toastError } from "../grid/toast.tsx";

/** Field schema mutations with cache refresh + error toasts. */
export function useFieldActions(baseId: string, tableId: string) {
  const qc = useQueryClient();
  return useMemo(() => {
    const refresh = async () => {
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });
      void qc.invalidateQueries({ queryKey: ["records", baseId, tableId] });
      void qc.invalidateQueries({ queryKey: ["record", baseId, tableId] });
    };
    /** Optimistically patch the field in the base cache. */
    const patchCache = (fieldId: string, fn: (f: FieldWire) => FieldWire | null) => {
      qc.setQueryData<BaseDetail>(["bases", baseId], (old) =>
        old
          ? {
              ...old,
              tables: old.tables.map((t) =>
                t.id !== tableId
                  ? t
                  : {
                      ...t,
                      fields: t.fields.flatMap((f) => {
                        if (f.id !== fieldId) return [f];
                        const n = fn(f as unknown as FieldWire);
                        return n ? [n as unknown as typeof f] : [];
                      }),
                    },
              ),
            }
          : old,
      );
    };
    const wrap = async <T>(label: string, p: () => Promise<T>): Promise<T> => {
      try {
        return await p();
      } catch (e) {
        toastError(`${label}: ${errorMessage(e)}`);
        throw e;
      }
    };
    return {
      refresh,
      create: (body: { name: string; type: string; config?: Record<string, unknown>; description?: string | null }) =>
        wrap("Couldn't create field", async () => {
          const f = await fieldsApi.create(baseId, tableId, body);
          await refresh();
          return f;
        }),
      update: (
        fieldId: string,
        body: { name?: string; type?: string; config?: Record<string, unknown>; description?: string | null },
      ) =>
        wrap("Couldn't update field", async () => {
          patchCache(fieldId, (f) => ({ ...f, ...body, config: body.config ?? f.config }));
          try {
            const f = await fieldsApi.update(baseId, tableId, fieldId, body);
            await refresh();
            return f;
          } catch (e) {
            await refresh();
            throw e;
          }
        }),
      remove: (fieldId: string) =>
        wrap("Couldn't delete field", async () => {
          patchCache(fieldId, () => null);
          try {
            await fieldsApi.remove(baseId, tableId, fieldId);
          } finally {
            await refresh();
          }
        }),
      duplicate: (field: FieldWire, withValues = true) =>
        wrap("Couldn't duplicate field", async () => {
          const f = await fieldsApi.duplicate(baseId, tableId, field, withValues);
          await refresh();
          return f;
        }),
      reorder: (fieldIds: string[]) =>
        wrap("Couldn't reorder fields", async () => {
          await fieldsApi.reorder(baseId, tableId, fieldIds);
          await refresh();
        }),
    };
  }, [qc, baseId, tableId]);
}
