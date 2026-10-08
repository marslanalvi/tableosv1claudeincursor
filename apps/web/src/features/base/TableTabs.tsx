import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { syncApi } from "../../lib/api-areas/sync.ts";
import { SyncSourcePicker } from "./SyncSourcePicker.tsx";
import { copyText } from "../../lib/ids.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BaseDetail, TableDto } from "../../lib/api.ts";
import { api } from "../../lib/api.ts";
import { shellApi } from "../../lib/api-areas/shell.ts";
import { ConfirmDialog, Dialog, uiStyles } from "../../app/ui.tsx";
import { toast, errorMessage } from "../../app/toast.tsx";
import { FloatingPanel } from "./floating.tsx";
import { fitTabs, moveId } from "./tab-fit.ts";
import styles from "./base-shell.module.css";

/* ---------------- icons ---------------- */

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}
const ChevronDownIcon = () => (
  <Icon>
    <path d="M4 6l4 4 4-4" />
  </Icon>
);
const ChevronRightIcon = () => (
  <Icon size={14}>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);
const CheckIcon = () => (
  <Icon size={14}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);
const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </Icon>
);
const PlusIcon = () => (
  <Icon size={14}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);
const EyeIcon = () => (
  <Icon>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Icon>
);
const EyeSlashIcon = () => (
  <Icon>
    <path d="M6.3 3.7A6.7 6.7 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.8 2.3M4.2 4.9C2.5 6.1 1.5 8 1.5 8S3.9 12.5 8 12.5a6.3 6.3 0 0 0 3.2-.9" />
    <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" />
    <path d="M2 2l12 12" />
  </Icon>
);
const GripIcon = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden focusable="false">
    {[3, 8, 13].flatMap((y) => [
      <circle key={`a${y}`} cx="3" cy={y} r="1.2" />,
      <circle key={`b${y}`} cx="7" cy={y} r="1.2" />,
    ])}
  </svg>
);

/* ---------------- pieces ---------------- */

function InlineRename({
  initial,
  onDone,
  onCancel,
}: {
  initial: string;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.select();
  }, []);
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    const v = value.trim();
    if (v && v !== initial) onDone(v);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className={styles.tabRename}
      value={value}
      size={Math.max(4, value.length + 1)}
      aria-label="Table name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          settled.current = true;
          onCancel();
        }
      }}
    />
  );
}

type AddMode = "blank" | "import" | "sync";

function AddTableDialog({
  baseId,
  defaultName,
  initialMode = "blank",
  onCreated,
  onClose,
}: {
  baseId: string;
  defaultName: string;
  initialMode?: AddMode;
  onCreated: (tableId: string, importCsv: boolean) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<AddMode>(initialMode);
  const [sourceId, setSourceId] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      if (mode === "sync") {
        const res = await syncApi.create(baseId, { sourceTableId: sourceId, ...(name.trim() ? { name: name.trim() } : {}) });
        if (res.error) toast.error(new Error(res.error), "The table was created, but the first sync failed");
        return res.tableId;
      }
      return (await api.createTable(baseId, name.trim())).table.id;
    },
    onSuccess: async (tableId) => {
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });
      onCreated(tableId, mode === "import");
      if (mode === "sync") toast.success("Synced table created. It stays up to date with the source.");
    },
  });
  const ready = mode === "sync" ? Boolean(sourceId) : Boolean(name.trim());
  return (
    <Dialog
      title="Add a table"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={uiStyles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={uiStyles.btnPrimary}
            disabled={!ready || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? (mode === "sync" ? "Syncing…" : "Creating…") : mode === "import" ? "Create and import" : mode === "sync" ? "Create synced table" : "Create table"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) create.mutate();
        }}
      >
        <div className={uiStyles.field}>
          <label className={uiStyles.label} htmlFor="new-table-name">
            Table name
          </label>
          <input
            id="new-table-name"
            className={uiStyles.input}
            value={name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className={uiStyles.label}>Start with</div>
        <div className={styles.startOptions}>
          <button
            type="button"
            className={styles.startOption}
            data-active={mode === "blank"}
            onClick={() => setMode("blank")}
          >
            <strong>Blank table</strong>
            <span>Start with a name field and a grid view.</span>
          </button>
          <button
            type="button"
            className={styles.startOption}
            data-active={mode === "import"}
            onClick={() => setMode("import")}
          >
            <strong>Import CSV</strong>
            <span>Create the table, then upload a CSV file.</span>
          </button>
          <button
            type="button"
            className={styles.startOption}
            data-active={mode === "sync"}
            onClick={() => setMode("sync")}
          >
            <strong>Sync from another base</strong>
            <span>A read-only copy of a table in another base, kept up to date. Link to it and use lookups here.</span>
          </button>
        </div>
        {mode === "sync" ? (
          <div className={uiStyles.field}>
            <label className={uiStyles.label}>Table to sync</label>
            <SyncSourcePicker
              baseId={baseId}
              value={sourceId}
              onChange={(id, tableName) => {
                setSourceId(id);
                if (tableName && (name === defaultName || !name.trim())) setName(tableName);
              }}
            />
          </div>
        ) : null}
        {create.isError ? <p className={uiStyles.error}>{errorMessage(create.error)}</p> : null}
      </form>
    </Dialog>
  );
}

