import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as filterPkg from "@tabula/filter";
import {
  FieldUiServicesProvider,
  FieldValueEditor,
  cellValueToText,
  fieldTypeIcon,
  isEmptyValue,
  optionColor,
  parseTextToValue,
  renderCellValue,
  selectOptions,
  toInputValue,
  type EditDoneReason,
  type FieldLike,
} from "@tabula/field-ui";
import type { FilterAst, TableDto, ViewDto } from "../../lib/api.ts";
import type { ViewConfig } from "../../lib/api-areas/views.ts";
import {
  errorMessage,
  recordsApi,
  removeRecordsFromCaches,
  type RecordWire,
  type RecordsPage,
} from "../../lib/api-areas/records.ts";
import type { FieldWire } from "../../lib/api-areas/fields.ts";
import { FieldDialog } from "../schema/FieldDialog.tsx";
import { useFieldActions } from "../schema/field-actions.ts";
import { useBaseRole, useFieldServices } from "./field-services.tsx";
import {
  ADD_COL_W,
  ADD_ROW_H,
  DEFAULT_COL_W,
  GROUP_H,
  HEADER_H,
  MIN_COL_W,
  PRIMARY_COL_W,
  ROWNUM_W,
  ROW_HEIGHTS,
  SUMMARY_LABEL,
  barColor,
  computeSummary,
  formatSummary,
  groupKeyOf,
  isEditableField,
  matchesFilter,
  parseTsv,
  summaryAggregate,
  summaryKindsFor,
  toHtmlTable,
  toTsv,
  type SummaryKind,
} from "./grid-utils.ts";
import { ConfirmDialog, Menu, type MenuEntry } from "./Menu.tsx";
import { Toaster, toastError, toastInfo } from "./toast.tsx";
import { noteRecordVersion, useRecordWrites } from "./useRecordWrites.ts";
import styles from "./grid-view.module.css";

/** CONTRACTS §8 */
export interface GridViewProps {
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
  /** Can change this view's config (sort, widths, hidden fields…). */
  canEdit: boolean;
  /** Can create/edit/delete records. Defaults to the user's base role (editor or higher). */
  canEditRecords?: boolean;
  /** Can add/edit/delete fields. Defaults to the user's base role (creator or owner). */
  canEditSchema?: boolean;
  onConfigChange(patch: Partial<ViewConfig>): void;
  onOpenRecord(recordId: string): void;
}

type Field = FieldLike & { slot?: number };
interface Cell {
  r: string;
  f: string;
}
type Item =
  /** `num`: 1-based position in the view's order (the gutter number), counting rows of collapsed groups. */
  | { kind: "row"; rec: RecordWire; nav: number; num: number }
  | { kind: "group"; path: string; depth: number; field: Field; label: string; color?: string | undefined; count: number; collapsed: boolean };

const PAGE_SIZE = 200;
/** Later pages are bigger (server max) so jumping far down a large table catches up quickly. */
const NEXT_PAGE_SIZE = 500;

function recordUrl(recordId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("record", recordId);
  return url.toString();
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toastInfo("Copied to clipboard");
  } catch {
    toastError("Clipboard is not available");
  }
}

/** Pick a default filter operator via @tabula/filter when available (A's API). */
function defaultOperatorFor(type: string): string {
  const fn = (filterPkg as Record<string, unknown>)["operatorsForFieldType"] as ((t: string) => string[]) | undefined;
  const ops = fn?.(type);
  if (ops && ops.length) return ops[0]!;
  if (["text", "long_text", "email", "url", "phone"].includes(type)) return "contains";
  return "eq";
}

