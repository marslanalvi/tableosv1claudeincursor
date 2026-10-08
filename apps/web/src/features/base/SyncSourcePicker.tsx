import { useQuery } from "@tanstack/react-query";
import { syncApi } from "../../lib/api-areas/sync.ts";
import { uiStyles } from "../../app/ui.tsx";
import { errorMessage } from "../../app/toast.tsx";

/** Pick a table from another base of this organization. */
export function SyncSourcePicker({ baseId, value, onChange }: { baseId: string; value: string; onChange: (tableId: string, tableName: string) => void }) {
  const sources = useQuery({ queryKey: ["sync-sources", baseId], queryFn: () => syncApi.sources(baseId) });
  if (sources.isLoading) return <p className={uiStyles.muted}>Loading bases…</p>;
  if (sources.isError) return <p className={uiStyles.error}>{errorMessage(sources.error)}</p>;
  const bases = sources.data?.bases.filter((b) => b.tables.length) ?? [];
  if (bases.length === 0) return <p className={uiStyles.muted}>There are no other bases you can read in this organization yet.</p>;
  return (
    <select
      className={uiStyles.input}
      value={value}
      onChange={(e) => {
        const t = bases.flatMap((b) => b.tables).find((x) => x.id === e.target.value);
        onChange(e.target.value, t?.name ?? "");
      }}
      aria-label="Table to sync"
    >
      <option value="">Choose a table…</option>
      {bases.map((b) => (
        <optgroup key={b.id} label={`${b.name} (${b.workspaceName})`}>
          {b.tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.recordCount} record{t.recordCount === 1 ? "" : "s"}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