interface MenuItem {
  key: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** Keyboard-navigable menu in a FloatingPanel (never clipped by the tab strip). */
function FloatingMenu({
  anchorRef,
  items,
  label,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  items: MenuItem[];
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);
  const move = (dir: 1 | -1) => {
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[(i + dir + btns.length) % btns.length]?.focus();
  };
  return (
    <FloatingPanel anchorRef={anchorRef} onClose={onClose} placement="bottom-start" className={styles.floatMenu}>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          }
        }}
      >
        {items.map((item) => (
          <div key={item.key}>
            {item.separatorBefore ? <div className={uiStyles.menuSep} /> : null}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              className={item.danger ? `${uiStyles.menuItem} ${uiStyles.menuItemDanger}` : uiStyles.menuItem}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              {item.icon !== undefined ? (
                <span className={uiStyles.menuIcon} aria-hidden>
                  {item.icon}
                </span>
              ) : null}
              <span>{item.label}</span>
            </button>
          </div>
        ))}
      </div>
    </FloatingPanel>
  );
}

/* ---------------- "∨" table switcher ---------------- */

function TablesMenu({
  anchorRef,
  tables,
  hidden,
  activeTableId,
  canHide,
  onOpenTable,
  onToggleHidden,
  onReorder,
  onAdd,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  tables: TableDto[];
  hidden: Set<string>;
  activeTableId: string | null;
  canHide: (tableId: string) => boolean;
  onOpenTable: (tableId: string) => void;
  onToggleHidden: (tableId: string, hide: boolean) => void;
  onReorder: (dragId: string, targetId: string, after: boolean) => void;
  onAdd: (mode: AddMode) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables;
  }, [tables, query]);
  const addIndex = filtered.length;
  const [hi, setHi] = useState(() => Math.max(0, tables.findIndex((t) => t.id === activeTableId)));
  const [subOpen, setSubOpen] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const gripPressed = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (hi > addIndex) setHi(addIndex);
  }, [hi, addIndex]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${hi}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  useEffect(() => {
    if (subOpen) subRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [subOpen]);

  const choose = (i: number) => {
    if (i === addIndex) {
      setSubOpen(true);
      return;
    }
    const t = filtered[i];
    if (t) onOpenTable(t.id);
  };

  const optionId = (i: number) => `tables-menu-opt-${i}`;
  const dragging = drag !== null;

  return (
    <FloatingPanel
      anchorRef={anchorRef}
      onClose={onClose}
      placement="bottom-end"
      className={styles.tablesMenu}
      role="dialog"
      ariaLabel="All tables"
    >
      <div className={styles.tablesMenuSearch}>
        <span className={styles.tablesMenuSearchIcon}>
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          className={styles.tablesMenuInput}
          placeholder="Find a table"
          aria-label="Find a table"
          role="combobox"
          aria-expanded="true"
          aria-controls="tables-menu-list"
          aria-activedescendant={hi < addIndex ? optionId(hi) : "tables-menu-add"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((h) => (h >= addIndex ? 0 : h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => (h <= 0 ? addIndex : h - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(hi);
            } else if (e.key === "ArrowRight" && hi === addIndex) {
              e.preventDefault();
              setSubOpen(true);
            }
          }}
        />
      </div>
      <ul ref={listRef} id="tables-menu-list" role="listbox" aria-label="Tables" className={styles.tablesMenuList}>
        {filtered.map((t, i) => {
          const isHidden = hidden.has(t.id);
          const active = t.id === activeTableId;
          const hideAllowed = isHidden || canHide(t.id);
          return (
            <li
              key={t.id}
              data-index={i}
              role="none"
              data-highlight={hi === i}
              data-hidden={isHidden}
              data-drop={drag?.over === t.id && drag.id !== t.id ? (drag.after ? "after" : "before") : undefined}
              className={styles.tablesMenuRow}
              draggable={!query}
              onMouseEnter={() => !dragging && setHi(i)}
              onMouseDown={(e) => {
                gripPressed.current = Boolean((e.target as HTMLElement).closest("[data-grip]"));
                if (gripPressed.current || (e.target as HTMLElement).closest("button")) return;
                e.preventDefault();
              }}
              onDragStart={(e) => {
                // only the grip starts a drag; the row itself is the drag image
                if (!gripPressed.current) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", t.id);
                setDrag({ id: t.id, over: null, after: false });
              }}
              onDragEnd={() => {
                gripPressed.current = false;
                setDrag(null);
              }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                onOpenTable(t.id);
              }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > r.top + r.height / 2;
                if (drag.over !== t.id || drag.after !== after) setDrag({ ...drag, over: t.id, after });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag && drag.id !== t.id) onReorder(drag.id, t.id, drag.after);
                setDrag(null);
              }}
            >
              {/* option children are presentational, so the row's buttons sit beside it */}
              <div
                id={optionId(i)}
                role="option"
                aria-selected={active}
                aria-description={isHidden ? "hidden" : undefined}
                className={styles.tablesMenuOption}
                title={t.name}
              >
                <span className={styles.tablesMenuCheck}>{active ? <CheckIcon /> : null}</span>
                <span className={styles.tablesMenuName}>{t.name}</span>
              </div>
              <button
                type="button"
                tabIndex={-1}
                className={styles.tablesMenuIconBtn}
                data-persist={isHidden}
                disabled={!hideAllowed}
                aria-label={isHidden ? `Show ${t.name}` : `Hide ${t.name}`}
                title={
                  isHidden ? "Show table" : hideAllowed ? "Hide table" : "At least one table must stay visible"
                }
                onClick={() => onToggleHidden(t.id, !isHidden)}
              >
                {isHidden ? <EyeIcon /> : <EyeSlashIcon />}
              </button>
              {!query ? (
                <span className={styles.tablesMenuGrip} data-grip="" title="Drag to reorder" aria-hidden>
                  <GripIcon />
                </span>
              ) : null}
            </li>
          );
        })}
        {filtered.length === 0 ? <li className={styles.tablesMenuEmpty}>No tables match “{query}”</li> : null}
      </ul>
      <div className={styles.tablesMenuFooter}>
        <button
          ref={addRef}
          id="tables-menu-add"
          type="button"
          data-index={addIndex}
          data-highlight={hi === addIndex}
          aria-haspopup="menu"
          aria-expanded={subOpen}
          className={styles.tablesMenuAdd}
          onMouseEnter={() => {
            setHi(addIndex);
            setSubOpen(true);
          }}
          onClick={() => setSubOpen(true)}
        >
          <PlusIcon />
          <span>Add table</span>
          <span className={styles.tablesMenuAddChevron}>
            <ChevronRightIcon />
          </span>
        </button>
      </div>
      {subOpen ? (
        <FloatingPanel
          anchorRef={addRef}
          placement="right-start"
          className={styles.floatMenu}
          restoreFocus={false}
          onClose={() => {
            setSubOpen(false);
            inputRef.current?.focus();
          }}
        >
          <div
            ref={subRef}
            role="menu"
            aria-label="Add table"
            onKeyDown={(e) => {
              const btns = Array.from(subRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
              const i = btns.indexOf(document.activeElement as HTMLButtonElement);
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                setSubOpen(false);
                inputRef.current?.focus();
              }
            }}
          >
            <div className={uiStyles.menuLabel}>Add a blank table</div>
            <button type="button" role="menuitem" className={uiStyles.menuItem} onClick={() => onAdd("blank")}>
              <span className={uiStyles.menuIcon} aria-hidden>
                ▦
              </span>
              <span>Start from scratch</span>
            </button>
            <div className={uiStyles.menuSep} />
            <div className={uiStyles.menuLabel}>Add from other sources</div>
            <button type="button" role="menuitem" className={uiStyles.menuItem} onClick={() => onAdd("import")}>
              <span className={uiStyles.menuIcon} aria-hidden>
                ⤓
              </span>
              <span>Import CSV file</span>
            </button>
            <button type="button" role="menuitem" className={uiStyles.menuItem} onClick={() => onAdd("sync")}>
              <span className={uiStyles.menuIcon} aria-hidden>
                ⇄
              </span>
              <span>Sync from another base</span>
            </button>
          </div>
        </FloatingPanel>
      ) : null}
    </FloatingPanel>
  );
}

