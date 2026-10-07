import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { shellApi } from "../../lib/api-areas/shell.ts";
import { Dialog, uiStyles } from "../../app/ui.tsx";
import { toast, errorMessage } from "../../app/toast.tsx";
import { undoStateKey } from "./BaseSessionProvider.tsx";
import styles from "./base-shell.module.css";

type Tab = "records" | "tables" | "fields";

function when(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return d.toLocaleDateString();
}

/** Base trash: deleted records, tables and fields (last 30 days) with restore. */
export function TrashDialog({ baseId, onClose }: { baseId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("records");
  const trash = useQuery({
    queryKey: ["trash", baseId],
    queryFn: () => shellApi.trash(baseId),
  });
  const restore = useMutation({
    mutationFn: (body: { recordId?: string; tableId?: string; fieldId?: string }) =>
      shellApi.restore(baseId, body),
    onSuccess: () => {
      toast.success("Restored");
      void qc.invalidateQueries({ queryKey: ["trash", baseId] });
      void qc.invalidateQueries({ queryKey: ["bases", baseId] });
      void qc.invalidateQueries({ queryKey: ["views", baseId] });
      void qc.invalidateQueries({ queryKey: ["records", baseId] });
      void qc.invalidateQueries({ queryKey: undoStateKey(baseId) });
    },
    onError: (err) => toast.error(err, "Could not restore"),
  });

  const data = trash.data;
  const counts = {
    records: data?.records.length ?? 0,
    tables: data?.tables.length ?? 0,
    fields: data?.fields.length ?? 0,
  };

  const rows: Array<{ key: string; title: string; sub: string; restore: () => void }> =
    !data
      ? []
      : tab === "records"
        ? data.records.map((r) => ({
            key: r.id,
            title: r.name,
            sub: `${r.tableName} · deleted ${when(r.deletedAt)}${r.deletedByName ? ` by ${r.deletedByName}` : ""}`,
            restore: () => restore.mutate({ recordId: r.id }),
          }))
        : tab === "tables"
          ? data.tables.map((t) => ({
              key: t.id,
              title: t.name,
              sub: `Table · deleted ${when(t.deletedAt)}${t.deletedByName ? ` by ${t.deletedByName}` : ""}`,
              restore: () => restore.mutate({ tableId: t.id }),
            }))
          : data.fields.map((f) => ({
              key: f.id,
              title: f.name,
              sub: `${f.tableName} · ${f.type} · deleted ${when(f.deletedAt)}${f.deletedByName ? ` by ${f.deletedByName}` : ""}`,
              restore: () => restore.mutate({ fieldId: f.id }),
            }));

  return (
    <Dialog title="Trash" onClose={onClose} wide>
      <p className={uiStyles.muted} style={{ marginTop: 0 }}>
        Items deleted in the last 30 days. Restoring brings back the data and links it had.
      </p>
      <div className={styles.segmented} role="tablist">
        {(["records", "tables", "fields"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={styles.segment}
            data-active={tab === t}
            onClick={() => setTab(t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)} {counts[t] ? `(${counts[t]})` : ""}
          </button>
        ))}
      </div>
      {trash.isLoading ? (
        <p className={uiStyles.muted}>Loading…</p>
      ) : trash.isError ? (
        <p className={uiStyles.error}>{errorMessage(trash.error)}</p>
      ) : rows.length === 0 ? (
        <p className={styles.trashEmpty}>Nothing in the trash.</p>
      ) : (
        <ul className={styles.trashList}>
          {rows.map((row) => (
            <li key={row.key} className={styles.trashRow}>
              <div className={styles.trashText}>
                <div className={styles.trashTitle}>{row.title}</div>
                <div className={uiStyles.muted}>{row.sub}</div>
              </div>
              <button
                type="button"
                className={`${uiStyles.btn} ${uiStyles.btnSm}`}
                disabled={restore.isPending}
                onClick={row.restore}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
