import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  FieldUiServicesProvider,
  FieldValueEditor,
  fieldTypeIcon,
  toInputValue,
  type FieldLike,
} from "@tabula/field-ui";
import { errorMessage, recordsApi, removeRecordsFromCaches, type RecordWire } from "../../lib/api-areas/records.ts";
import { primaryFieldOf, recordTitle, useBaseDetail, useFieldServices } from "../grid/field-services.tsx";
import { isEditableField } from "../grid/grid-utils.ts";
import { ConfirmDialog, Menu, type MenuEntry } from "../grid/Menu.tsx";
import { Toaster, toastError, toastInfo } from "../grid/toast.tsx";
import { noteRecordVersion, useRecordWrites } from "../grid/useRecordWrites.ts";
import { RecordActivity } from "./RecordActivity.tsx";
import styles from "./record-drawer-v2.module.css";

// E owns RecordComments; mount it when the file exists (CONTRACTS §10).
const commentModules = import.meta.glob("../comments/RecordComments.tsx");
const commentsLoader = commentModules["../comments/RecordComments.tsx"];
type CommentsProps = { baseId: string; tableId: string; recordId: string };
const RecordComments = commentsLoader
  ? lazy(async (): Promise<{ default: ComponentType<CommentsProps> }> => {
      const mod = (await commentsLoader()) as { RecordComments?: ComponentType<CommentsProps> };
      return { default: mod.RecordComments ?? (() => null) };
    })
  : null;

/** Find a record in any cached records query (instant open from the grid). */
function findCached(qc: ReturnType<typeof useQueryClient>, baseId: string, tableId: string, recordId: string): RecordWire | undefined {
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: ["records", baseId, tableId] })) {
    const d = data as { pages?: { records: RecordWire[] }[]; records?: RecordWire[] } | RecordWire[] | undefined;
    const list = Array.isArray(d) ? d : d?.pages ? d.pages.flatMap((p) => p.records) : (d?.records ?? []);
    const hit = list.find((r) => r.id === recordId);
    if (hit) return hit;
  }
  return undefined;
}

/** Ordered record ids from the grid (preferred) or any records query, for prev/next. */
function orderedIds(qc: ReturnType<typeof useQueryClient>, baseId: string, tableId: string, recordId: string): string[] {
  const entries = qc.getQueriesData<unknown>({ queryKey: ["records", baseId, tableId] });
  entries.sort((a, b) => (a[0][3] === "grid" ? -1 : 0) - (b[0][3] === "grid" ? -1 : 0));
  for (const [, data] of entries) {
    const d = data as { pages?: { records: RecordWire[] }[]; records?: RecordWire[] } | RecordWire[] | undefined;
    const list = Array.isArray(d) ? d : d?.pages ? d.pages.flatMap((p) => p.records) : (d?.records ?? []);
    if (list.some((r) => r.id === recordId)) return list.map((r) => r.id);
  }
  return [];
}

