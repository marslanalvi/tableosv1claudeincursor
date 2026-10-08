import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { TableDto } from "../../lib/api.ts";
import { syncApi } from "../../lib/api-areas/sync.ts";
import { toast } from "../../app/toast.tsx";
import styles from "./base-shell.module.css";

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Shown above a synced table: where the data comes from and how fresh it is. */
export function SyncBar({ baseId, table }: { baseId: string; table: TableDto }) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const run = useMutation({
    mutationFn: () => syncApi.runNow(baseId, table.id),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });
      void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
      if (res.sync.lastError) toast.error(new Error(res.sync.lastError), "Sync failed");
    },
    onError: (err) => toast.error(err, "Could not sync"),
  });
  const s = table.sync;
  if (!s) return null;
  return (
    <div className={styles.syncBar} data-state={s.status} role="status">
      <span aria-hidden>⇄</span>
      <span>
        Synced from <strong>{s.sourceBaseName ?? "another base"}</strong> › <strong>{s.sourceTableName ?? "a table"}</strong>
        {" · "}
        {s.status === "paused" ? "paused" : s.status === "error" ? <span className={styles.syncErr}>failed: {s.lastError}</span> : `updated ${ago(s.lastSyncedAt, now)}`}
        {" · "}synced fields are read-only here; fields you add stay editable.
      </span>
      <button type="button" className={styles.syncBtn} onClick={() => run.mutate()} disabled={run.isPending}>
        {run.isPending ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
