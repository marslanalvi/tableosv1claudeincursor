import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiProblemError, type ViewDto } from "../lib/api.ts";
import { hiddenTableIdsOf, shellApi } from "../lib/api-areas/shell.ts";
import {
  BaseSessionProvider,
  useBaseSession,
} from "../features/base/BaseSessionProvider.tsx";
import { PresenceAvatars } from "../features/base/PresenceAvatars.tsx";
import { ToolsMenu } from "../features/base/ToolsMenu.tsx";
import { TableTabs } from "../features/base/TableTabs.tsx";
import { TrashDialog } from "../features/base/TrashDialog.tsx";
import { AccountMenu } from "../features/base/AccountMenu.tsx";
import { useUndoRedo } from "../features/base/useUndoRedo.ts";
import { NotificationsBell } from "../features/notifications/NotificationsBell.tsx";
import { ImportWizard } from "../features/import/ImportWizard.tsx";
import { ExportMenu } from "../features/import/ExportMenu.tsx";
import { ShareDialog } from "../features/share/ShareDialog.tsx";
import { defaultViewName, ViewsSidebar } from "../features/views/ViewsSidebar.tsx";
import { FormsIndex } from "../features/views/FormsIndex.tsx";
import { InterfacesPanel } from "../features/interfaces/InterfacesPanel.tsx";
import { FieldManager } from "../features/schema/FieldManager.tsx";
import { useBaseRole } from "../features/grid/field-services.tsx";
import { VIEW_CREATE_OPTIONS, type ViewKind } from "../features/views/view-types.ts";
import { setViewsInCaches } from "../features/views/view-utils.ts";
import { AutomationsPanel } from "../features/automations/AutomationsPanel.tsx";
import { ConfirmDialog, Dialog, DropdownMenu, PromptDialog, uiStyles } from "../app/ui.tsx";
import { toast, errorMessage } from "../app/toast.tsx";
import { baseColor } from "./home.tsx";
import { TableGridPage } from "./table-grid.tsx";
import styles from "./base.module.css";

type BaseTab = "data" | "automations" | "interfaces" | "forms";

function readSearchFlag(name: string): boolean {
  try {
    return new URL(window.location.href).searchParams.get(name) === "1";
  } catch {
    return false;
  }
}

/** Publishes the active table/view to realtime presence. */
function PresenceReporter({ tableId, viewId }: { tableId: string | null; viewId: string | null }) {
  const session = useBaseSession();
  useEffect(() => {
    session.setPresence({ tableId, viewId });
  }, [session, tableId, viewId]);
  return null;
}

function UndoRedoButtons({ baseId }: { baseId: string }) {
  const ur = useUndoRedo(baseId);
  const mod = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";
  return (
    <div className={styles.undoGroup}>
      <button
        type="button"
        className={styles.iconAction}
        disabled={ur.busy || !ur.canUndo}
        title={ur.undoLabel ? `Undo ${ur.undoLabel} (${mod}Z)` : `Undo (${mod}Z)`}
        aria-label="Undo"
        onClick={ur.undo}
      >
        ↶
      </button>
      <button
        type="button"
        className={styles.iconAction}
        disabled={ur.busy || !ur.canRedo}
        title={ur.redoLabel ? `Redo ${ur.redoLabel} (${mod}Shift+Z)` : `Redo (${mod}Shift+Z)`}
        aria-label="Redo"
        onClick={ur.redo}
      >
        ↷
      </button>
    </div>
  );
}