/* ---------------- tab bar ---------------- */

const TAB_GAP = 2;

function TabText({ name }: { name: string }) {
  return (
    <>
      <span className={styles.tabText}>{name}</span>
      <span className={styles.tabTextBold} aria-hidden>
        {name}
      </span>
    </>
  );
}

/**
 * Airtable-style table tab bar: tabs fill the width, the rest are reachable
 * from the "∨" switcher (search, hide/show, drag to reorder, add table).
 * Click to switch, double-click to rename, caret menu, drag tabs to reorder.
 */
export function TableTabs({
  baseId,
  tables,
  hiddenTableIds,
  activeTableId,
  onSelect,
  onImport,
  onExport,
}: {
  baseId: string;
  tables: TableDto[];
  hiddenTableIds: string[];
  activeTableId: string | null;
  onSelect: (tableId: string) => void;
  onImport: (tableId: string) => void;
  onExport: (tableId: string) => void;
}) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TableDto | null>(null);
  const [adding, setAdding] = useState<AddMode | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [available, setAvailable] = useState(0);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const switcherRef = useRef<HTMLButtonElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const caretRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuAnchorRef = useRef<HTMLElement | null>(null);

  const hidden = useMemo(() => new Set(hiddenTableIds), [hiddenTableIds]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["bases", baseId] });

  const rename = useMutation({
    mutationFn: (v: { tableId: string; name: string }) =>
      shellApi.renameTable(baseId, v.tableId, v.name),
    onSuccess: () => void refresh(),
    onError: (err) => toast.error(err, "Could not rename table"),
    onSettled: () => setRenaming(null),
  });
  const duplicate = useMutation({
    mutationFn: (v: { tableId: string; withRecords: boolean }) =>
      shellApi.duplicateTable(baseId, v.tableId, v.withRecords),
    onSuccess: async (res) => {
      await refresh();
      onSelect(res.table.id);
      toast.success(`Created “${res.table.name}”`);
    },
    onError: (err) => toast.error(err, "Could not duplicate table"),
  });
  const remove = useMutation({
    mutationFn: (tableId: string) => shellApi.deleteTable(baseId, tableId),
    onSuccess: async (_r, tableId) => {
      const next = nearestVisible(tableId);
      await refresh();
      if (next && tableId === activeTableId) onSelect(next);
      setDeleting(null);
      toast.success("Table deleted — restore it from Trash or press Ctrl+Z");
    },
    onError: (err) => toast.error(err, "Could not delete table"),
  });
  const [idsFor, setIdsFor] = useState<TableDto | null>(null);
  const [stopSyncFor, setStopSyncFor] = useState<TableDto | null>(null);
  const syncNow = useMutation({
    mutationFn: (tableId: string) => syncApi.runNow(baseId, tableId),
    onSuccess: async (res) => {
      await refresh();
      if (res.sync.lastError) toast.error(new Error(res.sync.lastError), "Sync failed");
      else toast.success("Synced");
    },
    onError: (err) => toast.error(err, "Could not sync"),
  });
  const syncPause = useMutation({
    mutationFn: (v: { tableId: string; status: "active" | "paused" }) => syncApi.update(baseId, v.tableId, { status: v.status }),
    onSuccess: async (res) => {
      await refresh();
      toast.success(res.sync.status === "paused" ? "Syncing paused" : "Syncing resumed");
    },
    onError: (err) => toast.error(err, "Could not change sync"),
  });
  const stopSync = useMutation({
    mutationFn: (tableId: string) => syncApi.stop(baseId, tableId),
    onSuccess: async () => {
      await refresh();
      setStopSyncFor(null);
      toast.success("Syncing stopped. The table is now a normal table.");
    },
    onError: (err) => toast.error(err, "Could not stop syncing"),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => shellApi.reorderTables(baseId, ids),
    onSuccess: async () => {
      await refresh();
      setOptimisticOrder(null);
    },
    onError: (err) => {
      setOptimisticOrder(null);
      toast.error(err, "Could not reorder tables");
    },
  });

  const ordered = useMemo(
    () =>
      optimisticOrder
        ? (optimisticOrder.map((id) => tables.find((t) => t.id === id)).filter(Boolean) as TableDto[])
        : tables,
    [optimisticOrder, tables],
  );
  // The active table always has a tab, even if hidden (e.g. opened from a link).
  const tabTables = useMemo(
    () => ordered.filter((t) => !hidden.has(t.id) || t.id === activeTableId),
    [ordered, hidden, activeTableId],
  );
  const visibleCount = ordered.filter((t) => !hidden.has(t.id)).length;
  const canHide = (tableId: string) => !hidden.has(tableId) && visibleCount > 1;

  function nearestVisible(fromId: string): string | null {
    const idx = ordered.findIndex((t) => t.id === fromId);
    const ok = (t: TableDto | undefined) => t && t.id !== fromId && !hidden.has(t.id);
    for (let i = idx + 1; i < ordered.length; i++) if (ok(ordered[i])) return ordered[i]!.id;
    for (let i = idx - 1; i >= 0; i--) if (ok(ordered[i])) return ordered[i]!.id;
    return null;
  }

  async function setHidden(tableId: string, hide: boolean) {
    if (hide && !canHide(tableId)) return;
    const key = ["bases", baseId];
    const apply = (ids: string[]) =>
      qc.setQueryData<BaseDetail>(key, (old) => (old ? ({ ...old, hiddenTableIds: ids } as BaseDetail) : old));
    const prev = hiddenTableIds;
    if (hide && tableId === activeTableId) {
      const next = nearestVisible(tableId);
      if (next) onSelect(next);
    }
    apply(hide ? [...prev.filter((id) => id !== tableId), tableId] : prev.filter((id) => id !== tableId));
    try {
      const res = await shellApi.setTableHidden(baseId, tableId, hide);
      apply(res.hiddenTableIds);
    } catch (err) {
      apply(prev);
      toast.error(err, hide ? "Could not hide table" : "Could not show table");
    }
  }

  function commitOrder(ids: string[]) {
    if (ids.join() === ordered.map((t) => t.id).join()) return;
    setOptimisticOrder(ids);
    reorder.mutate(ids);
  }

  /* ---- measuring: which tabs fit ---- */
  const nameKey = tabTables.map((t) => `${t.id}:${t.name}`).join("|");
  useLayoutEffect(() => {
    const m = measureRef.current;
    if (!m) return;
    const measure = () => {
      const next: Record<string, number> = {};
      m.querySelectorAll<HTMLElement>("[data-measure-id]").forEach((el) => {
        next[el.dataset.measureId!] = Math.ceil(el.getBoundingClientRect().width) + TAB_GAP;
      });
      setWidths((prev) => {
        const keys = Object.keys(next);
        return keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]) ? prev : next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(m);
    return () => ro.disconnect();
  }, [nameKey]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const extra = (switcherRef.current?.offsetWidth ?? 0) + (addRef.current?.offsetWidth ?? 0) + 12;
      setAvailable(Math.max(0, wrap.clientWidth - extra));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const { shown, overflow } = useMemo(
    () => fitTabs(tabTables.map((t) => t.id), widths, available, activeTableId),
    [tabTables, widths, available, activeTableId],
  );
  const shownTables = shown.map((id) => tabTables.find((t) => t.id === id)!).filter(Boolean);

  const finishDrop = () => {
    if (dragId && drop) {
      const ids = ordered.map((t) => t.id);
      commitOrder(drop.after ? moveId(ids, dragId, null, drop.id) : moveId(ids, dragId, drop.id));
    }
    setDragId(null);
    setDrop(null);
  };

  const menuTable = menuFor ? ordered.find((t) => t.id === menuFor) : undefined;

  return (
    <div className={styles.tableTabs} ref={wrapRef}>
      <div
        className={styles.tabStrip}
        role="tablist"
        aria-label="Tables"
        onDragOver={(e) => dragId && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          finishDrop();
        }}
      >
        {shownTables.map((table) => {
          const active = table.id === activeTableId;
          return (
            <div
              key={table.id}
              className={styles.tableTab}
              data-active={active}
              data-drop={drop?.id === table.id && dragId && dragId !== table.id ? (drop.after ? "after" : "before") : undefined}
              draggable={renaming !== table.id}
              onDragStart={(e) => {
                setDragId(table.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", table.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDrop(null);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const after = e.clientX > rect.left + rect.width / 2;
                if (drop?.id !== table.id || drop.after !== after) setDrop({ id: table.id, after });
              }}
            >
              {renaming === table.id ? (
                <InlineRename
                  initial={table.name}
                  onDone={(name) => rename.mutate({ tableId: table.id, name })}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={styles.tableTabLabel}
                  title={table.name}
                  onClick={() => onSelect(table.id)}
                  onDoubleClick={() => setRenaming(table.id)}
                >
                  <TabText name={table.name} />
                  {table.sync ? (
                    <span className={styles.syncBadge} title={`Synced from ${table.sync.sourceBaseName ?? "another base"}`} aria-label="Synced table">
                      ⇄
                    </span>
                  ) : null}
                </button>
              )}
              {renaming !== table.id ? (
                <button
                  type="button"
                  ref={(el) => {
                    if (el) caretRefs.current.set(table.id, el);
                    else caretRefs.current.delete(table.id);
                  }}
                  className={styles.tabCaret}
                  data-open={menuFor === table.id}
                  tabIndex={active ? 0 : -1}
                  aria-label={`${table.name} options`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === table.id}
                  onClick={() => {
                    menuAnchorRef.current = caretRefs.current.get(table.id) ?? null;
                    setMenuFor(menuFor === table.id ? null : table.id);
                  }}
                >
                  <ChevronDownIcon />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <button
        ref={switcherRef}
        type="button"
        className={styles.tabSwitcher}
        data-open={switcherOpen}
        data-overflow={overflow.length > 0}
        aria-haspopup="dialog"
        aria-expanded={switcherOpen}
        aria-label={overflow.length ? `All tables (${overflow.length} more)` : "All tables"}
        title="All tables"
        onClick={() => setSwitcherOpen((o) => !o)}
      >
        <ChevronDownIcon />
      </button>

      <button
        ref={addRef}
        type="button"
        className={styles.addTable}
        onClick={() => setAdding("blank")}
        title="Add or import a table"
      >
        + Add or import
      </button>

      <div className={styles.tabMeasure} ref={measureRef} aria-hidden>
        {tabTables.map((t) => (
          <div key={t.id} className={styles.tableTab} data-measure-id={t.id}>
            <span className={styles.tableTabLabel}>
              <TabText name={t.name} />
              {t.sync ? <span className={styles.syncBadge}>⇄</span> : null}
            </span>
            <span className={styles.tabCaret} />
          </div>
        ))}
      </div>

      {switcherOpen ? (
        <TablesMenu
          anchorRef={switcherRef}
          tables={ordered}
          hidden={hidden}
          activeTableId={activeTableId}
          canHide={canHide}
          onOpenTable={(id) => {
            setSwitcherOpen(false);
            if (hidden.has(id)) void setHidden(id, false);
            onSelect(id);
          }}
          onToggleHidden={(id, hide) => void setHidden(id, hide)}
          onReorder={(dragged, target, after) => {
            const ids = ordered.map((t) => t.id);
            commitOrder(after ? moveId(ids, dragged, null, target) : moveId(ids, dragged, target));
          }}
          onAdd={(mode) => {
            setSwitcherOpen(false);
            setAdding(mode);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      ) : null}

      {menuTable ? (
        <FloatingMenu
          anchorRef={menuAnchorRef}
          label={`${menuTable.name} options`}
          onClose={() => setMenuFor(null)}
          items={[
            { key: "rename", label: "Rename table", icon: "✎", onSelect: () => setRenaming(menuTable.id) },
            {
              key: "dup",
              label: "Duplicate table",
              icon: "⧉",
              onSelect: () => duplicate.mutate({ tableId: menuTable.id, withRecords: true }),
            },
            {
              key: "dup-empty",
              label: "Duplicate structure only",
              icon: "⧉",
              onSelect: () => duplicate.mutate({ tableId: menuTable.id, withRecords: false }),
            },
            {
              key: "hide",
              label: "Hide table",
              icon: "◌",
              disabled: !canHide(menuTable.id),
              title: canHide(menuTable.id) ? "Hide this table from your tab bar" : "At least one table must stay visible",
              onSelect: () => void setHidden(menuTable.id, true),
            },
            {
              key: "import",
              label: "Import CSV into this table",
              icon: "⤓",
              separatorBefore: true,
              onSelect: () => onImport(menuTable.id),
            },
            { key: "export", label: "Export CSV", icon: "⤒", onSelect: () => onExport(menuTable.id) },
            {
              key: "copy",
              label: "Copy table ID",
              icon: "#",
              onSelect: () =>
                void copyText(menuTable.id).then((ok) => (ok ? toast.success(`Table ID copied: ${menuTable.id}`) : toast.info(menuTable.id))),
            },
            { key: "ids", label: "IDs & API…", icon: "{}", onSelect: () => setIdsFor(menuTable) },
            ...(menuTable.sync
              ? [
                  {
                    key: "sync-now",
                    label: "Sync now",
                    icon: "⇄",
                    separatorBefore: true,
                    onSelect: () => syncNow.mutate(menuTable.id),
                  },
                  {
                    key: "sync-pause",
                    label: menuTable.sync.status === "paused" ? "Resume syncing" : "Pause syncing",
                    icon: menuTable.sync.status === "paused" ? "▶" : "⏸",
                    onSelect: () => syncPause.mutate({ tableId: menuTable.id, status: menuTable.sync!.status === "paused" ? "active" : "paused" }),
                  },
                  {
                    key: "sync-stop",
                    label: "Stop syncing (make editable)",
                    icon: "✂",
                    onSelect: () => setStopSyncFor(menuTable),
                  },
                ]
              : []),
            {
              key: "delete",
              label: "Delete table",
              icon: "🗑",
              danger: true,
              separatorBefore: true,
              disabled: tables.length <= 1,
              onSelect: () => setDeleting(menuTable),
            },
          ]}
        />
      ) : null}

      {adding ? (
        <AddTableDialog
          baseId={baseId}
          defaultName={`Table ${tables.length + 1}`}
          initialMode={adding}
          onClose={() => setAdding(null)}
          onCreated={(tableId, importCsv) => {
            setAdding(null);
            onSelect(tableId);
            if (importCsv) onImport(tableId);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete table?"
          message={
            <>
              <strong>{deleting.name}</strong> and its records, fields and views will be moved to
              the trash. You can restore it from <em>Tools → Trash</em>.
            </>
          }
          confirmLabel="Delete table"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {stopSyncFor ? (
        <ConfirmDialog
          title="Stop syncing?"
          message={
            <>
              <strong>{stopSyncFor.name}</strong> keeps its current records but won’t receive changes from{" "}
              {stopSyncFor.sync?.sourceBaseName ?? "the source base"} any more. All of its fields become editable.
            </>
          }
          confirmLabel="Stop syncing"
          busy={stopSync.isPending}
          onConfirm={() => stopSync.mutate(stopSyncFor.id)}
          onClose={() => setStopSyncFor(null)}
        />
      ) : null}
      {idsFor ? <IdsDialog baseId={baseId} table={idsFor} onClose={() => setIdsFor(null)} /> : null}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.idRow}>
      <span className={styles.idLabel}>{label}</span>
      <code className={styles.idValue}>{value}</code>
      <button
        type="button"
        className={uiStyles.btn}
        onClick={() => void copyText(value).then((ok) => (ok ? toast.success(`${label} copied`) : toast.info(value)))}
      >
        Copy
      </button>
    </div>
  );
}

/** Base, table and field ids for the API, with a ready-to-run example. */
function IdsDialog({ baseId, table, onClose }: { baseId: string; table: TableDto; onClose: () => void }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const example = `curl -X POST "${origin}/v1/tables/${table.id}/records/query" \\\n  -H "Authorization: Bearer YOUR_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"pageSize": 50}'`;
  return (
    <Dialog
      title={`IDs & API — ${table.name}`}
      onClose={onClose}
      footer={
        <button type="button" className={uiStyles.btnPrimary} onClick={onClose}>
          Done
        </button>
      }
    >
      <p className={uiStyles.muted}>
        Every base, table, field and record has a permanent ID that is unique across all of TableOS. Renaming never changes it. Use these IDs with the API; owners create tokens in Members &amp; access → API tokens.
      </p>
      <CopyRow label="Base ID" value={baseId} />
      <CopyRow label="Table ID" value={table.id} />
      {table.sync ? (
        <p className={uiStyles.muted}>
          Synced from {table.sync.sourceBaseName} › {table.sync.sourceTableName} (source table ID {table.sync.sourceTableId}).
        </p>
      ) : null}
      <div className={uiStyles.label}>Field IDs</div>
      <div className={styles.idList}>
        {table.fields.map((f) => (
          <CopyRow key={f.id} label={f.name} value={f.id} />
        ))}
      </div>
      <div className={uiStyles.label}>Example: list records by table ID</div>
      <pre className={styles.idCode}>{example}</pre>
      <a className={styles.idLink} href="/help/api" target="_blank" rel="noreferrer">
        Full API reference →
      </a>
    </Dialog>
  );
}
