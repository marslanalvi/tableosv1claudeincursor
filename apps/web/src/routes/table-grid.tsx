import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { DomGrid } from "../features/grid/DomGrid.tsx";
import { CalendarView } from "../features/views/CalendarView.tsx";
import { FormView } from "../features/views/FormView.tsx";
import { GalleryView } from "../features/views/GalleryView.tsx";
import { KanbanView } from "../features/views/KanbanView.tsx";
import { ListView } from "../features/views/ListView.tsx";
import { TimelineView } from "../features/views/TimelineView.tsx";
import { ViewToolbar } from "../features/views/ViewToolbar.tsx";
import type { ViewKind } from "../features/views/view-types.ts";
import { useViewConfig, type ViewComponentProps } from "../features/views/view-hooks.ts";
import { cleanFilter, visibleFields } from "../features/views/view-utils.ts";
import { RecordExpandDrawer } from "../features/record/RecordExpandDrawer.tsx";
import { AddFieldDialog } from "../features/schema/AddFieldDialog.tsx";
import { api, type FilterAst, type TableDto, type ViewDto } from "../lib/api.ts";
import type { ViewConfig } from "../lib/api-areas/views.ts";
import styles from "../features/grid/grid.module.css";
import viewStyles from "../features/views/views.module.css";

/* ------------------------------------------------------------------ */
/* C's components (CONTRACTS §8) are mounted when present; until then the
 * legacy grid / drawer are used. `import.meta.glob` resolves to {} when the
 * file does not exist yet, so this compiles either way. */

interface GridViewProps {
  baseId: string;
  table: TableDto;
  view: ViewDto;
  filter: FilterAst | null;
  sorts: ViewConfig["sorts"];
  groups: ViewConfig["groups"];
  search: string;
  hiddenFieldIds: string[];
  fieldOrder: string[];
  fieldWidths: Record<string, number>;
  frozenFieldCount: number;
  rowHeight: ViewConfig["rowHeight"];
  color: ViewConfig["color"];
  summary: ViewConfig["summary"];
  canEdit: boolean;
  onConfigChange(patch: Partial<ViewConfig>): void;
  onOpenRecord(recordId: string): void;
}

interface RecordDrawerProps {
  baseId: string;
  tableId: string;
  recordId: string;
  onClose: () => void;
  onNavigate?: (recordId: string) => void;
}

const gridModules = import.meta.glob("../features/grid/GridView.tsx");
const drawerModules = import.meta.glob("../features/record/RecordDrawer.tsx");

const gridLoader = Object.values(gridModules)[0];
const drawerLoader = Object.values(drawerModules)[0];

const LazyGridView = gridLoader
  ? lazy(async () => {
      const m = (await gridLoader()) as { GridView: ComponentType<GridViewProps> };
      return { default: m.GridView };
    })
  : null;

const LazyRecordDrawer = drawerLoader
  ? lazy(async () => {
      const m = (await drawerLoader()) as { RecordDrawer: ComponentType<RecordDrawerProps> };
      return { default: m.RecordDrawer };
    })
  : null;

/* ------------------------------------------------------------------ */
/* `?record=rec_…` URL param for the record drawer. */

function readRecordParam(): string | null {
  return new URLSearchParams(window.location.search).get("record");
}

