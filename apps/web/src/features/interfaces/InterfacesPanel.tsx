import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, Dialog, DropdownMenu, PromptDialog } from "../../app/ui.tsx";
import { toast } from "../../app/toast.tsx";
import { ApiProblemError, type TableDto } from "../../lib/api.ts";
import {
  interfacesApi,
  type Diagnostic,
  type ElementType,
  type InterfaceDto,
  type InterfaceElement,
  type InterfacePage,
  type PageLayout,
} from "../../lib/api-areas/interfaces.ts";
import { useBaseDetail, useBaseRole } from "../grid/field-services.tsx";
import { ELEMENT_LABEL, ELEMENT_PALETTE, TEMPLATES, makeElement, packLayout, templateLayout, type TemplateId } from "./element-defaults.ts";
import { ElementView, errorText, type RenderCtx } from "./Elements.tsx";
import { Inspector } from "./Inspector.tsx";
import styles from "./interfaces.module.css";

type Mode = "edit" | "preview" | "published";

const lastKey = (baseId: string) => `tableos.interfaces.last.${baseId}`;

function statusLabel(i: InterfaceDto): { text: string; tone: "draft" | "live" | "changed" } {
  if (i.status !== "published") return { text: i.status === "unpublished" ? "Unpublished" : "Draft", tone: "draft" };
  if (i.hasUnpublishedChanges) return { text: "Unpublished changes", tone: "changed" };
  return { text: `Published · v${i.publishedVersionNo ?? "?"}`, tone: "live" };
}