export function GridView(props: GridViewProps) {
  const {
    baseId,
    table,
    view,
    filter,
    sorts,
    groups,
    search,
    hiddenFieldIds,
    fieldOrder,
    fieldWidths,
    frozenFieldCount,
    rowHeight,
    color,
    summary,
    canEdit,
    onConfigChange: saveViewConfig,
    onOpenRecord,
  } = props;
  // Without edit rights the server rejects view config PATCHes (403); width changes stay local.
  const onConfigChange = useCallback(
    (patch: Partial<ViewConfig>) => {
      if (canEdit) saveViewConfig(patch);
    },
    [canEdit, saveViewConfig],
  );
  const baseRole = useBaseRole(baseId);
  const canEditRecords = props.canEditRecords ?? baseRole.canEditRecords ?? false;
  const canEditSchema = props.canEditSchema ?? baseRole.canEditSchema ?? false;
  const qc = useQueryClient();
  const services = useFieldServices(baseId);
  const fieldActions = useFieldActions(baseId, table.id);
  const allFields = table.fields as unknown as Field[];
  const primaryId = table.primaryFieldId || allFields.find((f) => f.isPrimary)?.id || allFields[0]?.id;

  // ------------------------------------------------------------------ columns
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [localWidths, setLocalWidths] = useState<Record<string, number>>({});
  useEffect(() => setLocalOrder(null), [fieldOrder]);
  useEffect(() => setLocalWidths({}), [fieldWidths]);

  const orderedAll = useMemo(() => {
    const order = localOrder ?? fieldOrder ?? [];
    const pos = new Map(order.map((id, i) => [id, i]));
    const rest = allFields.filter((f) => !pos.has(f.id));
    const listed = allFields.filter((f) => pos.has(f.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
    const out = [...listed, ...rest];
    const p = out.findIndex((f) => f.id === primaryId);
    if (p > 0) out.unshift(out.splice(p, 1)[0]!);
    return out;
  }, [allFields, localOrder, fieldOrder, primaryId]);

  const columns = useMemo(
    () => orderedAll.filter((f) => f.id === primaryId || !hiddenFieldIds.includes(f.id)),
    [orderedAll, hiddenFieldIds, primaryId],
  );
  const widthOf = useCallback(
    (f: Field) => localWidths[f.id] ?? fieldWidths[f.id] ?? (f.id === primaryId ? PRIMARY_COL_W : DEFAULT_COL_W),
    [localWidths, fieldWidths, primaryId],
  );
  const frozenCount = Math.max(1, Math.min(frozenFieldCount || 1, columns.length));
  const colLayout = useMemo(() => {
    let x = ROWNUM_W;
    return columns.map((f, i) => {
      const w = widthOf(f);
      const c = { field: f, x, w, frozen: i < frozenCount, idx: i };
      x += w;
      return c;
    });
  }, [columns, widthOf, frozenCount]);
  const totalWidth = ROWNUM_W + colLayout.reduce((s, c) => s + c.w, 0) + ADD_COL_W;
  const colIndexById = useMemo(() => new Map(columns.map((f, i) => [f.id, i])), [columns]);

  // ------------------------------------------------------------------ data
  const effSort = useMemo(() => {
    const out: { field: string; direction: "asc" | "desc" }[] = [];
    for (const g of groups ?? []) if (g.fieldId) out.push({ field: g.fieldId, direction: g.direction });
    for (const s of sorts ?? []) if (s.fieldId && !out.some((o) => o.field === s.fieldId)) out.push({ field: s.fieldId, direction: s.direction });
    return out;
  }, [groups, sorts]);
  const term = search.trim();
  const queryKey = useMemo(
    () => ["records", baseId, table.id, "grid", view.id, filter ?? null, effSort, term],
    [baseId, table.id, view.id, filter, effSort, term],
  );
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      recordsApi.query(
        baseId,
        table.id,
        { filter: filter ?? null, sort: effSort, search: term, pageSize: pageParam ? NEXT_PAGE_SIZE : PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const pages = query.data?.pages;
  const lookupMap = useMemo(() => {
    const m = new Map<string, RecordWire>();
    for (const p of pages ?? []) for (const r of p?.records ?? []) m.set(r.id, r);
    return m;
  }, [pages]);
  const lookupRef = useRef(lookupMap);
  lookupRef.current = lookupMap;
  const writes = useRecordWrites(baseId, table.id, allFields, (id) => lookupRef.current.get(id));
  useEffect(() => {
    for (const r of lookupMap.values()) noteRecordVersion(r.id, r.version);
  }, [lookupMap]);

  const records = useMemo(() => {
    let rows = (pages ?? []).flatMap((p) => p?.records ?? []).map(writes.withOverrides);
    if (term) {
      // Guard in case the server ignores `search`.
      const q = term.toLowerCase();
      rows = rows.filter((r) => allFields.some((f) => cellValueToText(f, r.fields[f.id]).toLowerCase().includes(q)));
    }
    return rows;
  }, [pages, writes.withOverrides, term, allFields]);

  const hasMore = !!query.hasNextPage;
  // The server count covers filter + search. Don't trust it while the previous query's pages
  // are still shown (search just changed), or when the client-side search guard dropped rows.
  const serverCount = query.isPlaceholderData ? undefined : pages?.[0]?.totalCount;
  const loadedCount = (pages ?? []).reduce((n, p) => n + (p?.records?.length ?? 0), 0);
  const totalCount = term && !hasMore && serverCount !== undefined && records.length < loadedCount ? records.length : serverCount;

  // Summary bar: server aggregates cover every matching record, not just loaded pages.
  const summaryAggs = useMemo(() => {
    const out: { op: string; fieldId?: string; key: string }[] = [];
    for (const f of allFields) {
      const a = summaryAggregate(f.id, (summary?.[f.id] ?? "none") as SummaryKind);
      if (a && !out.some((x) => x.key === a.key)) out.push(a);
    }
    return out;
  }, [allFields, summary]);
  const summaryKey = useMemo(
    () => ["records", baseId, table.id, "summary", view.id, filter ?? null, term, summaryAggs.map((a) => a.key)],
    [baseId, table.id, view.id, filter, term, summaryAggs],
  );
  const summaryQuery = useQuery({
    queryKey: summaryKey,
    enabled: summaryAggs.length > 0 && hasMore,
    queryFn: async ({ signal }) => {
      const body = { filter: filter ?? null, search: term };
      const strip = (list: typeof summaryAggs) => list.map(({ op, fieldId }) => (fieldId ? { op, fieldId } : { op }));
      try {
        return await recordsApi.aggregate(baseId, table.id, { ...body, aggregates: strip(summaryAggs) }, signal);
      } catch {
        // One unsupported aggregate fails the whole request; keep the others.
        return recordsApi.aggregate(baseId, table.id, { ...body, aggregates: strip(summaryAggs.filter((a) => a.op !== "unique")) }, signal);
      }
    },
    placeholderData: (prev) => prev,
    staleTime: 5_000,
  });
  const summaryEnabled = summaryAggs.length > 0 && hasMore;
  useEffect(() => {
    if (!summaryEnabled) return;
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: summaryKey, exact: true }), 400);
    return () => clearTimeout(t);
  }, [lookupMap, summaryEnabled, summaryKey, qc]);

  // Group-by needs everything loaded to show correct groups/counts.
  useEffect(() => {
    if ((groups?.length ?? 0) > 0 && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [groups, query.hasNextPage, query.isFetchingNextPage, query]);

  // ------------------------------------------------------------------ groups / items
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rowH = ROW_HEIGHTS[rowHeight] ?? ROW_HEIGHTS.short;
  const { items, navRows } = useMemo(() => {
    const out: Item[] = [];
    const nav: RecordWire[] = [];
    const gFields = (groups ?? [])
      .slice(0, 3)
      .map((g) => allFields.find((f) => f.id === g.fieldId))
      .filter((f): f is Field => !!f);
    // Rows in collapsed groups still take their number, so numbers don't shift when a group collapses.
    let seq = 0;
    const build = (recs: RecordWire[], depth: number, path: string, hidden: boolean) => {
      if (depth >= gFields.length) {
        if (hidden) {
          seq += recs.length;
          return;
        }
        for (const rec of recs) {
          out.push({ kind: "row", rec, nav: nav.length, num: ++seq });
          nav.push(rec);
        }
        return;
      }
      const field = gFields[depth]!;
      const buckets = new Map<string, { label: string; color?: string | undefined; recs: RecordWire[] }>();
      for (const rec of recs) {
        const g = groupKeyOf(field, rec.fields[field.id]);
        let b = buckets.get(g.key);
        if (!b) {
          b = { label: g.label, color: g.color, recs: [] };
          buckets.set(g.key, b);
        }
        b.recs.push(rec);
      }
      for (const [key, b] of buckets) {
        const p = `${path}/${key}`;
        const isCollapsed = collapsed.has(p);
        if (!hidden) out.push({ kind: "group", path: p, depth, field, label: b.label, color: b.color, count: b.recs.length, collapsed: isCollapsed });
        build(b.recs, depth + 1, p, hidden || isCollapsed);
      }
    };
    build(records, 0, "", false);
    return { items: out, navRows: nav };
  }, [records, groups, allFields, collapsed]);

  const offsets = useMemo(() => {
    const tops = new Array<number>(items.length);
    let y = 0;
    items.forEach((it, i) => {
      tops[i] = y;
      y += it.kind === "row" ? rowH : GROUP_H;
    });
    return { tops, height: y };
  }, [items, rowH]);
  // Space for rows the server has but we haven't loaded, so the scrollbar spans the whole table.
  // Scrolling into it keeps loading pages (see "Infinite loading" below). Grouped views load everything.
  const pendingRows =
    hasMore && !(groups?.length) && typeof serverCount === "number" ? Math.max(0, serverCount - loadedCount) : 0;
  const pendingHeight = pendingRows * rowH;
  const navIndexById = useMemo(() => new Map(navRows.map((r, i) => [r.id, i])), [navRows]);
  const itemIndexByNav = useMemo(() => {
    const m: number[] = [];
    items.forEach((it, i) => {
      if (it.kind === "row") m[it.nav] = i;
    });
    return m;
  }, [items]);

  // ------------------------------------------------------------------ viewport
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800, left: 0, width: 1200 });
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        setViewport({ top: el.scrollTop, height: el.clientHeight, left: el.scrollLeft, width: el.clientWidth }),
      );
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  const bodyTopInScroll = HEADER_H;
  const visibleRange = useMemo(() => {
    const top = viewport.top - bodyTopInScroll - rowH * 10;
    const bottom = viewport.top + viewport.height - bodyTopInScroll + rowH * 10;
    const tops = offsets.tops;
    let lo = 0;
    let hi = tops.length - 1;
    let start = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid]! < top) {
        start = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let end = start;
    while (end < tops.length && tops[end]! < bottom) end++;
    return { start, end };
  }, [viewport, offsets, rowH, bodyTopInScroll]);

  // Infinite loading near the end.
  useEffect(() => {
    if (hasMore && !query.isFetchingNextPage && visibleRange.end >= items.length - 40) void query.fetchNextPage();
  }, [visibleRange.end, items.length, hasMore, query]);

  // ------------------------------------------------------------------ selection
  const [active, setActive] = useState<Cell | null>(null);
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<(Cell & { initialText?: string | undefined }) | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [selectedRows, setSelectedRows] = useState<Set<string>>(() => new Set());
  const [fillTo, setFillTo] = useState<number | null>(null);
  const dragRef = useRef<null | { kind: "select" } | { kind: "fill" }>(null);

  // Keep selection valid across refetches.
  useEffect(() => {
    if (active && (!navIndexById.has(active.r) || !colIndexById.has(active.f))) {
      if (!lookupMap.has(active.r) || !colIndexById.has(active.f)) {
        setActive(null);
        setAnchor(null);
        setEditing(null);
      }
    }
    setSelectedRows((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => lookupMap.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [navIndexById, colIndexById, active, lookupMap]);

  const range = useMemo(() => {
    if (!active) return null;
    const a = anchor ?? active;
    const r1 = navIndexById.get(a.r);
    const r2 = navIndexById.get(active.r);
    const c1 = colIndexById.get(a.f);
    const c2 = colIndexById.get(active.f);
    if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) return null;
    return { top: Math.min(r1, r2), bottom: Math.max(r1, r2), left: Math.min(c1, c2), right: Math.max(c1, c2) };
  }, [active, anchor, navIndexById, colIndexById]);

  const focusGrid = useCallback(() => {
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);

  const scrollIntoView = useCallback(
    (navIdx: number, colIdx: number) => {
      const el = scrollerRef.current;
      if (!el) return;
      const itemIdx = itemIndexByNav[navIdx];
      if (itemIdx !== undefined) {
        const y = offsets.tops[itemIdx]!;
        const viewTop = el.scrollTop;
        const viewBottom = viewTop + el.clientHeight - HEADER_H - ADD_ROW_H - 34;
        if (y < viewTop) el.scrollTop = y;
        else if (y + rowH > viewBottom) el.scrollTop = y + rowH - (el.clientHeight - HEADER_H - 34 - ADD_ROW_H);
      }
      const col = colLayout[colIdx];
      if (col && !col.frozen) {
        const frozenW = colLayout.filter((c) => c.frozen).reduce((s, c) => s + c.w, ROWNUM_W);
        if (col.x - frozenW < el.scrollLeft) el.scrollLeft = col.x - frozenW;
        else if (col.x + col.w > el.scrollLeft + el.clientWidth) el.scrollLeft = col.x + col.w - el.clientWidth;
      }
    },
    [itemIndexByNav, offsets, rowH, colLayout],
  );

  const select = useCallback(
    (cell: Cell, extend = false) => {
      setActive(cell);
      if (!extend) setAnchor(cell);
      const ni = navIndexById.get(cell.r);
      const ci = colIndexById.get(cell.f);
      if (ni !== undefined && ci !== undefined) scrollIntoView(ni, ci);
    },
    [navIndexById, colIndexById, scrollIntoView],
  );

  const moveBy = useCallback(
    (dr: number, dc: number, extend: boolean, toEdge = false) => {
      if (!active) {
        if (navRows[0] && columns[0]) select({ r: navRows[0].id, f: columns[0].id });
        return;
      }
      const ri = navIndexById.get(active.r) ?? 0;
      const ci = colIndexById.get(active.f) ?? 0;
      let nr = toEdge ? (dr > 0 ? navRows.length - 1 : dr < 0 ? 0 : ri) : ri + dr;
      let nc = toEdge ? (dc > 0 ? columns.length - 1 : dc < 0 ? 0 : ci) : ci + dc;
      nr = Math.max(0, Math.min(navRows.length - 1, nr));
      nc = Math.max(0, Math.min(columns.length - 1, nc));
      const rec = navRows[nr];
      const col = columns[nc];
      if (rec && col) select({ r: rec.id, f: col.id }, extend);
    },
    [active, navIndexById, colIndexById, navRows, columns, select],
  );

  const fieldById = useCallback((id: string) => allFields.find((f) => f.id === id), [allFields]);

  const startEdit = useCallback(
    (cell: Cell, initialText?: string) => {
      const f = fieldById(cell.f);
      if (!f || !isEditableField(f, canEditRecords)) return false;
      if (f.type === "checkbox") return false;
      setActive(cell);
      setAnchor(cell);
      editingRef.current = { ...cell, initialText };
      setEditing({ ...cell, initialText });
      return true;
    },
    [fieldById, canEditRecords],
  );

  const toggleCheckbox = useCallback(
    (cell: Cell) => {
      const f = fieldById(cell.f);
      const rec = records.find((r) => r.id === cell.r);
      if (!f || !rec || f.type !== "checkbox" || !isEditableField(f, canEditRecords)) return;
      void writes.writeRecord(rec.id, { [f.id]: rec.fields[f.id] === true ? null : true });
    },
    [fieldById, records, canEditRecords, writes],
  );

  const onEditDone = useCallback(
    (reason: EditDoneReason) => {
      editingRef.current = null;
      setEditing(null);
      focusGrid();
      if (reason === "enter") moveBy(1, 0, false);
      else if (reason === "tab") moveBy(0, 1, false);
      else if (reason === "shift-tab") moveBy(0, -1, false);
    },
    [focusGrid, moveBy],
  );

  // ------------------------------------------------------------------ bulk cell ops
  const rangeCells = useCallback(() => {
    if (!range) return [] as { rec: RecordWire; field: Field }[];
    const out: { rec: RecordWire; field: Field }[] = [];
    for (let r = range.top; r <= range.bottom; r++) {
      const rec = navRows[r];
      if (!rec) continue;
      for (let c = range.left; c <= range.right; c++) {
        const field = columns[c];
        if (field) out.push({ rec, field });
      }
    }
    return out;
  }, [range, navRows, columns]);

  const clearRange = useCallback(() => {
    const byRec = new Map<string, Record<string, unknown>>();
    for (const { rec, field } of rangeCells()) {
      if (!isEditableField(field, canEditRecords) || isEmptyValue(rec.fields[field.id])) continue;
      const cur = byRec.get(rec.id) ?? {};
      cur[field.id] = null;
      byRec.set(rec.id, cur);
    }
    if (byRec.size === 0) return;
    void writes.writeMany([...byRec].map(([id, fields]) => ({ id, fields })));
  }, [rangeCells, canEditRecords, writes]);

  const copyRange = useCallback(
    (e: ClipboardEvent) => {
      if (!range) return;
      const rows: string[][] = [];
      for (let r = range.top; r <= range.bottom; r++) {
        const rec = navRows[r];
        if (!rec) continue;
        const line: string[] = [];
        for (let c = range.left; c <= range.right; c++) {
          const f = columns[c]!;
          line.push(cellValueToText(f, rec.fields[f.id]));
        }
        rows.push(line);
      }
      e.clipboardData?.setData("text/plain", toTsv(rows));
      e.clipboardData?.setData("text/html", toHtmlTable(rows));
      e.preventDefault();
      const n = rows.length * (rows[0]?.length ?? 0);
      if (n > 1) toastInfo(`Copied ${n} cells`);
    },
    [range, navRows, columns],
  );

  const appendToCache = useCallback(
    (recs: RecordWire[], position?: { index: number }) => {
      qc.setQueryData<InfiniteData<RecordsPage, string | null>>(queryKey, (old) => {
        if (!old || old.pages.length === 0) {
          return { pages: [{ records: recs, nextCursor: null, totalCount: recs.length }], pageParams: [null] };
        }
        const pagesCopy = old.pages.map((p) => ({ ...p, records: [...p.records] }));
        if (position) {
          // Insert at a flat index.
          let idx = position.index;
          for (const p of pagesCopy) {
            if (idx <= p.records.length) {
              p.records.splice(idx, 0, ...recs);
              idx = -1;
              break;
            }
            idx -= p.records.length;
          }
          if (idx >= 0) pagesCopy[pagesCopy.length - 1]!.records.push(...recs);
        } else {
          pagesCopy[pagesCopy.length - 1]!.records.push(...recs);
        }
        const first = pagesCopy[0]!;
        if (typeof first.totalCount === "number") first.totalCount += recs.length;
        return { ...old, pages: pagesCopy };
      });
    },
    [qc, queryKey],
  );

  const pasteText = useCallback(
    async (text: string) => {
      if (!canEditRecords || !active) return;
      const grid = parseTsv(text);
      if (grid.length === 0) return;
      const r0 = range ? range.top : (navIndexById.get(active.r) ?? 0);
      const c0 = range ? range.left : (colIndexById.get(active.f) ?? 0);
      let h = grid.length;
      let w = Math.max(...grid.map((r) => r.length));
      const single = h === 1 && w === 1;
      if (single && range) {
        h = range.bottom - range.top + 1;
        w = range.right - range.left + 1;
      }
      const cellText = (i: number, j: number) => (single ? grid[0]![0]! : (grid[i]?.[j] ?? ""));
      const updates: { id: string; fields: Record<string, unknown> }[] = [];
      const raw: Record<string, Record<string, unknown>> = {};
      const newRows: Record<string, unknown>[] = [];
      let typecast = false;
      for (let i = 0; i < h; i++) {
        const rec = navRows[r0 + i];
        const fieldsPatch: Record<string, unknown> = {};
        const rawPatch: Record<string, unknown> = {};
        for (let j = 0; j < w; j++) {
          const f = columns[c0 + j];
          if (!f || !isEditableField(f, true)) continue;
          const t = cellText(i, j);
          const v = parseTextToValue(f, t);
          if (v === undefined) {
            rawPatch[f.id] = t;
            typecast = true;
          } else fieldsPatch[f.id] = v;
        }
        if (rec) {
          if (Object.keys(fieldsPatch).length || Object.keys(rawPatch).length) {
            updates.push({ id: rec.id, fields: fieldsPatch });
            if (Object.keys(rawPatch).length) raw[rec.id] = rawPatch;
          }
        } else {
          const input: Record<string, unknown> = { ...rawPatch };
          for (const [k, v] of Object.entries(fieldsPatch)) {
            const f = fieldById(k);
            if (v !== null) input[k] = f ? toInputValue(f, v) : v;
          }
          newRows.push(input);
        }
      }
      if (updates.length) {
        void writes.writeMany(updates, { typecast, ...(Object.keys(raw).length ? { raw } : {}) });
      }
      if (newRows.length) {
        if (hasMore) {
          toastError("Scroll to the end of the table before pasting new rows.");
        } else {
          try {
            const created = await recordsApi.createMany(baseId, table.id, newRows, true);
            appendToCache(created);
            if (created.length < newRows.length) void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
          } catch (e) {
            toastError(`Couldn't create rows: ${errorMessage(e)}`);
          }
        }
      }
      // Select the pasted block.
      const lastRow = navRows[Math.min(navRows.length - 1, r0 + h - 1)];
      const lastCol = columns[Math.min(columns.length - 1, c0 + w - 1)];
      const firstRow = navRows[r0];
      const firstCol = columns[c0];
      if (firstRow && firstCol && lastRow && lastCol) {
        setAnchor({ r: firstRow.id, f: firstCol.id });
        setActive({ r: lastRow.id, f: lastCol.id });
      }
      const n = updates.length + newRows.length;
      if (n > 1) toastInfo(`Pasted into ${n} records`);
    },
    [canEditRecords, active, range, navIndexById, colIndexById, navRows, columns, fieldById, writes, hasMore, baseId, table.id, appendToCache, qc],
  );

  // Clipboard events go to <body> when a non-editable element is focused.
  const copyRef = useRef(copyRange);
  copyRef.current = copyRange;
  const pasteRef = useRef(pasteText);
  pasteRef.current = pasteText;
  useEffect(() => {
    const isOurs = () => document.activeElement === scrollerRef.current && !editingRef.current;
    const onCopy = (e: ClipboardEvent) => {
      if (isOurs()) copyRef.current(e);
    };
    const onCut = (e: ClipboardEvent) => {
      if (isOurs()) copyRef.current(e);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!isOurs()) return;
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      void pasteRef.current(text);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, []);

  // ------------------------------------------------------------------ record ops
  const [confirm, setConfirm] = useState<null | { title: string; body?: ReactNode; label: string; run: () => void }>(null);

  const createRecordAt = useCallback(
    async (pos?: { before?: string; after?: string }) => {
      if (!canEditRecords) return;
      try {
        const rec = await recordsApi.create(baseId, table.id, {});
        if (!rec) {
          void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
          return;
        }
        noteRecordVersion(rec.id, rec.version);
        const flat = (pages ?? []).flatMap((p) => p?.records ?? []);
        if (pos?.before || pos?.after) {
          const refIdx = flat.findIndex((r) => r.id === (pos.before ?? pos.after));
          appendToCache([rec], { index: Math.max(0, refIdx + (pos.after ? 1 : 0)) });
          recordsApi
            .move(baseId, table.id, rec.id, pos.before ? { before: pos.before } : { after: pos.after! })
            .catch((e: unknown) => toastError(`Couldn't position the new record: ${errorMessage(e)}`));
        } else {
          appendToCache([rec]);
        }
        const firstCol = columns[0];
        if (firstCol) {
          requestAnimationFrame(() => {
            setActive({ r: rec.id, f: firstCol.id });
            setAnchor({ r: rec.id, f: firstCol.id });
            if (isEditableField(firstCol, canEditRecords) && firstCol.type !== "checkbox") setEditing({ r: rec.id, f: firstCol.id });
          });
        }
      } catch (e) {
        toastError(`Couldn't add record: ${errorMessage(e)}`);
      }
    },
    [canEditRecords, baseId, table.id, pages, appendToCache, columns, qc],
  );

  // Scroll to newly-selected rows once they exist.
  useEffect(() => {
    if (!active) return;
    const ni = navIndexById.get(active.r);
    const ci = colIndexById.get(active.f);
    if (ni !== undefined && ci !== undefined && editing && editing.r === active.r) scrollIntoView(ni, ci);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const deleteRecords = useCallback(
    (ids: string[]) => {
      const run = async () => {
        removeRecordsFromCaches(qc, baseId, table.id, ids);
        setSelectedRows(new Set());
        try {
          await recordsApi.removeMany(baseId, table.id, ids);
        } catch (e) {
          toastError(`Couldn't delete: ${errorMessage(e)}`);
        }
        void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
      };
      if (ids.length > 1) {
        setConfirm({ title: `Delete ${ids.length} records?`, body: "This can be undone with Undo.", label: "Delete records", run: () => void run() });
      } else void run();
    },
    [qc, baseId, table.id],
  );

  const duplicateRecords = useCallback(
    async (ids: string[]) => {
      try {
        for (const id of ids) {
          const src = lookupMap.get(id);
          const input: Record<string, unknown> = {};
          if (src) {
            for (const f of allFields) {
              if (!isEditableField(f, true) || src.fields[f.id] === undefined) continue;
              input[f.id] = toInputValue(f, src.fields[f.id]);
            }
          }
          const rec = await recordsApi.duplicate(baseId, table.id, id, input);
          if (!rec) continue;
          const flat = (pages ?? []).flatMap((p) => p?.records ?? []);
          appendToCache([rec], { index: flat.findIndex((r) => r.id === id) + 1 });
        }
        if (ids.length > 1) toastInfo(`Duplicated ${ids.length} records`);
      } catch (e) {
        toastError(`Couldn't duplicate: ${errorMessage(e)}`);
      }
      void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
    },
    [lookupMap, allFields, baseId, table.id, pages, appendToCache, qc],
  );

  // ------------------------------------------------------------------ menus
  const [menu, setMenu] = useState<null | { x: number; y: number; items: MenuEntry[] }>(null);
  const [fieldDialog, setFieldDialog] = useState<null | { field?: FieldWire; insert?: { at: string; side: "left" | "right" } }>(null);

  const canReorderRows = canEditRecords && effSort.length === 0 && !term;

  const openRowMenu = useCallback(
    (x: number, y: number, recId: string) => {
      const ids = selectedRows.has(recId) && selectedRows.size > 1 ? [...selectedRows] : [recId];
      const multi = ids.length > 1;
      const items: MenuEntry[] = [
        { key: "expand", icon: "⤢", label: "Expand record", onSelect: () => onOpenRecord(recId), disabled: multi },
        { key: "d0", label: "", divider: true },
        { key: "above", icon: "↑", label: "Insert record above", disabled: !canEditRecords || multi, onSelect: () => void createRecordAt({ before: recId }) },
        { key: "below", icon: "↓", label: "Insert record below", disabled: !canEditRecords || multi, onSelect: () => void createRecordAt({ after: recId }) },
        { key: "dup", icon: "⧉", label: multi ? `Duplicate ${ids.length} records` : "Duplicate record", disabled: !canEditRecords, onSelect: () => void duplicateRecords(ids) },
        { key: "link", icon: "🔗", label: "Copy record URL", disabled: multi, onSelect: () => void copyText(recordUrl(recId)) },
        { key: "d1", label: "", divider: true },
        { key: "del", icon: "🗑", label: multi ? `Delete ${ids.length} records` : "Delete record", danger: true, disabled: !canEditRecords, onSelect: () => deleteRecords(ids) },
      ];
      setMenu({ x, y, items });
    },
    [selectedRows, onOpenRecord, canEditRecords, createRecordAt, duplicateRecords, deleteRecords],
  );

  const openHeaderMenu = useCallback(
    (x: number, y: number, field: Field) => {
      const isPrimary = field.id === primaryId;
      const colIdx = colIndexById.get(field.id) ?? 0;
      const alreadyGrouped = (groups ?? []).some((g) => g.fieldId === field.id);
      const addFilter = () => {
        const sel = active && active.f === field.id ? lookupMap.get(active.r)?.fields[field.id] : undefined;
        const op = defaultOperatorFor(field.type);
        const cond = { kind: "condition" as const, fieldId: field.id, op, ...(sel !== undefined ? { value: sel } : {}) };
        const cur = filter as FilterAst | null;
        const next: FilterAst = !cur
          ? { kind: "and", children: [cond] }
          : cur.kind === "and"
            ? { kind: "and", children: [...cur.children, cond] }
            : { kind: "and", children: [cur, cond] };
        onConfigChange({ filter: next as ViewConfig["filter"] });
      };
      const items: MenuEntry[] = [
        { key: "edit", icon: "✎", label: "Edit field", disabled: !canEditSchema, onSelect: () => setFieldDialog({ field: field as FieldWire }) },
        { key: "dup", icon: "⧉", label: "Duplicate field", disabled: !canEditSchema, onSelect: () => void fieldActions.duplicate(field as FieldWire, true).catch(() => undefined) },
        { key: "left", icon: "←", label: "Insert left", disabled: !canEditSchema || isPrimary, onSelect: () => setFieldDialog({ insert: { at: field.id, side: "left" } }) },
        { key: "right", icon: "→", label: "Insert right", disabled: !canEditSchema, onSelect: () => setFieldDialog({ insert: { at: field.id, side: "right" } }) },
        { key: "d0", label: "", divider: true },
        { key: "copyurl", icon: "🔗", label: "Copy field URL", onSelect: () => void copyText(`${window.location.origin}${window.location.pathname}?field=${field.id}`) },
        { key: "copyid", icon: "#", label: "Copy field ID", hint: field.id, onSelect: () => void copyText(field.id) },
        { key: "d1", label: "", divider: true },
        { key: "asc", icon: "↧", label: "Sort A → Z", disabled: !canEdit, onSelect: () => onConfigChange({ sorts: [{ fieldId: field.id, direction: "asc" }] }) },
        { key: "desc", icon: "↥", label: "Sort Z → A", disabled: !canEdit, onSelect: () => onConfigChange({ sorts: [{ fieldId: field.id, direction: "desc" }] }) },
        { key: "filter", icon: "⚲", label: "Filter by this field", disabled: !canEdit, onSelect: addFilter },
        {
          key: "group",
          icon: "▤",
          label: alreadyGrouped ? "Remove grouping by this field" : "Group by this field",
          disabled: !canEdit || (!alreadyGrouped && (groups ?? []).length >= 3),
          onSelect: () =>
            onConfigChange({
              groups: alreadyGrouped
                ? (groups ?? []).filter((g) => g.fieldId !== field.id)
                : [...(groups ?? []), { fieldId: field.id, direction: "asc" }],
            }),
        },
        { key: "d2", label: "", divider: true },
        { key: "hide", icon: "◌", label: "Hide field", disabled: isPrimary || !canEdit, onSelect: () => onConfigChange({ hiddenFieldIds: [...hiddenFieldIds, field.id] }) },
        {
          key: "freeze",
          icon: "❄",
          label: colIdx + 1 === frozenCount ? "Unfreeze to primary field" : "Freeze up to here",
          disabled: !canEdit,
          onSelect: () => onConfigChange({ frozenFieldCount: colIdx + 1 === frozenCount ? 1 : colIdx + 1 }),
        },
        { key: "d3", label: "", divider: true },
        {
          key: "del",
          icon: "🗑",
          label: isPrimary ? "Primary field can't be deleted" : "Delete field",
          danger: true,
          disabled: isPrimary || !canEditSchema,
          onSelect: () =>
            setConfirm({
              title: `Delete field "${field.name}"?`,
              body: "All values in this field will be removed from every record.",
              label: "Delete field",
              run: () => void fieldActions.remove(field.id).catch(() => undefined),
            }),
        },
      ];
      setMenu({ x, y, items });
    },
    [primaryId, colIndexById, groups, active, lookupMap, filter, onConfigChange, canEdit, canEditSchema, fieldActions, hiddenFieldIds, frozenCount],
  );

  const openSummaryMenu = useCallback(
    (x: number, y: number, field: Field) => {
      const cur = (summary?.[field.id] ?? "none") as SummaryKind;
      setMenu({
        x,
        y,
        items: summaryKindsFor(field.type).map((k) => ({
          key: k,
          icon: cur === k ? "✓" : "",
          label: SUMMARY_LABEL[k],
          disabled: !canEdit,
          onSelect: () => onConfigChange({ summary: { ...(summary ?? {}), [field.id]: k } as ViewConfig["summary"] }),
        })),
      });
    },
    [summary, onConfigChange, canEdit],
  );

  // ------------------------------------------------------------------ header drag (resize / reorder)
  const [resizing, setResizing] = useState<string | null>(null);
  const [colDrag, setColDrag] = useState<null | { id: string; dropX: number; dropIndex: number }>(null);

  const beginResize = (e: React.MouseEvent, field: Field) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(field);
    setResizing(field.id);
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(MIN_COL_W, Math.round(startW + ev.clientX - startX));
      setLocalWidths((w) => ({ ...w, [field.id]: latest }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(null);
      if (latest !== startW) onConfigChange({ fieldWidths: { ...fieldWidths, [field.id]: latest } });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const beginHeaderDrag = (e: React.MouseEvent, field: Field) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    let moved = false;
    let dropIndex = -1;
    const scroller = scrollerRef.current!;
    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 5) return;
      if (field.id === primaryId || !canEdit) return;
      moved = true;
      const rect = scroller.getBoundingClientRect();
      const x = ev.clientX - rect.left + scroller.scrollLeft;
      // Can't drop before the primary column.
      let idx = colLayout.length;
      for (const c of colLayout) {
        if (x < c.x + c.w / 2) {
          idx = c.idx;
          break;
        }
      }
      idx = Math.max(1, idx);
      dropIndex = idx;
      const dropX = idx < colLayout.length ? colLayout[idx]!.x : colLayout[colLayout.length - 1]!.x + colLayout[colLayout.length - 1]!.w;
      setColDrag({ id: field.id, dropX, dropIndex: idx });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setColDrag(null);
      if (!moved) {
        // Plain click: select the whole column.
        if (navRows.length) {
          setAnchor({ r: navRows[0]!.id, f: field.id });
          setActive({ r: navRows[navRows.length - 1]!.id, f: field.id });
          focusGrid();
        }
        return;
      }
      const from = colIndexById.get(field.id)!;
      if (dropIndex === from || dropIndex === from + 1) return;
      const visible = columns.map((c) => c.id);
      visible.splice(from, 1);
      visible.splice(dropIndex > from ? dropIndex - 1 : dropIndex, 0, field.id);
      // Merge with hidden fields, keeping their relative positions.
      const full = orderedAll.map((f) => f.id);
      const hiddenSet = new Set(full.filter((id) => !visible.includes(id)));
      const merged: string[] = [];
      let vi = 0;
      for (const id of full) {
        if (hiddenSet.has(id)) merged.push(id);
        else merged.push(visible[vi++]!);
      }
      setLocalOrder(merged);
      onConfigChange({ fieldOrder: merged });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ------------------------------------------------------------------ row drag
  const [rowDrag, setRowDrag] = useState<null | { id: string; y: number; target: number }>(null);
  const beginRowDrag = (e: React.MouseEvent, rec: RecordWire) => {
    if (!canReorderRows || (groups?.length ?? 0) > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const scroller = scrollerRef.current!;
    let target = -1;
    const onMove = (ev: MouseEvent) => {
      const rect = scroller.getBoundingClientRect();
      const y = ev.clientY - rect.top + scroller.scrollTop - HEADER_H;
      const idx = Math.max(0, Math.min(navRows.length, Math.round(y / rowH)));
      target = idx;
      setRowDrag({ id: rec.id, y: idx * rowH, target: idx });
      // Auto-scroll near edges.
      if (ev.clientY < rect.top + HEADER_H + 20) scroller.scrollTop -= 12;
      else if (ev.clientY > rect.bottom - 40) scroller.scrollTop += 12;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setRowDrag(null);
      const from = navIndexById.get(rec.id);
      if (target < 0 || from === undefined || target === from || target === from + 1) return;
      const before = navRows[target];
      const after = navRows[target - 1];
      const flat = (pages ?? []).flatMap((p) => p?.records ?? []);
      const moved = flat.find((r) => r.id === rec.id);
      if (!moved) return;
      // Optimistic reorder in this view's cache.
      qc.setQueryData<InfiniteData<RecordsPage, string | null>>(queryKey, (old) => {
        if (!old) return old;
        const all = old.pages.flatMap((p) => p.records).filter((r) => r.id !== rec.id);
        const at = before ? all.findIndex((r) => r.id === before.id) : all.length;
        all.splice(at < 0 ? all.length : at, 0, moved);
        let k = 0;
        return { ...old, pages: old.pages.map((p) => ({ ...p, records: all.slice(k, (k += p.records.length)) })) };
      });
      recordsApi
        .move(baseId, table.id, rec.id, before ? { before: before.id } : { after: after?.id ?? null })
        .catch((err: unknown) => {
          toastError(`Couldn't move record: ${errorMessage(err)}`);
          void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
        });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ------------------------------------------------------------------ mouse on cells
  const cellFromEvent = (e: React.MouseEvent | MouseEvent): Cell | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!el) return null;
    return { r: el.dataset["r"]!, f: el.dataset["f"]! };
  };

  const onBodyMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    if (editing && editing.r === cell.r && editing.f === cell.f) return;
    const target = e.target as HTMLElement;
    const field = fieldById(cell.f);
    if (e.shiftKey && active) {
      e.preventDefault();
      setActive(cell);
      focusGrid();
      return;
    }
    editingRef.current = null;
    setEditing(null);
    setActive(cell);
    setAnchor(cell);
    setFillTo(null);
    if (field?.type === "checkbox" && target.closest("[data-tfu-checkbox]")) toggleCheckbox(cell);
    const star = target.closest<HTMLElement>("[data-tfu-rating]");
    if (field?.type === "rating" && star && isEditableField(field, canEditRecords)) {
      const n = Number(star.dataset["tfuRating"]);
      const cur = lookupMap.get(cell.r)?.fields[field.id];
      void writes.writeRecord(cell.r, { [field.id]: cur === n ? null : n });
    }
    dragRef.current = { kind: "select" };
    // Focusing the grid blurs (and thereby commits) any open editor.
    focusGrid();
  };

  const onBodyMouseOver = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d || !(e.buttons & 1)) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    if (d.kind === "select") {
      if (!active || cell.r !== active.r || cell.f !== active.f) setActive(cell);
    } else {
      const ni = navIndexById.get(cell.r);
      if (ni !== undefined && range && ni > range.bottom) setFillTo(ni);
      else setFillTo(null);
    }
  };

  useEffect(() => {
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.kind === "fill" && fillTo !== null && range) {
        const srcH = range.bottom - range.top + 1;
        const updates: { id: string; fields: Record<string, unknown> }[] = [];
        for (let r = range.bottom + 1; r <= fillTo; r++) {
          const dest = navRows[r];
          const src = navRows[range.top + ((r - range.bottom - 1) % srcH)];
          if (!dest || !src) continue;
          const fields: Record<string, unknown> = {};
          for (let c = range.left; c <= range.right; c++) {
            const f = columns[c]!;
            if (!isEditableField(f, canEditRecords)) continue;
            fields[f.id] = src.fields[f.id] ?? null;
          }
          if (Object.keys(fields).length) updates.push({ id: dest.id, fields });
        }
        void writes.writeMany(updates);
        const last = navRows[fillTo];
        if (last && anchor) {
          setAnchor({ r: navRows[range.top]!.id, f: columns[range.left]!.id });
          setActive({ r: last.id, f: columns[range.right]!.id });
        }
        setFillTo(null);
      }
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [fillTo, range, navRows, columns, canEditRecords, writes, anchor]);

  // ------------------------------------------------------------------ keyboard
  const onKeyDown = (e: React.KeyboardEvent) => {
    const pendingEdit = editingRef.current;
    if (pendingEdit && e.target === scrollerRef.current && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // Keystrokes that raced ahead of the editor mounting: append them.
      e.preventDefault();
      const next = { ...pendingEdit, initialText: (pendingEdit.initialText ?? "") + e.key };
      editingRef.current = next;
      setEditing(next);
      return;
    }
    if (editing || menu || confirm || fieldDialog) return;
    if (e.target !== scrollerRef.current) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "ArrowLeft" || key === "ArrowRight") {
      e.preventDefault();
      const dr = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
      const dc = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
      moveBy(dr, dc, e.shiftKey, mod);
      return;
    }
    if (key === "Tab") {
      e.preventDefault();
      moveBy(0, e.shiftKey ? -1 : 1, false);
      return;
    }
    if (mod && key.toLowerCase() === "a") {
      e.preventDefault();
      if (navRows.length && columns.length) {
        setAnchor({ r: navRows[0]!.id, f: columns[0]!.id });
        setActive({ r: navRows[navRows.length - 1]!.id, f: columns[columns.length - 1]!.id });
      }
      return;
    }
    if (key === "Escape") {
      if (active) setAnchor(active);
      if (selectedRows.size) setSelectedRows(new Set());
      return;
    }
    if (!active) return;
    const field = fieldById(active.f);
    if (key === "Enter") {
      e.preventDefault();
      if (field?.type === "checkbox") toggleCheckbox(active);
      else if (!startEdit(active) && field?.type !== "checkbox") onOpenRecord(active.r);
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      clearRange();
      return;
    }
    if (key === " ") {
      e.preventDefault();
      if (e.shiftKey) {
        setSelectedRows((prev) => {
          const next = new Set(prev);
          if (next.has(active.r)) next.delete(active.r);
          else next.add(active.r);
          return next;
        });
      } else if (field?.type === "checkbox") toggleCheckbox(active);
      else onOpenRecord(active.r);
      return;
    }
    if (key.length === 1 && !mod && !e.altKey && field) {
      const textual = !["single_select", "multi_select", "collaborator", "link", "attachment", "rating", "checkbox"].includes(field.type);
      if (field.type === "rating" && /^[0-9]$/.test(key) && isEditableField(field, canEditRecords)) {
        e.preventDefault();
        void writes.writeRecord(active.r, { [field.id]: Number(key) || null });
        return;
      }
      if (startEdit(active, textual ? key : undefined)) e.preventDefault();
    }
  };

  // ------------------------------------------------------------------ render helpers
  const colorFor = useCallback(
    (rec: RecordWire): string | null => {
      if (!color || color.mode === "none") return null;
      if (color.mode === "select") {
        const f = fieldById(color.fieldId);
        if (!f) return null;
        const v = rec.fields[f.id];
        const id = Array.isArray(v) ? v[0] : v;
        const opt = selectOptions(f).find((o) => o.id === id);
        return opt ? barColor(opt.color ?? "gray") : null;
      }
      for (const rule of color.rules ?? []) {
        if (matchesFilter(rule.filter as never, rec, allFields)) return barColor(rule.color);
      }
      return null;
    },
    [color, fieldById, allFields],
  );

  const wrap = rowHeight !== "short";
  const frozenWidth = colLayout.filter((c) => c.frozen).reduce((s, c) => s + c.w, 0);
  const lastFrozenIdx = frozenCount - 1;

  const renderRow = (it: Extract<Item, { kind: "row" }>, top: number) => {
    const rec = it.rec;
    const rowSelected = selectedRows.has(rec.id);
    const isEditingRow = editing?.r === rec.id;
    const barC = colorFor(rec);
    const ni = it.nav;
    return (
      <div
        key={rec.id}
        className={`${styles.row} ${rowSelected ? styles.rowSelected : ""} ${isEditingRow ? styles.rowEditing : ""}`}
        style={{ top, height: rowH, width: totalWidth }}
        onContextMenu={(e) => {
          e.preventDefault();
          openRowMenu(e.clientX, e.clientY, rec.id);
        }}
      >
        <div className={styles.rownum} style={{ width: ROWNUM_W }}>
          {barC ? <span className={styles.colorBar} style={{ background: barC }} /> : null}
          <span
            className={`${styles.grip} ${canReorderRows && !(groups?.length) ? "" : styles.gripDisabled}`}
            title={canReorderRows ? "Drag to reorder" : "Remove sorts to reorder manually"}
            onMouseDown={(e) => beginRowDrag(e, rec)}
          >
            ⋮⋮
          </span>
          <span className={styles.rowNumText}>{it.num}</span>
          <input
            type="checkbox"
            className={styles.rowCheck}
            checked={rowSelected}
            aria-label={`Select row ${it.num}`}
            onChange={() =>
              setSelectedRows((prev) => {
                const next = new Set(prev);
                if (next.has(rec.id)) next.delete(rec.id);
                else next.add(rec.id);
                return next;
              })
            }
          />
          <button type="button" className={styles.expandBtn} title="Expand record" aria-label="Expand record" onClick={() => onOpenRecord(rec.id)}>
            ⤢
          </button>
        </div>
        {colLayout.map((c) => {
          const f = c.field;
          const isActive = active?.r === rec.id && active.f === f.id;
          const inRange = !!range && ni >= range.top && ni <= range.bottom && c.idx >= range.left && c.idx <= range.right && !(range.top === range.bottom && range.left === range.right);
          const isEditing = editing?.r === rec.id && editing.f === f.id;
          const isFill = fillTo !== null && !!range && ni > range.bottom && ni <= fillTo && c.idx >= range.left && c.idx <= range.right;
          const isRangeCorner = !!range && ni === range.bottom && c.idx === range.right && canEditRecords && !editing;
          const style: CSSProperties = { width: c.w };
          if (c.frozen) style.left = c.x;
          const cls = [
            styles.cell,
            c.frozen ? styles.frozen : "",
            c.idx === lastFrozenIdx ? styles.frozenEdge : "",
            inRange ? styles.inRange : "",
            isActive ? styles.active : "",
            isEditing ? styles.editingCell : "",
            isFill ? styles.fillPreview : "",
            wrap ? styles.cellWrap : "",
          ].join(" ");
          return (
            <div key={f.id} className={cls} style={style} data-cell="1" data-r={rec.id} data-f={f.id}>
              <div className={`${styles.cellInner} ${f.id === primaryId ? styles.cellPrimary : ""}`}>
                {isEditing ? (
                  <FieldValueEditor
                    field={f}
                    value={rec.fields[f.id]}
                    mode="cell"
                    initialText={editing.initialText}
                    record={rec}
                    fields={allFields}
                    onChange={(v) => void writes.writeRecord(rec.id, { [f.id]: v })}
                    onDone={onEditDone}
                  />
                ) : (
                  renderCellValue(f, rec.fields[f.id], { error: rec.errors?.[f.id], record: rec, fields: allFields, wrap })
                )}
              </div>
              {isRangeCorner ? (
                <span
                  className={styles.fillHandle}
                  title="Drag to fill"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dragRef.current = { kind: "fill" };
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const renderGroup = (it: Extract<Item, { kind: "group" }>, top: number) => (
    <div key={`g:${it.path}`} className={styles.groupRow} style={{ top, height: GROUP_H, width: totalWidth, paddingLeft: it.depth * 16 }}>
      <button
        type="button"
        className={styles.groupLabel}
        onClick={() =>
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(it.path)) next.delete(it.path);
            else next.add(it.path);
            return next;
          })
        }
      >
        <span style={{ width: 12, color: "#41454d" }}>{it.collapsed ? "▸" : "▾"}</span>
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
          <span className={styles.groupField}>{it.field.name}</span>
          <span className={styles.groupValue}>
            {it.field.type === "single_select" && it.label !== "(Empty)" ? (
              <span style={{ background: optionColor(it.color).bg, color: optionColor(it.color).fg, borderRadius: 999, padding: "0 8px", fontSize: 12 }}>
                {it.label}
              </span>
            ) : (
              it.label
            )}
          </span>
        </span>
        <span className={styles.groupCount}>
          {it.count} {it.count === 1 ? "record" : "records"}
        </span>
      </button>
    </div>
  );

  const visibleItems: ReactNode[] = [];
  for (let i = visibleRange.start; i < Math.min(items.length, visibleRange.end); i++) {
    const it = items[i]!;
    const top = offsets.tops[i]!;
    visibleItems.push(it.kind === "row" ? renderRow(it, top) : renderGroup(it, top));
  }
  // Keep the editing row mounted even when scrolled away so edits aren't lost.
  if (editing) {
    const ni = navIndexById.get(editing.r);
    const ii = ni !== undefined ? itemIndexByNav[ni] : undefined;
    if (ii !== undefined && (ii < visibleRange.start || ii >= visibleRange.end)) {
      const it = items[ii];
      if (it && it.kind === "row") visibleItems.push(renderRow(it, offsets.tops[ii]!));
    }
  }

  const summaryText = (f: Field, kind: SummaryKind) => {
    const agg = summaryAggregate(f.id, kind);
    const server = summaryQuery.data;
    if (hasMore && agg && server && agg.key in server) return formatSummary(f, kind, server[agg.key]);
    return computeSummary(f, kind, records) + (hasMore ? "+" : "");
  };

  const bodyHeight = offsets.height + pendingHeight + ADD_ROW_H + (query.isFetchingNextPage && !pendingRows ? 32 : 0);
  const loadingTop = pendingRows
    ? Math.min(offsets.height + pendingHeight - 32, Math.max(offsets.height + 8, viewport.top - bodyTopInScroll + viewport.height / 2))
    : offsets.height + ADD_ROW_H + 8;
  const shownCount = typeof totalCount === "number" ? totalCount : records.length;

  const insertFieldAt = (created: FieldWire, ins: { at: string; side: "left" | "right" }) => {
    const full = orderedAll.map((f) => f.id).filter((id) => id !== created.id);
    const idx = full.indexOf(ins.at);
    full.splice(ins.side === "left" ? idx : idx + 1, 0, created.id);
    setLocalOrder(full);
    onConfigChange({ fieldOrder: full });
  };

  return (
    <FieldUiServicesProvider value={services}>
      <div className={styles.root}>
        <div
          ref={scrollerRef}
          className={styles.scroller}
          tabIndex={0}
          role="grid"
          aria-rowcount={shownCount}
          aria-colcount={columns.length}
          onKeyDown={onKeyDown}
        >
          <div className={styles.canvas} style={{ width: totalWidth }}>
            {/* header */}
            <div className={styles.header} style={{ width: totalWidth }} role="row">
              <div className={`${styles.hcell} ${styles.hrownum}`} style={{ width: ROWNUM_W }}>
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  style={{ accentColor: "#181d26" }}
                  checked={navRows.length > 0 && selectedRows.size === navRows.length}
                  onChange={(e) => setSelectedRows(e.target.checked ? new Set(navRows.map((r) => r.id)) : new Set())}
                />
              </div>
              {colLayout.map((c) => {
                const f = c.field;
                const style: CSSProperties = { width: c.w };
                if (c.frozen) {
                  style.position = "sticky";
                  style.left = c.x;
                  style.zIndex = 7;
                }
                const colSelected = !!range && c.idx >= range.left && c.idx <= range.right && range.top === 0 && range.bottom === navRows.length - 1 && navRows.length > 1;
                return (
                  <div
                    key={f.id}
                    role="columnheader"
                    className={`${styles.hcell} ${c.idx === lastFrozenIdx ? styles.frozenEdge : ""} ${colSelected ? styles.hcellSelected : ""} ${colDrag?.id === f.id ? styles.hcellDragging : ""}`}
                    style={style}
                    title={f.description ? `${f.name} — ${f.description}` : f.name}
                    onMouseDown={(e) => beginHeaderDrag(e, f)}
                    onDoubleClick={() => canEditSchema && setFieldDialog({ field: f as FieldWire })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openHeaderMenu(e.clientX, e.clientY, f);
                    }}
                  >
                    <span className={styles.hIcon}>{fieldTypeIcon(f.type)}</span>
                    <span className={styles.hName}>{f.name}</span>
                    <button
                      type="button"
                      className={styles.hCaret}
                      aria-label={`${f.name} field menu`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        openHeaderMenu(r.left, r.bottom + 4, f);
                      }}
                    >
                      ▾
                    </button>
                    <span className={`${styles.resizer} ${resizing === f.id ? styles.resizerActive : ""}`} onMouseDown={(e) => beginResize(e, f)} />
                  </div>
                );
              })}
              <button
                type="button"
                className={styles.addColBtn}
                title="Add field"
                aria-label="Add field"
                disabled={!canEditSchema}
                onClick={() => setFieldDialog({})}
              >
                +
              </button>
              {colDrag ? <span className={styles.dropLine} style={{ left: colDrag.dropX - 1 }} /> : null}
            </div>

            {/* body */}
            <div
              className={styles.body}
              style={{ height: bodyHeight, width: totalWidth }}
              onMouseDown={onBodyMouseDown}
              onMouseOver={onBodyMouseOver}
              onDoubleClick={(e) => {
                const cell = cellFromEvent(e);
                if (!cell) return;
                const f = fieldById(cell.f);
                if (f && !startEdit(cell) && f.type !== "checkbox") onOpenRecord(cell.r);
              }}
            >
              {visibleItems}
              {rowDrag ? <span className={styles.rowDropLine} style={{ top: rowDrag.y - 1, width: totalWidth }} /> : null}
              {pendingRows ? (
                <div
                  className={styles.pendingRows}
                  style={{ top: offsets.height, height: pendingHeight, width: totalWidth, backgroundSize: `100% ${rowH}px` }}
                  aria-hidden="true"
                />
              ) : null}
              <div className={styles.addRow} style={{ top: offsets.height + pendingHeight, width: totalWidth }}>
                <button
                  type="button"
                  className={styles.addRowBtn}
                  style={{ width: ROWNUM_W + frozenWidth }}
                  disabled={!canEditRecords}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void createRecordAt()}
                  title="Add record"
                >
                  + {hasMore ? "Add record (loads at end)" : ""}
                </button>
              </div>
              {query.isFetchingNextPage ? (
                <div className={styles.loadingMore} style={{ top: loadingTop }}>
                  Loading more records…
                </div>
              ) : null}
              {!query.isLoading && records.length === 0 ? (
                <div className={styles.empty} style={{ top: ADD_ROW_H + 24 }}>
                  {term || filter ? "No records match the current filter or search." : "No records yet. Click + to add one."}
                </div>
              ) : null}
              {query.isLoading ? (
                <div className={styles.empty} style={{ top: 24 }}>
                  Loading records…
                </div>
              ) : null}
              {query.isError ? (
                <div className={styles.empty} style={{ top: 24, color: "#aa2d00" }}>
                  Couldn't load records: {errorMessage(query.error)}
                </div>
              ) : null}
            </div>

            {/* summary bar */}
            <div className={styles.summary} style={{ width: totalWidth }}>
              <div className={`${styles.scell} ${styles.stotal}`} style={{ width: ROWNUM_W + (colLayout[0]?.w ?? 0) }}>
                {query.isPlaceholderData ? (
                  "Loading…"
                ) : (
                  <>
                    {shownCount.toLocaleString()} {shownCount === 1 ? "record" : "records"}
                    {hasMore && typeof totalCount !== "number" ? "+" : ""}
                  </>
                )}
              </div>
              {colLayout.slice(1).map((c) => {
                const kind = (summary?.[c.field.id] ?? "none") as SummaryKind;
                const style: CSSProperties = { width: c.w };
                if (c.frozen) {
                  style.position = "sticky";
                  style.left = c.x;
                  style.zIndex = 7;
                }
                return (
                  <button
                    key={c.field.id}
                    type="button"
                    className={styles.scell}
                    style={style}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      openSummaryMenu(r.left, r.top - 8 - Math.min(10, summaryKindsFor(c.field.type).length) * 32, c.field);
                    }}
                  >
                    {kind === "none" ? (
                      <span className={styles.scellHint}>Summarize ▾</span>
                    ) : (
                      <>
                        <span>{SUMMARY_LABEL[kind]}</span>
                        <span className={styles.scellValue}>{summaryText(c.field, kind)}</span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {selectedRows.size > 0 ? (
          <div className={styles.bulkBar} role="toolbar" aria-label="Selected records">
            <span>
              {selectedRows.size} {selectedRows.size === 1 ? "record" : "records"} selected
            </span>
            {canEditRecords ? (
              <>
                <button type="button" className={styles.bulkBtn} onClick={() => void duplicateRecords([...selectedRows])}>
                  Duplicate
                </button>
                <button type="button" className={styles.bulkBtn} onClick={() => deleteRecords([...selectedRows])}>
                  Delete
                </button>
              </>
            ) : null}
            <button type="button" className={styles.bulkBtn} aria-label="Clear selection" onClick={() => setSelectedRows(new Set())}>
              ✕
            </button>
          </div>
        ) : null}

        {menu ? <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
        {confirm ? (
          <ConfirmDialog
            title={confirm.title}
            body={confirm.body}
            confirmLabel={confirm.label}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const c = confirm;
              setConfirm(null);
              c.run();
            }}
          />
        ) : null}
        {fieldDialog ? (
          <FieldDialog
            baseId={baseId}
            table={table}
            field={fieldDialog.field}
            onClose={() => {
              setFieldDialog(null);
              focusGrid();
            }}
            onSaved={(saved) => {
              if (fieldDialog.insert) insertFieldAt(saved, fieldDialog.insert);
            }}
          />
        ) : null}
        <Toaster />
      </div>
    </FieldUiServicesProvider>
  );
}