/** Sync `?record=rec_…` with the URL (deep links). */
export function useRecordParam(): [string | null, (id: string | null) => void] {
  const read = () => new URLSearchParams(window.location.search).get("record");
  const [value, setValue] = useState<string | null>(read);
  useEffect(() => {
    const onPop = () => setValue(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const set = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("record", id);
    else url.searchParams.delete("record");
    const had = new URLSearchParams(window.location.search).has("record");
    if (id && !had) window.history.pushState(window.history.state, "", url);
    else window.history.replaceState(window.history.state, "", url);
    setValue(id);
  }, []);
  return [value, set];
}

export interface RecordDrawerProps {
  baseId: string;
  tableId: string;
  recordId: string;
  onClose: () => void;
  /** Called with the id of the record to show (prev/next, duplicate). Navigation is hidden when absent. */
  onNavigate?: (recordId: string) => void;
  /** Fields hidden in the current view (shown in a collapsed section). */
  hiddenFieldIds?: string[];
  canEdit?: boolean;
}

/** Expanded record: all fields editable, prev/next, actions, comments. */
export function RecordDrawer({ baseId, tableId, recordId, onClose, onNavigate, hiddenFieldIds = [], canEdit = true }: RecordDrawerProps) {
  const qc = useQueryClient();
  const base = useBaseDetail(baseId);
  const services = useFieldServices(baseId);
  const table = base.data?.tables.find((t) => t.id === tableId);
  const fields = useMemo(() => ((table?.fields ?? []) as unknown as FieldLike[]), [table]);
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<null | { x: number; y: number }>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const recordQuery = useQuery({
    queryKey: ["record", baseId, tableId, recordId],
    queryFn: async () => {
      const rec = await recordsApi.get(baseId, tableId, recordId);
      noteRecordVersion(rec.id, rec.version);
      return { record: rec };
    },
    initialData: () => {
      const hit = findCached(qc, baseId, tableId, recordId);
      return hit ? { record: hit } : undefined;
    },
    initialDataUpdatedAt: 0,
  });
  const serverRec = recordQuery.data?.record;
  const writes = useRecordWrites(baseId, tableId, fields, (id) => (id === recordId ? serverRec : undefined));
  const rec = serverRec ? writes.withOverrides(serverRec) : undefined;

  const ids = useMemo(() => orderedIds(qc, baseId, tableId, recordId), [qc, baseId, tableId, recordId]);
  const idx = ids.indexOf(recordId);
  const prevId = idx > 0 ? ids[idx - 1] : undefined;
  const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      const typing = t.closest("input, textarea, select, [contenteditable=true], .tfu-pop, .tfu-modal-back");
      if (e.key === "Escape" && !typing && !menu && !confirmDelete) onClose();
      if (!typing && onNavigate && (e.key === "ArrowUp" || e.key === "k") && prevId) onNavigate(prevId);
      if (!typing && onNavigate && (e.key === "ArrowDown" || e.key === "j") && nextId) onNavigate(nextId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate, prevId, nextId, menu, confirmDelete]);

  const primary = table ? primaryFieldOf(table as never) : undefined;
  const ordered = useMemo(() => {
    const p = fields.find((f) => f.id === primary?.id);
    return p ? [p, ...fields.filter((f) => f.id !== p.id)] : fields;
  }, [fields, primary]);
  const visible = ordered.filter((f) => !hiddenFieldIds.includes(f.id) || f.id === primary?.id);
  const hidden = ordered.filter((f) => hiddenFieldIds.includes(f.id) && f.id !== primary?.id);
  const title = rec && table ? recordTitle(table as never, rec) || "Unnamed record" : "Record";

  const duplicate = async () => {
    if (!rec) return;
    try {
      const input: Record<string, unknown> = {};
      for (const f of fields) if (isEditableField(f, true) && rec.fields[f.id] !== undefined) input[f.id] = toInputValue(f, rec.fields[f.id]);
      const copy = await recordsApi.duplicate(baseId, tableId, rec.id, input);
      void qc.invalidateQueries({ queryKey: ["records", baseId, tableId] });
      toastInfo("Record duplicated");
      if (copy) onNavigate?.(copy.id);
    } catch (e) {
      toastError(`Couldn't duplicate: ${errorMessage(e)}`);
    }
  };

  const remove = async () => {
    try {
      removeRecordsFromCaches(qc, baseId, tableId, [recordId]);
      await recordsApi.remove(baseId, tableId, recordId);
      void qc.invalidateQueries({ queryKey: ["records", baseId, tableId] });
      if (onNavigate && (nextId || prevId)) onNavigate((nextId ?? prevId)!);
      else onClose();
    } catch (e) {
      toastError(`Couldn't delete: ${errorMessage(e)}`);
      void qc.invalidateQueries({ queryKey: ["records", baseId, tableId] });
    }
  };

  const copyLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("record", recordId);
    try {
      await navigator.clipboard.writeText(url.toString());
      toastInfo("Link copied");
    } catch {
      toastError("Clipboard is not available");
    }
  };

  const menuItems: MenuEntry[] = [
    { key: "dup", icon: "⧉", label: "Duplicate record", disabled: !canEdit, onSelect: () => void duplicate() },
    { key: "link", icon: "🔗", label: "Copy record URL", onSelect: () => void copyLink() },
    { key: "d", label: "", divider: true },
    { key: "del", icon: "🗑", label: "Delete record", danger: true, disabled: !canEdit, onSelect: () => setConfirmDelete(true) },
  ];

  const renderField = (f: FieldLike) => (
    <div key={f.id} className={styles.field}>
      <label className={styles.label}>
        <span className={styles.labelIcon}>{fieldTypeIcon(f.type)}</span>
        {f.name}
        {f.description ? <span className={styles.fieldDesc}>— {f.description}</span> : null}
      </label>
      <FieldValueEditor
        field={f}
        value={rec?.fields[f.id]}
        mode="form"
        readOnly={!canEdit}
        record={rec}
        fields={fields}
        error={rec?.errors?.[f.id]}
        onChange={(v) => void writes.writeRecord(recordId, { [f.id]: v })}
      />
    </div>
  );

  return (
    <FieldUiServicesProvider value={services}>
      <div
        className={styles.back}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.panel} role="dialog" aria-label={`Record: ${title}`}>
          <header className={styles.header}>
            {onNavigate ? (
              <>
                <button type="button" className={styles.navBtn} disabled={!prevId} aria-label="Previous record" title="Previous record (↑)" onClick={() => prevId && onNavigate(prevId)}>
                  ↑
                </button>
                <button type="button" className={styles.navBtn} disabled={!nextId} aria-label="Next record" title="Next record (↓)" onClick={() => nextId && onNavigate(nextId)}>
                  ↓
                </button>
              </>
            ) : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={styles.tableName}>{table?.name ?? ""}</div>
              <h2 className={styles.title}>{title}</h2>
            </div>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Record actions"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.right - 240, y: r.bottom + 4 });
              }}
            >
              ⋯
            </button>
            <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </header>
          <div className={styles.content}>
            <div className={styles.fields}>
              {recordQuery.isError && !rec ? (
                <div className={styles.status}>Couldn't load this record: {errorMessage(recordQuery.error)}</div>
              ) : !rec || !table ? (
                <div className={styles.status}>Loading…</div>
              ) : (
                <>
                  {visible.map(renderField)}
                  {hidden.length ? (
                    <>
                      <button type="button" className={styles.hiddenToggle} onClick={() => setShowHidden((s) => !s)}>
                        {showHidden ? "▾" : "▸"} {hidden.length} hidden {hidden.length === 1 ? "field" : "fields"}
                      </button>
                      {showHidden ? hidden.map(renderField) : null}
                    </>
                  ) : null}
                  <div className={styles.meta}>
                    {rec.createdAt ? `Created ${new Date(rec.createdAt).toLocaleString()}` : null}
                    {rec.updatedAt ? ` · Last modified ${new Date(rec.updatedAt).toLocaleString()}` : null}
                  </div>
                </>
              )}
            </div>
            <aside className={styles.side}>
              <RecordActivity
                baseId={baseId}
                tableId={tableId}
                recordId={recordId}
                recordVersion={serverRec?.version}
                fields={fields}
                comments={
                  RecordComments ? (
                    <Suspense fallback={<div className={styles.sideBody}>Loading comments…</div>}>
                      <RecordComments baseId={baseId} tableId={tableId} recordId={recordId} />
                    </Suspense>
                  ) : (
                    <div className={styles.sideBody}>Comments are not available yet.</div>
                  )
                }
              />
            </aside>
          </div>
        </div>
        {menu ? <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} /> : null}
        {confirmDelete ? (
          <ConfirmDialog
            title="Delete this record?"
            body="This can be undone with Undo."
            confirmLabel="Delete record"
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => {
              setConfirmDelete(false);
              void remove();
            }}
          />
        ) : null}
        <Toaster />
      </div>
    </FieldUiServicesProvider>
  );
}