function useRecordParam(): [string | null, (id: string | null) => void] {
  const [recordId, setState] = useState<string | null>(readRecordParam);
  useEffect(() => {
    const onPop = () => setState(readRecordParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const set = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("record", id);
    else url.searchParams.delete("record");
    if (url.href !== window.location.href) {
      window.history[id && !readRecordParam() ? "pushState" : "replaceState"](window.history.state, "", url);
    }
    setState(id);
  }, []);
  return [recordId, set];
}

/* ------------------------------------------------------------------ */

export function TableGridPage({
  baseId,
  table,
  activeView,
  manageFieldsSignal = 0,
  onOpenShare,
  onSchemaChange,
}: {
  baseId: string;
  table: TableDto;
  activeView?: ViewDto;
  manageFieldsSignal?: number;
  onOpenShare?: () => void;
  /** Import lives in F's Tools menu (CONTRACTS §10). */
  onOpenImport?: () => void;
  onSchemaChange: () => void;
}) {
  const queryClient = useQueryClient();
  const viewKind = (activeView?.type as ViewKind | undefined) ?? "grid";
  const { config, update, canEdit, saveError } = useViewConfig(baseId, table.id, activeView);
  const [search, setSearch] = useState("");
  const [count, setCount] = useState<number | undefined>(undefined);
  const [recordId, setRecordId] = useRecordParam();
  const [addFieldOpen, setAddFieldOpen] = useState(false);

  // Reset per-view transient state on table/view switch.
  const viewKey = `${table.id}:${activeView?.id ?? "none"}`;
  useEffect(() => {
    setSearch("");
    setCount(undefined);
  }, [viewKey]);

  useEffect(() => {
    if (manageFieldsSignal > 0) setAddFieldOpen(true);
  }, [manageFieldsSignal]);

  const createField = useMutation({
    mutationFn: (body: { name: string; type: string; config?: Record<string, unknown> }) =>
      api.createField(baseId, table.id, body),
    onSuccess: () => {
      setAddFieldOpen(false);
      onSchemaChange();
      void queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
    },
  });

  const openRecord = useCallback((id: string) => setRecordId(id), [setRecordId]);

  const effectiveFilter = useMemo(() => cleanFilter(config.filter), [config.filter]);

  const viewProps: ViewComponentProps = {
    baseId,
    table,
    view: activeView,
    config,
    update,
    canEdit,
    search,
    onOpenRecord: openRecord,
    onCount: setCount,
  };

  const legacyTable = useMemo(
    () => ({ ...table, fields: visibleFields(table, config) }),
    [table, config],
  );

  return (
    <div className={viewStyles.page}>
      <ViewToolbar
        key={viewKey}
        baseId={baseId}
        table={table}
        view={activeView}
        kind={viewKind}
        config={config}
        update={update}
        canEdit={canEdit}
        search={search}
        onSearchChange={setSearch}
        saveError={saveError}
        {...(onOpenShare ? { onShare: onOpenShare } : {})}
        {...(count !== undefined && viewKind !== "grid" ? { recordCount: count } : {})}
      />

      <div key={viewKey} className={viewStyles.viewBody}>
        {viewKind === "grid" && activeView && LazyGridView ? (
          <Suspense fallback={<p className={styles.status}>Loading grid…</p>}>
            <LazyGridView
              baseId={baseId}
              table={table}
              view={activeView}
              filter={effectiveFilter}
              sorts={config.sorts}
              groups={config.groups}
              search={search}
              hiddenFieldIds={config.hiddenFieldIds}
              fieldOrder={config.fieldOrder}
              fieldWidths={config.fieldWidths}
              frozenFieldCount={config.frozenFieldCount}
              rowHeight={config.rowHeight}
              color={config.color}
              summary={config.summary}
              canEdit={canEdit}
              onConfigChange={update}
              onOpenRecord={openRecord}
            />
          </Suspense>
        ) : null}
        {viewKind === "grid" && !(activeView && LazyGridView) ? (
          <DomGrid baseId={baseId} table={legacyTable} onSchemaChange={onSchemaChange} />
        ) : null}
        {viewKind === "kanban" ? <KanbanView {...viewProps} /> : null}
        {viewKind === "calendar" ? <CalendarView {...viewProps} /> : null}
        {viewKind === "gallery" ? <GalleryView {...viewProps} /> : null}
        {viewKind === "list" ? <ListView {...viewProps} /> : null}
        {viewKind === "timeline" ? <TimelineView {...viewProps} /> : null}
        {viewKind === "gantt" ? <TimelineView {...viewProps} gantt /> : null}
        {viewKind === "form" ? <FormView {...viewProps} /> : null}
      </div>

      {recordId ? (
        LazyRecordDrawer ? (
          <Suspense fallback={null}>
            <LazyRecordDrawer
              baseId={baseId}
              tableId={table.id}
              recordId={recordId}
              onClose={() => setRecordId(null)}
              onNavigate={(id) => setRecordId(id)}
            />
          </Suspense>
        ) : (
          <RecordExpandDrawer
            baseId={baseId}
            tableId={table.id}
            recordId={recordId}
            onClose={() => {
              setRecordId(null);
              void queryClient.invalidateQueries({ queryKey: ["records", baseId, table.id] });
            }}
          />
        )
      ) : null}

      <AddFieldDialog
        open={addFieldOpen}
        pending={createField.isPending}
        onClose={() => setAddFieldOpen(false)}
        onSubmit={(body) => createField.mutate(body)}
      />
    </div>
  );
}