export function InterfacesPanel({ baseId }: { baseId: string }) {
  const qc = useQueryClient();
  const base = useBaseDetail(baseId);
  const tables = base.data?.tables ?? [];
  const { role } = useBaseRole(baseId);
  const canWrite = role === undefined || role === "owner" || role === "creator" || role === "editor";

  const list = useQuery({ queryKey: ["interfaces", baseId], queryFn: () => interfacesApi.list(baseId) });
  const interfaces = list.data?.interfaces ?? [];
  const canBuild = list.data?.canBuild ?? false;

  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(lastKey(baseId)));
  useEffect(() => {
    if (!list.data) return;
    if (!activeId || !interfaces.some((i) => i.id === activeId)) setActiveId(interfaces[0]?.id ?? null);
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeId) localStorage.setItem(lastKey(baseId), activeId);
  }, [activeId, baseId]);

  const [creating, setCreating] = useState(false);
  const active = interfaces.find((i) => i.id === activeId) ?? null;

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label="Interfaces">
        <div className={styles.sidebarHead}>
          <h2 className={styles.sidebarTitle}>Interfaces</h2>
          {canBuild ? (
            <button type="button" className={styles.primaryBtn} onClick={() => setCreating(true)}>
              + New
            </button>
          ) : null}
        </div>
        {list.isLoading ? <p className={styles.muted}>Loading…</p> : null}
        {list.isError ? <div className={styles.elementProblem}>Couldn’t load interfaces. {errorText(list.error)}</div> : null}
        <ul className={styles.list}>
          {interfaces.map((i) => {
            const s = statusLabel(i);
            return (
              <li key={i.id}>
                <button
                  type="button"
                  className={styles.listItem}
                  data-active={i.id === activeId || undefined}
                  aria-current={i.id === activeId ? "page" : undefined}
                  onClick={() => setActiveId(i.id)}
                >
                  <span className={styles.listIcon} aria-hidden>
                    {i.icon || "◧"}
                  </span>
                  <span className={styles.listText}>
                    <span className={styles.listName}>{i.name}</span>
                    <span className={styles.listMeta}>
                      <span className={styles.badge} data-tone={s.tone}>
                        {s.text}
                      </span>
                      {i.pageCount} page{i.pageCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {list.data && interfaces.length === 0 ? (
          <p className={styles.muted}>
            {canBuild ? "Interfaces turn your tables into dashboards, review queues and forms." : "No interfaces have been published in this base yet."}
          </p>
        ) : null}
      </aside>

      {active ? (
        <InterfaceWorkspace
          key={active.id}
          baseId={baseId}
          itf={active}
          tables={tables}
          canBuild={canBuild}
          canWrite={canWrite}
          onDeleted={() => {
            setActiveId(null);
            void qc.invalidateQueries({ queryKey: ["interfaces", baseId] });
          }}
        />
      ) : (
        <main className={styles.emptyMain}>
          {list.data ? (
            <div className={styles.emptyCard}>
              <div className={styles.emptyIcon} aria-hidden>
                ◧
              </div>
              <h3>Build an interface</h3>
              <p className={styles.muted}>
                Give teammates a focused page on top of your data: numbers and charts, a list to review records, or a form to collect new ones.
              </p>
              {canBuild ? (
                <button type="button" className={styles.primaryBtn} onClick={() => setCreating(true)}>
                  Create an interface
                </button>
              ) : null}
            </div>
          ) : null}
        </main>
      )}

      {creating ? (
        <CreateDialog
          title="New interface"
          tables={tables}
          withName
          onClose={() => setCreating(false)}
          onCreate={async ({ name, template, table }) => {
            const kind = TEMPLATES.find((t) => t.id === template)!.kind;
            const res = await interfacesApi.create(baseId, {
              name,
              pages: [{ name: template === "blank" ? "Page 1" : TEMPLATES.find((t) => t.id === template)!.label, kind, layout: templateLayout(template, table) }],
            });
            await qc.invalidateQueries({ queryKey: ["interfaces", baseId] });
            setActiveId(res.interface.id);
            setCreating(false);
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CreateDialog({
  title,
  tables,
  withName,
  onClose,
  onCreate,
}: {
  title: string;
  tables: TableDto[];
  withName?: boolean;
  onClose: () => void;
  onCreate: (v: { name: string; template: TemplateId; table: TableDto | undefined }) => Promise<void>;
}) {
  const [name, setName] = useState(withName ? "Untitled interface" : "New page");
  const [template, setTemplate] = useState<TemplateId>(tables.length ? "dashboard" : "blank");
  const [tableId, setTableId] = useState(tables[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), template, table: tables.find((t) => t.id === tableId) });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.primaryBtn} disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <form
        className={styles.createForm}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={styles.inspLabel} htmlFor="itf-name">
          Name
        </label>
        <input id="itf-name" className={styles.input} autoFocus value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
        <fieldset className={styles.templateSet}>
          <legend className={styles.inspLabel}>Start with</legend>
          {TEMPLATES.map((t) => (
            <label key={t.id} className={styles.templateOption} data-active={template === t.id || undefined}>
              <input
                type="radio"
                name="itf-template"
                value={t.id}
                checked={template === t.id}
                disabled={t.id !== "blank" && tables.length === 0}
                onChange={() => setTemplate(t.id)}
              />
              <span>
                <span className={styles.templateName}>{t.label}</span>
                <span className={styles.muted}>{t.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {template !== "blank" ? (
          <>
            <label className={styles.inspLabel} htmlFor="itf-table">
              Using records from
            </label>
            <select id="itf-table" className={styles.input} value={tableId} onChange={(e) => setTableId(e.target.value)}>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {error ? <div className={styles.elementProblem}>{error}</div> : null}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

function InterfaceWorkspace({
  baseId,
  itf,
  tables,
  canBuild,
  canWrite,
  onDeleted,
}: {
  baseId: string;
  itf: InterfaceDto;
  tables: TableDto[];
  canBuild: boolean;
  canWrite: boolean;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>(canBuild ? "edit" : "published");
  const effectiveMode: Mode = canBuild ? mode : "published";
  const draft = effectiveMode !== "published";

  const detail = useQuery({
    queryKey: ["interface", baseId, itf.id],
    queryFn: () => interfacesApi.get(baseId, itf.id),
    enabled: canBuild,
  });
  const runtime = useQuery({
    queryKey: ["interface-runtime", baseId, itf.id, itf.publishedVersionNo],
    queryFn: () => interfacesApi.runtime(baseId, itf.id),
    enabled: effectiveMode === "published" && itf.status === "published",
    retry: false,
  });

  const serverPages: InterfacePage[] = (draft ? detail.data?.pages : runtime.data?.pages) ?? [];
  const [pageId, setPageId] = useState<string | null>(null);
  useEffect(() => {
    if (serverPages.length && (!pageId || !serverPages.some((p) => p.id === pageId))) setPageId(serverPages[0]!.id);
  }, [serverPages, pageId]);
  const serverPage = serverPages.find((p) => p.id === pageId);

  /* ---- local draft of the active page + debounced autosave ---- */
  const [loaded, setLoaded] = useState<{ pageId: string; draft: boolean; layout: PageLayout } | null>(null);
  const layout = loaded && loaded.pageId === pageId && loaded.draft === draft ? loaded.layout : null;
  /** Last known server revision per page, for optimistic-concurrency saves. */
  const revisions = useRef<Record<string, number>>({});
  const loadedKey = useRef("");
  const currentPage = useRef<string | null>(null);
  currentPage.current = pageId;
  const [token, setToken] = useState<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<{ pageId: string; layout: PageLayout } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");

  useEffect(() => {
    if (!serverPage) {
      setLoaded(null);
      loadedKey.current = "";
      return;
    }
    if (pendingSave.current?.pageId === serverPage.id) return;
    const key = `${draft ? "draft" : `v${runtime.data?.versionNo ?? 0}`}:${serverPage.id}`;
    const rev = serverPage.pageRevision ?? 0;
    if (loadedKey.current !== key || (draft && revisions.current[serverPage.id] !== rev)) {
      loadedKey.current = key;
      if (draft) revisions.current[serverPage.id] = rev;
      setLoaded({ pageId: serverPage.id, draft, layout: serverPage.layout });
      setToken(draft ? `${serverPage.id}:${rev}` : key);
    }
  }, [serverPage?.id, serverPage?.pageRevision, draft, runtime.data?.versionNo]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const p = pendingSave.current;
    if (!p) return;
    setSaveState("saving");
    try {
      const res = await interfacesApi.patchPage(baseId, itf.id, p.pageId, {
        layout: { ...p.layout, elements: packLayout(p.layout.elements) },
        expectedRevision: revisions.current[p.pageId] ?? 0,
      });
      if (pendingSave.current === p) pendingSave.current = null;
      const rev = res.page.pageRevision ?? (revisions.current[p.pageId] ?? 0) + 1;
      revisions.current[p.pageId] = rev;
      if (currentPage.current === p.pageId) setToken(`${p.pageId}:${rev}`);
      qc.setQueryData<{ canBuild: boolean; interface: InterfaceDto; pages: InterfacePage[] }>(["interface", baseId, itf.id], (old) =>
        old ? { ...old, pages: old.pages.map((x) => (x.id === res.page.id ? { ...x, ...res.page } : x)) } : old,
      );
      void qc.invalidateQueries({ queryKey: ["interfaces", baseId] });
      setSaveState("saved");
      if (pendingSave.current) void flush();
    } catch (err) {
      setSaveState("error");
      if (err instanceof ApiProblemError && (err.problem.code as string) === "PAGE_REVISION_CONFLICT") {
        pendingSave.current = null;
        toast.error("Someone else changed this page. Showing the latest version.");
        revisions.current[p.pageId] = -1;
        void qc.invalidateQueries({ queryKey: ["interface", baseId, itf.id] });
      } else {
        toast.error(`Couldn't save the page: ${errorText(err)}`);
      }
    }
  }, [baseId, itf.id, qc]);

  useEffect(() => () => void flush(), [pageId, flush]);

  const edit = (next: PageLayout) => {
    if (!pageId) return;
    setLoaded({ pageId, draft: true, layout: next });
    pendingSave.current = { pageId, layout: next };
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 700);
  };

  /* ---- element editing ---- */
  const [selectedEl, setSelectedEl] = useState<string | null>(null);
  const [paletteTable, setPaletteTable] = useState<string>(tables[0]?.id ?? "");
  useEffect(() => {
    if (!paletteTable && tables[0]) setPaletteTable(tables[0].id);
  }, [tables, paletteTable]);
  const elements = layout?.elements ?? [];
  const setElements = (els: InterfaceElement[]) => layout && edit({ ...layout, elements: els });
  const addElement = (type: ElementType) => {
    const el = makeElement(type, tables.find((t) => t.id === paletteTable), elements);
    if (!el) {
      toast.error(type === "record_detail" ? "Add a grid, list or gallery first — details show the record selected there." : "Pick a table first.");
      return;
    }
    setElements([...elements, el]);
    setSelectedEl(el.id);
  };
  const moveEl = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= elements.length) return;
    const next = [...elements];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setElements(next);
  };
  const removeEl = (id: string) => {
    setElements(elements.filter((e) => e.id !== id));
    if (selectedEl === id) setSelectedEl(null);
  };

  /* ---- runtime context ---- */
  const [selections, setSelections] = useState<Record<string, string>>({});
  useEffect(() => setSelections({}), [pageId]);
  const ctx: RenderCtx = useMemo(
    () => ({
      baseId,
      interfaceId: itf.id,
      pageId: pageId ?? "",
      draft,
      token,
      tables,
      pages: serverPages,
      elements,
      selections,
      select: (elementId, recordId) =>
        setSelections((s) => {
          const next = { ...s };
          if (recordId) next[elementId] = recordId;
          else delete next[elementId];
          return next;
        }),
      navigate: (id) => setPageId(id),
      editing: effectiveMode === "edit",
      canWrite,
    }),
    [baseId, itf.id, pageId, draft, token, tables, serverPages, elements, selections, effectiveMode, canWrite],
  );

  /* ---- interface-level actions ---- */
  const [publishing, setPublishing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [renaming, setRenaming] = useState<"interface" | "page" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<"interface" | "page" | null>(null);
  const [addingPage, setAddingPage] = useState(false);

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["interfaces", baseId] });
    void qc.invalidateQueries({ queryKey: ["interface", baseId, itf.id] });
  };

  const publish = async () => {
    await flush();
    setPublishing(true);
    try {
      const res = await interfacesApi.publish(baseId, itf.id);
      refreshAll();
      const warnings = res.diagnostics.filter((d) => d.severity === "warning");
      toast.success(`Published version ${res.versionNo}${warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}`);
      if (warnings.length) setDiagnostics(warnings);
    } catch (err) {
      const diags = err instanceof ApiProblemError ? (err.problem.meta?.diagnostics as Diagnostic[] | undefined) : undefined;
      if (diags?.length) setDiagnostics(diags);
      else toast.error(`Couldn't publish: ${errorText(err)}`);
    } finally {
      setPublishing(false);
    }
  };

  const status = statusLabel(itf);
  const selected = elements.find((e) => e.id === selectedEl) ?? null;
  const notPublishedYet = effectiveMode === "published" && itf.status !== "published";

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2 className={styles.itfName}>{itf.name}</h2>
          <span className={styles.badge} data-tone={status.tone}>
            {status.text}
          </span>
          {canBuild && effectiveMode === "edit" ? (
            <span className={styles.saveState} aria-live="polite">
              {saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "All changes saved"}
            </span>
          ) : null}
        </div>
        {canBuild ? (
          <div className={styles.headerActions}>
            <div className={styles.segmented} role="tablist" aria-label="Mode">
              {(["edit", "preview", "published"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  className={styles.segment}
                  data-active={mode === m || undefined}
                  onClick={() => {
                    void flush();
                    setMode(m);
                    setSelectedEl(null);
                  }}
                >
                  {m === "edit" ? "Edit" : m === "preview" ? "Preview" : "Published"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={publishing || (itf.status === "published" && !itf.hasUnpublishedChanges && saveState === "saved")}
              onClick={() => void publish()}
            >
              {publishing ? "Publishing…" : itf.status === "published" ? "Publish changes" : "Publish"}
            </button>
            <DropdownMenu
              align="right"
              trigger={({ toggle }) => (
                <button type="button" className={styles.iconBtn} aria-label="Interface options" onClick={toggle}>
                  ⋯
                </button>
              )}
              items={[
                { key: "rename", label: "Rename interface", onSelect: () => setRenaming("interface") },
                { key: "versions", label: "Version history", onSelect: () => setVersionsOpen(true) },
                ...(itf.status === "published"
                  ? [
                      {
                        key: "unpublish",
                        label: "Unpublish",
                        onSelect: () =>
                          void interfacesApi
                            .unpublish(baseId, itf.id)
                            .then(() => {
                              refreshAll();
                              toast.success("Interface unpublished");
                            })
                            .catch((err: unknown) => toast.error(errorText(err))),
                      },
                    ]
                  : []),
                { key: "delete", label: "Delete interface", danger: true, separatorBefore: true, onSelect: () => setConfirmDelete("interface") },
              ]}
            />
          </div>
        ) : null}
      </header>

      <nav className={styles.pageTabs} aria-label="Pages">
        {serverPages.map((p) => (
          <div key={p.id} className={styles.pageTab} data-active={p.id === pageId || undefined}>
            <button
              type="button"
              className={styles.pageTabBtn}
              aria-current={p.id === pageId ? "page" : undefined}
              onClick={() => {
                void flush();
                setPageId(p.id);
                setSelectedEl(null);
              }}
            >
              {p.name}
            </button>
            {canBuild && effectiveMode === "edit" && p.id === pageId ? (
              <DropdownMenu
                trigger={({ toggle }) => (
                  <button type="button" className={styles.pageTabMenu} aria-label={`${p.name} page options`} onClick={toggle}>
                    ▾
                  </button>
                )}
                items={[
                  { key: "rename", label: "Rename page", onSelect: () => setRenaming("page") },
                  {
                    key: "left",
                    label: "Move left",
                    disabled: serverPages[0]?.id === p.id,
                    onSelect: () => reorder(p.id, -1),
                  },
                  {
                    key: "right",
                    label: "Move right",
                    disabled: serverPages[serverPages.length - 1]?.id === p.id,
                    onSelect: () => reorder(p.id, 1),
                  },
                  { key: "delete", label: "Delete page", danger: true, separatorBefore: true, disabled: serverPages.length <= 1, onSelect: () => setConfirmDelete("page") },
                ]}
              />
            ) : null}
          </div>
        ))}
        {canBuild && effectiveMode === "edit" ? (
          <button type="button" className={styles.addPageBtn} onClick={() => setAddingPage(true)}>
            + Add page
          </button>
        ) : null}
      </nav>

      <div className={styles.body}>
        <div className={styles.canvasScroll}>
          {notPublishedYet ? (
            <div className={styles.emptyCard}>
              <h3>Not published yet</h3>
              <p className={styles.muted}>Publish this interface to make it available to everyone in the base.</p>
            </div>
          ) : (draft ? detail.isLoading : runtime.isLoading) ? (
            <p className={styles.muted}>Loading…</p>
          ) : (draft ? detail.isError : runtime.isError) ? (
            <div className={styles.elementProblem}>{errorText(draft ? detail.error : runtime.error)}</div>
          ) : layout ? (
            <div className={styles.canvas} data-mode={effectiveMode}>
              {elements.length === 0 ? (
                <div className={styles.emptyCanvas}>
                  {effectiveMode === "edit" ? "This page is empty. Add an element from the panel on the right." : "This page is empty."}
                </div>
              ) : null}
              {elements.map((el, i) => (
                <section
                  key={el.id}
                  className={styles.element}
                  style={{ gridColumn: `span ${Math.min(12, Math.max(1, el.layout.lg.w))}` }}
                  data-type={el.type}
                  data-selected={(effectiveMode === "edit" && selectedEl === el.id) || undefined}
                  aria-label={el.title || ELEMENT_LABEL[el.type]}
                  onClickCapture={effectiveMode === "edit" ? () => setSelectedEl(el.id) : undefined}
                >
                  {effectiveMode === "edit" ? (
                    <div className={styles.elementTools}>
                      <span className={styles.elementKind}>{ELEMENT_LABEL[el.type]}</span>
                      <button type="button" className={styles.miniBtn} aria-label="Move earlier" disabled={i === 0} onClick={() => moveEl(i, -1)}>
                        ←
                      </button>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        aria-label="Move later"
                        disabled={i === elements.length - 1}
                        onClick={() => moveEl(i, 1)}
                      >
                        →
                      </button>
                      <button type="button" className={styles.miniBtn} aria-label="Remove element" onClick={() => removeEl(el.id)}>
                        ×
                      </button>
                    </div>
                  ) : null}
                  {el.title && el.type !== "form" && el.type !== "button" ? <h3 className={styles.elementTitle}>{el.title}</h3> : null}
                  <ElementView el={el} ctx={ctx} />
                </section>
              ))}
            </div>
          ) : null}
        </div>

        {canBuild && effectiveMode === "edit" && layout ? (
          <aside className={styles.rightPanel}>
            {selected ? (
              <Inspector
                key={selected.id}
                baseId={baseId}
                el={selected}
                tables={tables}
                elements={elements}
                pages={serverPages}
                currentPageId={pageId ?? ""}
                onChange={(next) => setElements(elements.map((e) => (e.id === next.id ? next : e)))}
                onRemove={() => removeEl(selected.id)}
                onClose={() => setSelectedEl(null)}
              />
            ) : (
              <div className={styles.palette}>
                <div className={styles.inspTitle}>Add an element</div>
                {tables.length > 1 ? (
                  <label className={styles.inspRow}>
                    <span className={styles.inspLabel}>Using records from</span>
                    <select className={styles.input} value={paletteTable} onChange={(e) => setPaletteTable(e.target.value)}>
                      {tables.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className={styles.paletteGrid}>
                  {ELEMENT_PALETTE.map((p) => (
                    <button key={p.type} type="button" className={styles.paletteItem} onClick={() => addElement(p.type)} title={p.hint}>
                      <span className={styles.paletteIcon} aria-hidden>
                        {p.icon}
                      </span>
                      <span className={styles.paletteText}>
                        <span className={styles.paletteName}>{p.label}</span>
                        <span className={styles.paletteHint}>{p.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className={styles.inspHint}>Click an element on the page to change its data, fields and filters.</p>
              </div>
            )}
          </aside>
        ) : null}
      </div>

      {addingPage ? (
        <CreateDialog
          title="Add a page"
          tables={tables}
          onClose={() => setAddingPage(false)}
          onCreate={async ({ name, template, table }) => {
            const res = await interfacesApi.createPage(baseId, itf.id, {
              name,
              kind: TEMPLATES.find((t) => t.id === template)!.kind,
              layout: templateLayout(template, table),
            });
            await qc.invalidateQueries({ queryKey: ["interface", baseId, itf.id] });
            void qc.invalidateQueries({ queryKey: ["interfaces", baseId] });
            setPageId(res.page.id);
            setAddingPage(false);
          }}
        />
      ) : null}

      {renaming ? (
        <PromptDialog
          title={renaming === "interface" ? "Rename interface" : "Rename page"}
          label="Name"
          initialValue={renaming === "interface" ? itf.name : (serverPage?.name ?? "")}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => {
            const done = () => {
              setRenaming(null);
              refreshAll();
            };
            const p =
              renaming === "interface"
                ? interfacesApi.patch(baseId, itf.id, { name })
                : interfacesApi
                    .patchPage(baseId, itf.id, pageId!, { name, expectedRevision: revisions.current[pageId!] ?? 0 })
                    .then((r) => {
                      if (r.page.pageRevision !== undefined) revisions.current[r.page.id] = r.page.pageRevision;
                    });
            void p.then(done).catch((err: unknown) => toast.error(errorText(err)));
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={confirmDelete === "interface" ? `Delete “${itf.name}”?` : `Delete “${serverPage?.name}”?`}
          message={
            confirmDelete === "interface"
              ? "The interface and all its pages will be removed for everyone. Your table data isn't affected."
              : "This page will be removed from the draft. Publish to remove it for everyone."
          }
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            const which = confirmDelete;
            setConfirmDelete(null);
            if (which === "interface") {
              void interfacesApi
                .remove(baseId, itf.id)
                .then(() => {
                  toast.success("Interface deleted");
                  onDeleted();
                })
                .catch((err: unknown) => toast.error(errorText(err)));
            } else if (pageId) {
              pendingSave.current = null;
              void interfacesApi
                .removePage(baseId, itf.id, pageId)
                .then(() => {
                  setPageId(null);
                  refreshAll();
                })
                .catch((err: unknown) => toast.error(errorText(err)));
            }
          }}
        />
      ) : null}

      {diagnostics ? (
        <Dialog title={diagnostics.some((d) => d.severity === "error") ? "Fix these before publishing" : "Published with warnings"} onClose={() => setDiagnostics(null)}>
          <ul className={styles.diagList}>
            {diagnostics.map((d, i) => {
              const page = detail.data?.pages.find((p) => p.id === d.pageId);
              return (
                <li key={i} data-severity={d.severity}>
                  <strong>{d.severity === "error" ? "Error" : "Warning"}</strong>
                  {page ? ` · ${page.name}` : ""}: {d.message}
                </li>
              );
            })}
          </ul>
        </Dialog>
      ) : null}

      {versionsOpen ? (
        <VersionsDialog
          baseId={baseId}
          itf={itf}
          onClose={() => setVersionsOpen(false)}
          onReverted={() => {
            pendingSave.current = null;
            revisions.current = {};
            refreshAll();
            setMode("edit");
          }}
        />
      ) : null}
    </main>
  );

  function reorder(id: string, d: -1 | 1) {
    const ids = serverPages.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void interfacesApi
      .reorderPages(baseId, itf.id, ids)
      .then(refreshAll)
      .catch((err: unknown) => toast.error(errorText(err)));
  }
}

function VersionsDialog({ baseId, itf, onClose, onReverted }: { baseId: string; itf: InterfaceDto; onClose: () => void; onReverted: () => void }) {
  const q = useQuery({ queryKey: ["interface-versions", baseId, itf.id], queryFn: () => interfacesApi.versions(baseId, itf.id) });
  const [busy, setBusy] = useState<number | null>(null);
  return (
    <Dialog title="Version history" onClose={onClose}>
      {q.isLoading ? <p className={styles.muted}>Loading…</p> : null}
      {q.isError ? <div className={styles.elementProblem}>{errorText(q.error)}</div> : null}
      {q.data && q.data.versions.length === 0 ? <p className={styles.muted}>Nothing has been published yet.</p> : null}
      <ul className={styles.versionList}>
        {q.data?.versions.map((v) => (
          <li key={v.versionNo}>
            <span className={styles.versionText}>
              <strong>Version {v.versionNo}</strong>
              {v.current ? <span className={styles.badge} data-tone="live">Live</span> : null}
              <span className={styles.muted}>
                {new Date(v.publishedAt).toLocaleString()}
                {v.publishedBy ? ` · ${v.publishedBy}` : ""}
              </span>
            </span>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={busy !== null}
              onClick={() => {
                setBusy(v.versionNo);
                void interfacesApi
                  .revert(baseId, itf.id, v.versionNo)
                  .then(() => {
                    toast.success(`Draft restored from version ${v.versionNo}. Publish to make it live.`);
                    onReverted();
                    onClose();
                  })
                  .catch((err: unknown) => toast.error(errorText(err)))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === v.versionNo ? "Restoring…" : "Restore to draft"}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
