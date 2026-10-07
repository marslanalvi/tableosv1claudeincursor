import { useEffect, useRef, useState } from "react";
import { exportUrl } from "../../lib/api-areas/collab.ts";
import s from "../share/surface.module.css";
import m from "./export-menu.module.css";

async function download(url: string): Promise<void> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    let detail = `Export failed (${res.status})`;
    try {
      const p = (await res.json()) as { detail?: string; title?: string };
      detail = p.detail ?? p.title ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "export";
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/**
 * "Download CSV / Excel" for a view (respects its filter, sort and hidden
 * fields; computed values included). CONTRACTS §10.
 * Renders its own trigger button unless `inline` (menu items only) is set.
 */
export function ExportMenu({
  baseId,
  tableId,
  viewId,
  inline,
  onDone,
}: {
  baseId: string;
  tableId: string;
  viewId?: string;
  inline?: boolean;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(Boolean(inline));
  const [busy, setBusy] = useState<"csv" | "xlsx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || inline) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, inline]);

  async function run(format: "csv" | "xlsx") {
    setBusy(format);
    setError(null);
    try {
      await download(exportUrl(baseId, tableId, format, viewId));
      if (!inline) setOpen(false);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  const items = (
    <div className={inline ? m.inline : m.menu} role="menu">
      <button type="button" role="menuitem" className={m.item} disabled={busy !== null} onClick={() => void run("csv")}>
        <span className={m.icon} aria-hidden>
          ⤓
        </span>
        <span>
          <span className={m.itemTitle}>{busy === "csv" ? "Preparing CSV…" : "Download CSV"}</span>
          <span className={m.itemHint}>Comma-separated, opens anywhere</span>
        </span>
      </button>
      <button type="button" role="menuitem" className={m.item} disabled={busy !== null} onClick={() => void run("xlsx")}>
        <span className={m.icon} aria-hidden>
          ▦
        </span>
        <span>
          <span className={m.itemTitle}>{busy === "xlsx" ? "Preparing Excel…" : "Download Excel (.xlsx)"}</span>
          <span className={m.itemHint}>Keeps numbers and checkboxes typed</span>
        </span>
      </button>
      {error ? <p className={s.error} style={{ margin: 8 }}>{error}</p> : null}
    </div>
  );

  if (inline) return items;

  return (
    <div className={m.wrap} ref={ref}>
      <button
        type="button"
        className={s.btnSecondary}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ minHeight: 32, padding: "4px 12px", borderRadius: 6 }}
      >
        Download
      </button>
      {open ? items : null}
    </div>
  );
}
