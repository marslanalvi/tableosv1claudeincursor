import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { fieldTypeIcon, renderCellValue } from "@tabula/field-ui";
import {
  queryRecords,
  type PublicField,
  type PublicRecord,
  type PublicSharePayload,
  type PublicViewRef,
} from "../lib/public-api.ts";
import styles from "./view.module.css";

type ReadableShare = Exclude<PublicSharePayload, { kind: "form" }>;
type Sort = { field: string; direction: "asc" | "desc" } | null;

const ROW_HEIGHTS = { short: 34, medium: 56, tall: 88, extra: 128 } as const;
const PAGE_SIZE = 100;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function SortArrow({ direction }: { direction: "asc" | "desc" }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d={direction === "asc" ? "M5 2 9 7H1z" : "M5 8 1 3h8z"} fill="currentColor" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function RecordPanel({
  record,
  fields,
  title,
  onClose,
  onPrev,
  onNext,
}: {
  record: PublicRecord;
  fields: PublicField[];
  title: string;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowUp" && onPrev) onPrev();
      if (e.key === "ArrowDown" && onNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  return (
    <>
      <div className={styles.scrim} onClick={onClose} aria-hidden />
      <aside className={styles.panel} role="dialog" aria-label={title}>
        <header className={styles.panelHeader}>
          <div className={styles.panelNav}>
            <button type="button" className={styles.iconBtn} onClick={onPrev ?? undefined} disabled={!onPrev} aria-label="Previous record">
              ↑
            </button>
            <button type="button" className={styles.iconBtn} onClick={onNext ?? undefined} disabled={!onNext} aria-label="Next record">
              ↓
            </button>
          </div>
          <h2 className={styles.panelTitle}>{title || "Untitled record"}</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className={styles.panelBody}>
          {fields.map((f) => {
            const value = record.fields[f.id];
            const error = record.errors?.[f.id];
            const empty = value === undefined && !error;
            return (
              <section key={f.id} className={styles.detailField}>
                <div className={styles.detailLabel}>
                  <span className={styles.typeIcon} aria-hidden>
                    {fieldTypeIcon(f.type)}
                  </span>
                  {f.name}
                </div>
                {f.description ? <p className={styles.detailHelp}>{f.description}</p> : null}
                <div className={styles.detailValue}>
                  {empty ? <span className={styles.emptyValue}>—</span> : renderCellValue(f, value, { error, wrap: true, record, fields })}
                </div>
              </section>
            );
          })}
        </div>
      </aside>
    </>
  );
}

export function SharedView({ token, share }: { token: string; share: ReadableShare }) {
  const isBase = share.kind === "base";
  const tables = isBase ? share.tables : [];
  const [tableId, setTableId] = useState<string | null>(isBase ? (tables[0]?.id ?? null) : (share.table?.id ?? null));
  const activeTable = isBase ? tables.find((t) => t.id === tableId) ?? tables[0] : null;
  const views: PublicViewRef[] = activeTable?.views ?? [];
  const [viewId, setViewId] = useState<string | null>(null);
  useEffect(() => setViewId(null), [tableId]);

  const fields: PublicField[] = isBase ? (activeTable?.fields ?? []) : share.fields;
  const viewConfig = share.kind === "view" ? share.view.config : {};
  const primaryId = isBase ? activeTable?.primaryFieldId : share.kind === "view" ? share.primaryFieldId : null;
  const primaryField = fields.find((f) => f.id === primaryId) ?? fields[0];

  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [sort, setSort] = useState<Sort>(null);
  useEffect(() => setSort(null), [tableId, viewId]);
  const [openId, setOpenId] = useState<string | null>(null);

  const scope = {
    ...(isBase && tableId ? { tableId } : {}),
    ...(isBase && viewId ? { viewId } : {}),
  };

  const recordsQuery = useInfiniteQuery({
    queryKey: ["public-records", token, scope, q, sort],
    queryFn: ({ pageParam }) =>
      queryRecords(token, {
        ...scope,
        ...(q ? { search: q } : {}),
        ...(sort ? { sort: [sort] } : {}),
        pageSize: PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchOnWindowFocus: false,
  });

  const records = useMemo(() => recordsQuery.data?.pages.flatMap((p) => p.records) ?? [], [recordsQuery.data]);
  const openIndex = openId ? records.findIndex((r) => r.id === openId) : -1;
  const openRecord = openIndex >= 0 ? records[openIndex] : null;

  // Infinite scroll: load the next page when the sentinel nears the viewport.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = recordsQuery;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { root: scrollRef.current, rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, records.length]);

  const rowHeight = ROW_HEIGHTS[viewConfig.rowHeight ?? "short"] ?? ROW_HEIGHTS.short;
  const widthOf = (f: PublicField) => viewConfig.fieldWidths?.[f.id] ?? (f.id === primaryField?.id ? 240 : 180);
  const totalWidth = 56 + fields.reduce((n, f) => n + widthOf(f), 0);

  function toggleSort(fieldId: string) {
    setSort((cur) =>
      !cur || cur.field !== fieldId
        ? { field: fieldId, direction: "asc" }
        : cur.direction === "asc"
          ? { field: fieldId, direction: "desc" }
          : null,
    );
  }

  const titleOf = (r: PublicRecord) => {
    const v = primaryField ? r.fields[primaryField.id] : undefined;
    return typeof v === "string" ? v : v == null ? "" : typeof v === "number" ? String(v) : JSON.stringify(v);
  };
  const canCopy = share.share.allowCopy;
  const sortedField = sort ? fields.find((f) => f.id === sort.field) : null;

  return (
    <div className={styles.wrap}>
      {isBase && tables.length > 0 ? (
        <div className={styles.tableTabs} role="tablist" aria-label="Tables">
          {tables.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === activeTable?.id}
              className={t.id === activeTable?.id ? styles.tabActive : styles.tab}
              onClick={() => setTableId(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{isBase ? (activeTable?.name ?? share.title) : share.title}</h1>
          {share.description ? <p className={styles.description}>{share.description}</p> : null}
        </div>
        <span className={styles.spacer} />
        {isBase && views.length > 0 ? (
          <select
            className={styles.select}
            aria-label="View"
            value={viewId ?? ""}
            onChange={(e) => setViewId(e.target.value || null)}
          >
            <option value="">All records</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        ) : null}
        {sortedField && sort ? (
          <button type="button" className={styles.sortChip} onClick={() => setSort(null)} title="Clear sort">
            Sorted by {sortedField.name} {sort.direction === "asc" ? "A → Z" : "Z → A"} ✕
          </button>
        ) : null}
        <label className={styles.search}>
          <SearchIcon />
          <input
            type="search"
            placeholder="Search records"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search records"
          />
        </label>
      </div>

      <div className={styles.gridScroll} ref={scrollRef}>
        <table
          className={`${styles.grid} ${canCopy ? "" : styles.noCopy}`}
          style={{ width: totalWidth, ["--row-h" as string]: `${rowHeight}px` }}
        >
          <colgroup>
            <col style={{ width: 56 }} />
            {fields.map((f) => (
              <col key={f.id} style={{ width: widthOf(f) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className={`${styles.rowNumHead} ${styles.frozen}`} aria-label="Row" />
              {fields.map((f) => {
                const active = sort?.field === f.id;
                return (
                  <th
                    key={f.id}
                    className={f.id === primaryField?.id ? `${styles.frozenPrimary}` : undefined}
                    aria-sort={active ? (sort?.direction === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button type="button" className={styles.headBtn} onClick={() => toggleSort(f.id)} title={`Sort by ${f.name}`}>
                      <span className={styles.typeIcon} aria-hidden>
                        {fieldTypeIcon(f.type)}
                      </span>
                      <span className={styles.headName}>{f.name}</span>
                      {active && sort ? <SortArrow direction={sort.direction} /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} className={openId === r.id ? styles.rowActive : undefined}>
                <td className={`${styles.rowNum} ${styles.frozen}`}>{i + 1}</td>
                {fields.map((f) => {
                  const value = r.fields[f.id];
                  const error = r.errors?.[f.id];
                  return (
                    <td key={f.id} className={f.id === primaryField?.id ? styles.frozenPrimary : undefined}>
                      <div className={styles.cell}>
                        {value === undefined && !error ? null : renderCellValue(f, value, { error, record: r, fields, wrap: rowHeight > 40 })}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {recordsQuery.isLoading ? <div className={styles.gridState}>Loading records…</div> : null}
        {recordsQuery.isError ? <div className={styles.gridState}>Couldn’t load records. Please refresh the page.</div> : null}
        {recordsQuery.isSuccess && records.length === 0 ? (
          <div className={styles.gridState}>{q ? `No records match “${q}”.` : "There are no records in this view."}</div>
        ) : null}
        <div ref={sentinelRef} className={styles.sentinel} />
        {isFetchingNextPage ? <div className={styles.gridState}>Loading more…</div> : null}
      </div>

      <footer className={styles.footer}>
        {recordsQuery.isSuccess ? `${records.length}${hasNextPage ? "+" : ""} record${records.length === 1 ? "" : "s"}` : ""}
      </footer>

      {openRecord ? (
        <RecordPanel
          record={openRecord}
          fields={fields}
          title={titleOf(openRecord)}
          onClose={() => setOpenId(null)}
          onPrev={openIndex > 0 ? () => setOpenId(records[openIndex - 1]!.id) : null}
          onNext={openIndex < records.length - 1 ? () => setOpenId(records[openIndex + 1]!.id) : null}
        />
      ) : null}
    </div>
  );
}
