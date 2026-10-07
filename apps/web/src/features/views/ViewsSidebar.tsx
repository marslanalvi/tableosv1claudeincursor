import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewDto } from "../../lib/api.ts";
import { viewsApi, type ViewVisibility, type ViewWire } from "../../lib/api-areas/views.ts";
import { toast } from "../../app/toast.tsx";
import { useBaseRole } from "../grid/field-services.tsx";
import { VIEW_CREATE_OPTIONS, type ViewKind } from "./view-types.ts";
import { patchViewInCaches, setViewsInCaches } from "./view-utils.ts";
import styles from "./views-sidebar.module.css";

function viewMeta(type: string | undefined) {
  return VIEW_CREATE_OPTIONS.find((o) => o.id === type) ?? VIEW_CREATE_OPTIONS[0]!;
}

function uniqueName(base: string, views: ViewDto[]): string {
  const names = new Set(views.map((v) => v.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i += 1) {
    const n = `${base} ${i}`;
    if (!names.has(n.toLowerCase())) return n;
  }
}

/** Airtable-style default name: "Kanban", then "Kanban 2"…; "Grid view" counts as "Grid". */
export function defaultViewName(label: string, views: { name: string }[]): string {
  const names = new Set(views.map((v) => v.name.trim().toLowerCase()));
  const l = label.toLowerCase();
  if (!names.has(l) && !names.has(`${l} view`)) return label;
  for (let i = 2; ; i += 1) {
    if (!names.has(`${l} ${i}`) && !names.has(`${l} view ${i}`)) return `${label} ${i}`;
  }
}

const CREATE_OPEN_KEY = "tableos.views.createOpen";

function readCreateOpen(): boolean {
  try {
    return localStorage.getItem(CREATE_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeCreateOpen(open: boolean): void {
  try {
    localStorage.setItem(CREATE_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

type Section = "favorites" | "personal" | "collaborative";
type NewVisibility = "personal" | "collaborative";

export function ViewsSidebar({
  views: viewsProp,
  activeViewId,
  onSelectView,
  onCreateView,
  baseId: baseIdProp,
  tableId: tableIdProp,
}: {
  views: ViewDto[];
  activeViewId: string | null;
  onSelectView: (viewId: string) => void;
  /**
   * Create the view and select it. Return the create promise (resolving to
   * `{view}`) so the sidebar can show failures and put the new view into
   * rename mode.
   */
  onCreateView: (
    type: ViewKind,
    visibility: NewVisibility,
    name?: string,
  ) => void | Promise<unknown>;
  /** Kept for compatibility; favorites are handled here. */
  onToggleFavorite?: (view: ViewDto) => void;
  onJumpToOriginal?: (view: ViewDto) => void;
  baseId?: string;
  tableId?: string;
}) {
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { baseId?: string };
  const baseId = baseIdProp ?? params.baseId ?? "";
  const views = viewsProp as ViewWire[];
  const tableId = tableIdProp ?? views.find((v) => v.tableId)?.tableId ?? "";

  const { role } = useBaseRole(baseId);
  // Until the role loads, assume the common case (editor+); the server has the final say.
  const canCreateShared = role === undefined || role === "owner" || role === "creator" || role === "editor";
  const canCreatePersonal = role !== "viewer";

  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(() => readCreateOpen());
  const focusCreateRef = useRef(false);
  const [newVisibility, setNewVisibility] = useState<NewVisibility>("collaborative");
  const [creating, setCreating] = useState<ViewKind | null>(null);
  const [menuViewId, setMenuViewId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [sectionsOpen, setSectionsOpen] = useState<Record<Section, boolean>>({
    favorites: true,
    personal: true,
    collaborative: true,
  });
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const createBtnRef = useRef<HTMLButtonElement | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the view options menu on outside click / Escape.
  useEffect(() => {
    if (!menuViewId) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuViewId(null);
        setConfirmDeleteId(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setMenuViewId(null);
      setConfirmDeleteId(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuViewId]);

  useEffect(() => {
    if (!createOpen || !focusCreateRef.current) return;
    focusCreateRef.current = false;
    const first = createMenuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)");
    first?.scrollIntoView({ block: "nearest" });
    first?.focus();
  }, [createOpen]);

  const setError = (err: unknown) => toast.error(err);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["views", baseId, tableId] });
    void qc.invalidateQueries({ queryKey: ["bases", baseId] });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return views;
    return views.filter((v) => v.name.toLowerCase().includes(q));
  }, [views, query]);

  const favorites = filtered.filter((v) => v.isFavorite);
  const personal = filtered.filter((v) => v.visibility === "personal");
  const collaborative = filtered.filter((v) => v.visibility !== "personal");

  /* ---------------- actions ---------------- */

  async function toggleFavorite(view: ViewWire) {
    const on = !view.isFavorite;
    patchViewInCaches(qc, baseId, tableId, view.id, (v) => ({ ...v, isFavorite: on }));
    try {
      await viewsApi.favorite(baseId, tableId, view.id, on);
    } catch (err) {
      setError(err);
      refresh();
    }
  }

  async function rename(view: ViewWire, name: string) {
    const trimmed = name.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === view.name) return;
    patchViewInCaches(qc, baseId, tableId, view.id, (v) => ({ ...v, name: trimmed }));
    try {
      await viewsApi.patch(baseId, tableId, view.id, { name: trimmed });
    } catch (err) {
      setError(err);
      refresh();
    }
  }

  async function setVisibility(view: ViewWire, visibility: ViewVisibility) {
    try {
      const res = await viewsApi.patch(baseId, tableId, view.id, { visibility });
      patchViewInCaches(qc, baseId, tableId, view.id, () => res.view);
      refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function duplicate(view: ViewWire) {
    try {
      const res = await viewsApi.duplicate(baseId, tableId, view.id, uniqueName(`${view.name} copy`, views));
      setViewsInCaches(qc, baseId, tableId, (list) => {
        const i = list.findIndex((v) => v.id === view.id);
        const next = [...list];
        next.splice(i + 1, 0, res.view);
        return next;
      });
      onSelectView(res.view.id);
      refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function remove(view: ViewWire) {
    setConfirmDeleteId(null);
    setMenuViewId(null);
    try {
      await viewsApi.remove(baseId, tableId, view.id);
      const rest = views.filter((v) => v.id !== view.id);
      setViewsInCaches(qc, baseId, tableId, (list) => list.filter((v) => v.id !== view.id));
      if (view.id === activeViewId && rest[0]) onSelectView(rest[0].id);
      refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function reorder(dragId: string, overId: string) {
    if (dragId === overId) return;
    const ids = views.map((v) => v.id);
    const from = ids.indexOf(dragId);
    ids.splice(from, 1);
    const to = ids.indexOf(overId);
    ids.splice(from <= to ? to + 1 : to, 0, dragId);
    const byId = new Map(views.map((v) => [v.id, v]));
    setViewsInCaches(qc, baseId, tableId, () => ids.map((id) => byId.get(id)!).filter(Boolean));
    try {
      await viewsApi.reorder(baseId, tableId, ids);
    } catch (err) {
      setError(err);
      refresh();
    }
  }

  function jumpToOriginal(view: ViewWire) {
    const section: Section = view.visibility === "personal" ? "personal" : "collaborative";
    setSectionsOpen((s) => ({ ...s, [section]: true }));
    setQuery("");
    onSelectView(view.id);
    setFlashId(view.id);
    window.setTimeout(() => {
      document
        .querySelector(`[data-view-row="${section}-${view.id}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 30);
    window.setTimeout(() => setFlashId(null), 1600);
  }

  function setCreateSection(open: boolean, focus = open) {
    if (open && !createOpen) setNewVisibility(canCreateShared ? "collaborative" : "personal");
    focusCreateRef.current = focus;
    setCreateOpen(open);
    writeCreateOpen(open);
    if (open && createOpen && focus) {
      createMenuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    }
  }

  function openCreate() {
    setCreateSection(!createOpen);
  }

  /** Airtable: picking a type creates the view at once, selects it and starts renaming it. */
  async function createView(type: ViewKind) {
    if (creating) return;
    const visibility: NewVisibility = canCreateShared ? newVisibility : "personal";
    const name = defaultViewName(viewMeta(type).label, views);
    setCreating(type);
    try {
      const res = (await onCreateView(type, visibility, name)) as { view?: ViewWire } | undefined;
      const created = res?.view;
      if (created) {
        const section: Section = created.visibility === "personal" ? "personal" : "collaborative";
        setSectionsOpen((s) => ({ ...s, [section]: true }));
        setQuery("");
        setRenameText(created.name);
        setRenamingId(created.id);
        window.setTimeout(() => {
          document
            .querySelector(`[data-view-row="${section}-${created.id}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }, 30);
      }
    } catch (err) {
      toast.error(err, "Could not create the view");
    } finally {
      setCreating(null);
    }
  }

  /* ---------------- render ---------------- */

  function renderViewRow(view: ViewWire, section: Section) {
    const active = view.id === activeViewId;
    const meta = viewMeta(view.type);
    const canEdit = view.canEdit !== false;
    const canLock = view.isMine || canEdit;
    const draggable = section !== "favorites" && !query && renamingId !== view.id;
    const isOver = drag?.over === view.id && drag.id !== view.id;
    return (
      <div
        key={`${section}-${view.id}`}
        data-view-row={`${section}-${view.id}`}
        className={[
          styles.viewItem,
          active ? styles.viewItemActive : "",
          flashId === view.id && section !== "favorites" ? styles.viewItemFlash : "",
          isOver ? styles.viewItemDropTarget : "",
        ].join(" ")}
        draggable={draggable}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", view.id);
          setDrag({ id: view.id, over: null });
        }}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          if (drag.over !== view.id) setDrag({ ...drag, over: view.id });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (drag) void reorder(drag.id, view.id);
          setDrag(null);
        }}
        onDragEnd={() => setDrag(null)}
      >
        {renamingId === view.id ? (
          <input
            className={styles.renameInput}
            autoFocus
            aria-label="View name"
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => void rename(view, renameText)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename(view, renameText);
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenamingId(null);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className={styles.viewBtn}
            onClick={() => onSelectView(view.id)}
            onDoubleClick={() => {
              if (!canEdit) return;
              setRenamingId(view.id);
              setRenameText(view.name);
            }}
            title={view.name}
          >
            <span className={styles.viewIcon} aria-hidden style={{ color: meta.color }}>
              {meta.icon}
            </span>
            <span className={styles.viewName}>{view.name}</span>
            {view.visibility === "locked" ? (
              <span className={styles.lockIcon} title="Locked view" aria-label="Locked">
                🔒
              </span>
            ) : null}
          </button>
        )}
        <button
          type="button"
          className={styles.moreBtn}
          aria-label={`Options for ${view.name}`}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDeleteId(null);
            setMenuViewId(menuViewId === `${section}-${view.id}` ? null : `${section}-${view.id}`);
          }}
        >
          ⋯
        </button>
        {menuViewId === `${section}-${view.id}` ? (
          <div className={styles.menu} role="menu" ref={menuRef}>
            {confirmDeleteId === view.id ? (
              <div className={styles.confirm}>
                <p>
                  Delete <strong>{view.name}</strong>? This can't be undone.
                </p>
                <div className={styles.confirmActions}>
                  <button type="button" className={styles.cancelBtn} onClick={() => setConfirmDeleteId(null)}>
                    Cancel
                  </button>
                  <button type="button" className={styles.dangerBtn} onClick={() => void remove(view)}>
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void toggleFavorite(view);
                    setMenuViewId(null);
                  }}
                >
                  {view.isFavorite ? "Remove from favorites" : "Add to favorites"}
                </button>
                {section === "favorites" ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      jumpToOriginal(view);
                      setMenuViewId(null);
                    }}
                  >
                    Jump to original
                  </button>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRenamingId(view.id);
                      setRenameText(view.name);
                      setMenuViewId(null);
                    }}
                  >
                    Rename view
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void duplicate(view);
                    setMenuViewId(null);
                  }}
                >
                  Duplicate view
                </button>
                {view.visibility !== "personal" && canLock ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!canEdit}
                    onClick={() => {
                      void setVisibility(view, view.visibility === "locked" ? "collaborative" : "locked");
                      setMenuViewId(null);
                    }}
                  >
                    {view.visibility === "locked" ? "Unlock view" : "Lock view"}
                  </button>
                ) : null}
                {view.isMine && canEdit ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      void setVisibility(view, view.visibility === "personal" ? "collaborative" : "personal");
                      setMenuViewId(null);
                    }}
                  >
                    {view.visibility === "personal" ? "Make collaborative" : "Make personal"}
                  </button>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.dangerItem}
                    onClick={() => setConfirmDeleteId(view.id)}
                  >
                    Delete view
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderSection(id: Section, title: string, list: ViewWire[], icon: string) {
    return (
      <section className={styles.section}>
        <button
          type="button"
          className={styles.sectionHead}
          aria-expanded={sectionsOpen[id]}
          onClick={() => setSectionsOpen((s) => ({ ...s, [id]: !s[id] }))}
        >
          <span className={styles.chev} data-open={sectionsOpen[id] ? "true" : "false"} aria-hidden>
            ▸
          </span>
          {icon ? <span className={styles.star}>{icon}</span> : null}
          {title}
          <span className={styles.sectionCount}>{list.length}</span>
        </button>
        {sectionsOpen[id]
          ? list.length
            ? list.map((v) => renderViewRow(v, id))
            : <p className={styles.emptyHint}>{id === "favorites" ? "Star a view to pin it here." : "No views"}</p>
          : null}
      </section>
    );
  }

  return (
    <aside className={styles.sidebar} aria-label="Views">
      <div className={styles.findRow}>
        <input
          className={styles.findInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a view"
          aria-label="Find a view"
        />
        <button
          type="button"
          className={styles.newViewBtn}
          aria-label="Create a new view"
          title={canCreatePersonal ? "Create a new view" : "Viewers can't create views"}
          disabled={!canCreatePersonal}
          onClick={() => setCreateSection(true)}
        >
          +
        </button>
      </div>

      <div className={styles.lists}>
        {favorites.length || !query ? renderSection("favorites", "My favorites", favorites, "★") : null}
        {renderSection("personal", "My personal views", personal, "")}
        {renderSection("collaborative", "Collaborative views", collaborative, "")}
      </div>
      <div className={styles.createWrap}>
        <button
          ref={createBtnRef}
          type="button"
          className={styles.createBtn}
          aria-expanded={createOpen}
          aria-controls="views-create-section"
          disabled={!canCreatePersonal}
          title={canCreatePersonal ? "Create a view" : "Viewers can't create views"}
          onClick={openCreate}
        >
          <span>Create…</span>
          <span aria-hidden>{createOpen ? "▾" : "▴"}</span>
        </button>
        {createOpen && canCreatePersonal ? (
          <div id="views-create-section" className={styles.createInline}>
            <div ref={createMenuRef}>
              <div className={styles.createHead}>
                <div className={styles.segmented} role="radiogroup" aria-label="Who can see the new view">
                  {(["collaborative", "personal"] as const).map((v) => {
                    const disabled = v === "collaborative" && !canCreateShared;
                    return (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={newVisibility === v}
                        disabled={disabled}
                        title={disabled ? "You need editor access to create collaborative views" : undefined}
                        className={styles.segment}
                        onClick={() => setNewVisibility(v)}
                      >
                        {v === "collaborative" ? "Collaborative" : "Personal"}
                      </button>
                    );
                  })}
                </div>
                <p className={styles.createHint}>
                  {newVisibility === "collaborative"
                    ? "Everyone in this base can see it."
                    : "Only you can see and edit it."}
                </p>
              </div>
              <div
                role="menu"
                aria-label="Create a view"
                className={styles.createList}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const items = Array.from(
                    e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"),
                  );
                  const i = items.indexOf(document.activeElement as HTMLButtonElement);
                  items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                }}
              >
                {VIEW_CREATE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitem"
                    className={styles.createItem}
                    disabled={creating !== null}
                    aria-busy={creating === opt.id}
                    onClick={() => void createView(opt.id)}
                  >
                    <span className={styles.createIcon} style={{ color: opt.color }}>
                      {opt.icon}
                    </span>
                    {opt.label}
                    <span className={styles.plus} aria-hidden>
                      {creating === opt.id ? "…" : "+"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