export function BasePage({ baseId }: { baseId: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const baseQuery = useQuery({
    queryKey: ["bases", baseId],
    queryFn: () => api.getBase(baseId),
  });

  const tables = baseQuery.data?.tables ?? [];
  const { role } = useBaseRole(baseId);
  const [baseTab, setBaseTab] = useState<BaseTab>("data");
  const [activeTableId, setActiveTableId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [importTableId, setImportTableId] = useState<string | null>(null);
  const [exportTableId, setExportTableId] = useState<string | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [baseDialog, setBaseDialog] = useState<"rename" | "delete" | null>(null);
  const [pendingImport, setPendingImport] = useState(() => readSearchFlag("import"));

  // `?table=tbl_…` (search results, notification links) selects the table.
  const tableParam = useRouterState({
    select: (s) => (s.location.search as Record<string, unknown>)["table"],
  });
  useEffect(() => {
    if (typeof tableParam !== "string") return;
    setActiveTableId(tableParam);
    setActiveViewId(null);
    setBaseTab("data");
  }, [tableParam]);

  const hiddenTableIds = hiddenTableIdsOf(baseQuery.data);
  const resolvedTableId =
    activeTableId && tables.some((t) => t.id === activeTableId)
      ? activeTableId
      : (tables.find((t) => !hiddenTableIds.includes(t.id))?.id ?? tables[0]?.id ?? null);
  const activeTable = tables.find((t) => t.id === resolvedTableId) ?? null;

  // "Create base → Import CSV" from the home page lands here with ?import=1.
  useEffect(() => {
    if (pendingImport && resolvedTableId) {
      setImportTableId(resolvedTableId);
      setPendingImport(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("import");
      window.history.replaceState(window.history.state, "", url);
    }
  }, [pendingImport, resolvedTableId]);

  useEffect(() => {
    if (baseQuery.data?.name) document.title = `${baseQuery.data.name} · TableOS`;
  }, [baseQuery.data?.name]);

  const viewsQuery = useQuery({
    queryKey: ["views", baseId, resolvedTableId],
    queryFn: () => api.listViews(baseId, resolvedTableId!),
    enabled: Boolean(resolvedTableId) && baseTab === "data",
  });

  const views: ViewDto[] = useMemo(() => {
    if (viewsQuery.data?.views?.length) return viewsQuery.data.views;
    return activeTable?.views ?? [];
  }, [viewsQuery.data, activeTable]);

  useEffect(() => {
    if (!views.length) {
      setActiveViewId(null);
      return;
    }
    if (!activeViewId || !views.some((v) => v.id === activeViewId)) {
      const fav = views.find((v) => v.isFavorite);
      setActiveViewId(fav?.id ?? views[0]?.id ?? null);
    }
  }, [views, activeViewId]);

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  const createViewMutation = useMutation({
    mutationFn: (args: {
      type: ViewKind;
      visibility: "personal" | "collaborative";
      name?: string;
    }) => {
      if (!resolvedTableId) throw new Error("No table");
      const label =
        args.type.charAt(0).toUpperCase() + args.type.slice(1).replace("_", " ");
      return api.createView(baseId, resolvedTableId, {
        name: args.name?.trim() || label,
        type: args.type,
        visibility: args.visibility,
      });
    },
    onSuccess: (res) => {
      if (resolvedTableId) {
        // Show the new view at once (the sidebar renames it inline), then refetch.
        setViewsInCaches(queryClient, baseId, resolvedTableId, (list) =>
          list.some((v) => v.id === res.view.id) ? list : [...list, res.view as (typeof list)[number]],
        );
      }
      setActiveViewId(res.view.id);
      void queryClient.invalidateQueries({ queryKey: ["views", baseId, resolvedTableId] });
      void queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
    },
  });

  const favoriteMutation = useMutation({
    mutationFn: async (view: ViewDto) => {
      if (!resolvedTableId) throw new Error("No table");
      if (view.isFavorite) {
        return api.unfavoriteView(baseId, resolvedTableId, view.id);
      }
      return api.favoriteView(baseId, resolvedTableId, view.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["views", baseId, resolvedTableId],
      });
      await queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
    },
  });

  const renameBase = useMutation({
    mutationFn: (name: string) => shellApi.renameBase(baseId, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setBaseDialog(null);
      toast.success("Base renamed");
    },
  });
  const duplicateBase = useMutation({
    mutationFn: () => shellApi.duplicateBase(baseId, { name: `${baseQuery.data?.name ?? "Base"} copy` }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success(`Created “${res.name}”`, {
        action: {
          label: "Open",
          onClick: () => void router.navigate({ to: "/bases/$baseId", params: { baseId: res.id } }),
        },
      });
    },
    onError: (err) => toast.error(err, "Could not duplicate base"),
  });
  const deleteBase = useMutation({
    mutationFn: () => shellApi.deleteBase(baseId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success("Base deleted");
      void router.navigate({ to: "/" });
    },
    onError: (err) => toast.error(err, "Could not delete base"),
  });

  // FieldManager only handles Escape while focus is inside it. Capture phase so
  // nested field/confirm dialogs are still in the DOM when we count them.
  useEffect(() => {
    if (!fieldsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length > 1) return;
      setFieldsOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fieldsOpen]);

  // Stable: BaseSessionProvider keeps it in a ref anyway.
  const onResync = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
    void queryClient.invalidateQueries({ queryKey: ["records", baseId] });
  }, [baseId, queryClient]);

  if (baseQuery.isLoading) {
    return <p className={styles.empty}>Loading base…</p>;
  }

  if (baseQuery.isError || !baseQuery.data) {
    const notFound =
      baseQuery.error instanceof ApiProblemError &&
      (baseQuery.error.problem.status === 404 || baseQuery.error.problem.status === 422);
    return (
      <div className={styles.errorState}>
        <h1>{notFound ? "Base not found" : "Could not load this base"}</h1>
        <p className={uiStyles.muted}>
          {notFound
            ? "It may have been deleted, or you don’t have access."
            : errorMessage(baseQuery.error)}
        </p>
        <Link to="/" className={uiStyles.btnPrimary}>
          Back to home
        </Link>
      </div>
    );
  }

  const base = baseQuery.data;
  const tableNames = Object.fromEntries(tables.map((t) => [t.id, t.name]));

  return (
    <BaseSessionProvider baseId={baseId} onResync={onResync}>
      <PresenceReporter
        tableId={baseTab === "data" ? resolvedTableId : null}
        viewId={baseTab === "data" ? (activeView?.id ?? null) : null}
      />
      <div className={styles.shell}>
        <header className={styles.topBar}>
          <div className={styles.brand}>
            <Link to="/" className={styles.homeLink} title="All bases" aria-label="Home">
              <span className={styles.logo} aria-hidden>
                T
              </span>
            </Link>
            <span
              className={styles.baseIcon}
              style={{ background: baseColor(baseId) }}
              aria-hidden
            />
            <DropdownMenu
              trigger={({ toggle, open }) => (
                <button
                  type="button"
                  className={styles.baseTitleBtn}
                  aria-expanded={open}
                  onClick={toggle}
                  title="Base options"
                >
                  <span className={styles.baseTitle}>{base.name}</span>
                  <span aria-hidden className={styles.caret}>
                    ▾
                  </span>
                </button>
              )}
              items={[
                { key: "rename", icon: "✎", label: "Rename base", onSelect: () => setBaseDialog("rename") },
                { key: "dup", icon: "⧉", label: "Duplicate base", onSelect: () => duplicateBase.mutate() },
                {
                  key: "copy",
                  icon: "#",
                  label: "Copy base ID",
                  onSelect: () =>
                    void navigator.clipboard
                      ?.writeText(baseId)
                      .then(() => toast.success("Base ID copied"))
                      .catch(() => toast.info(baseId)),
                },
                { key: "trash", icon: "🗑", label: "Trash", onSelect: () => setTrashOpen(true) },
                {
                  key: "delete",
                  icon: "⚠",
                  label: "Delete base",
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => setBaseDialog("delete"),
                },
              ]}
            />
          </div>

          <nav className={styles.navTabs} aria-label="Base sections">
            {(
              [
                ["data", "Data"],
                ["automations", "Automations"],
                ["interfaces", "Interfaces"],
                ["forms", "Forms"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={styles.navTab}
                data-active={baseTab === id}
                onClick={() => setBaseTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className={styles.topActions}>
            <PresenceAvatars tableNames={tableNames} />
            <UndoRedoButtons baseId={baseId} />
            <NotificationsBell />
            {activeTable ? (
              <button
                type="button"
                className={uiStyles.btnPrimary}
                style={{ height: 32 }}
                onClick={() => setShareOpen(true)}
              >
                Share
              </button>
            ) : null}
            <AccountMenu />
          </div>
        </header>

        {baseTab === "data" ? (
          <>
            <div className={styles.tableBar}>
              <TableTabs
                baseId={baseId}
                tables={tables}
                hiddenTableIds={hiddenTableIds}
                activeTableId={resolvedTableId}
                onSelect={(id) => {
                  setActiveTableId(id);
                  setActiveViewId(null);
                }}
                onImport={(id) => setImportTableId(id)}
                onExport={(id) => setExportTableId(id)}
              />
              <ToolsMenu
                disabled={!activeTable}
                onManageFields={() => setFieldsOpen(true)}
                onImport={() => resolvedTableId && setImportTableId(resolvedTableId)}
                onExport={() => resolvedTableId && setExportTableId(resolvedTableId)}
                onTrash={() => setTrashOpen(true)}
              />
            </div>

            <div className={styles.workspace}>
              {activeTable ? (
                <>
                  <ViewsSidebar
                    views={views}
                    activeViewId={activeView?.id ?? null}
                    onSelectView={setActiveViewId}
                    onCreateView={(type, visibility, name) =>
                      createViewMutation.mutateAsync({ type, visibility, ...(name ? { name } : {}) })
                    }
                    onToggleFavorite={(view) => favoriteMutation.mutate(view)}
                    onJumpToOriginal={(view) => setActiveViewId(view.id)}
                  />
                  <div className={styles.content}>
                    <TableGridPage
                      baseId={baseId}
                      table={activeTable}
                      {...(activeView ? { activeView } : {})}
                      onOpenShare={() => setShareOpen(true)}
                      views={views}
                      onSelectView={setActiveViewId}
                      onCreateView={(type) => {
                        const label = VIEW_CREATE_OPTIONS.find((o) => o.id === type)?.label ?? "View";
                        const shared = role === undefined || role === "owner" || role === "creator" || role === "editor";
                        createViewMutation.mutate(
                          { type, visibility: shared ? "collaborative" : "personal", name: defaultViewName(label, views) },
                          { onError: (err) => toast.error(err, "Could not create the view") },
                        );
                      }}
                      onOpenImport={() => setImportTableId(activeTable.id)}
                      onSchemaChange={() => {
                        void baseQuery.refetch();
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className={styles.errorState}>
                  <h1>This base has no tables</h1>
                  <p className={uiStyles.muted}>Use “+ Add or import” to create one.</p>
                </div>
              )}
            </div>
          </>
        ) : null}

        {baseTab === "automations" ? <AutomationsPanel baseId={baseId} /> : null}

        {baseTab === "interfaces" ? (
          <div className={styles.interfacesTab}>
            <InterfacesPanel baseId={baseId} />
          </div>
        ) : null}

        {baseTab === "forms" ? (
          <div className={styles.formsTab}>
            <FormsIndex
              baseId={baseId}
              onOpenForm={(tableId, viewId) => {
                setActiveTableId(tableId);
                setActiveViewId(viewId);
                setBaseTab("data");
              }}
            />
          </div>
        ) : null}
      </div>

      {shareOpen && activeTable ? (
        <ShareDialog
          baseId={baseId}
          tableId={activeTable.id}
          {...(activeView?.id ? { viewId: activeView.id } : {})}
          {...(activeView?.type ? { viewType: activeView.type } : {})}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
      {importTableId ? (
        <ImportWizard
          baseId={baseId}
          tableId={importTableId}
          onClose={() => setImportTableId(null)}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: ["records", baseId] });
            void queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
          }}
        />
      ) : null}
      {exportTableId ? (
        <Dialog title="Export" onClose={() => setExportTableId(null)}>
          <p className={uiStyles.muted} style={{ marginTop: 0 }}>
            Download <strong>{tableNames[exportTableId] ?? "this table"}</strong>
            {exportTableId === resolvedTableId && activeView ? ` (view “${activeView.name}”)` : ""}.
          </p>
          <ExportMenu
            baseId={baseId}
            tableId={exportTableId}
            inline
            onDone={() => setExportTableId(null)}
            {...(exportTableId === resolvedTableId && activeView?.id
              ? { viewId: activeView.id }
              : {})}
          />
        </Dialog>
      ) : null}
      {fieldsOpen && activeTable ? (
        <FieldManager
          baseId={baseId}
          table={activeTable}
          {...(activeView?.id ? { viewId: activeView.id } : {})}
          onClose={() => setFieldsOpen(false)}
        />
      ) : null}
      {trashOpen ? <TrashDialog baseId={baseId} onClose={() => setTrashOpen(false)} /> : null}
      {baseDialog === "rename" ? (
        <PromptDialog
          title="Rename base"
          label="Base name"
          initialValue={base.name}
          busy={renameBase.isPending}
          error={renameBase.isError ? errorMessage(renameBase.error) : null}
          onSubmit={(name) => renameBase.mutate(name)}
          onClose={() => setBaseDialog(null)}
        />
      ) : null}
      {baseDialog === "delete" ? (
        <ConfirmDialog
          title="Delete base?"
          message={
            <>
              <strong>{base.name}</strong> and all of its tables, records and automations will be
              deleted for everyone.
            </>
          }
          confirmLabel="Delete base"
          busy={deleteBase.isPending}
          onConfirm={() => deleteBase.mutate()}
          onClose={() => setBaseDialog(null)}
        />
      ) : null}
    </BaseSessionProvider>
  );
}
