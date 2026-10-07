import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { cellValueToText } from "@tabula/field-ui";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../../app/ui.tsx";
import { ApiProblemError, type FieldDto, type TableDto } from "../../lib/api.ts";
import {
  interfacesApi,
  type ChartPoint,
  type CollectionConfig,
  type ElementField,
  type ElementRecord,
  type InterfaceElement,
  type InterfacePage,
} from "../../lib/api-areas/interfaces.ts";
import { viewRecordsApi } from "../../lib/api-areas/views.ts";
import { CellValueDisplay, ValueEditor } from "../views/field-value.tsx";
import { FormPreview } from "../views/FormView.tsx";
import { isEditableField } from "../views/view-utils.ts";
import styles from "./interfaces.module.css";

export interface RenderCtx {
  baseId: string;
  interfaceId: string;
  pageId: string;
  /** Builders preview the saved draft; everyone else reads the published snapshot. */
  draft: boolean;
  /** Changes whenever the server-side layout changes, so element queries refetch. */
  token: string | number;
  tables: TableDto[];
  pages: InterfacePage[];
  elements: InterfaceElement[];
  selections: Record<string, string>;
  select: (elementId: string, recordId: string | null) => void;
  navigate: (pageId: string) => void;
  editing: boolean;
  canWrite: boolean;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiProblemError) return err.problem.detail ?? err.problem.title;
  return err instanceof Error ? err.message : "Something went wrong";
}

function tableOf(ctx: RenderCtx, tableId: string | undefined): TableDto | undefined {
  return ctx.tables.find((t) => t.id === tableId);
}

function resolveFields(table: TableDto | undefined, fields: ElementField[]): Array<{ ef: ElementField; field: FieldDto }> {
  if (!table) return [];
  return fields
    .map((ef) => ({ ef, field: table.fields.find((f) => f.id === ef.fieldId) }))
    .filter((x): x is { ef: ElementField; field: FieldDto } => Boolean(x.field));
}

function Problem({ children }: { children: ReactNode }) {
  return <div className={styles.elementProblem}>{children}</div>;
}

export function ElementView({ el, ctx }: { el: InterfaceElement; ctx: RenderCtx }) {
  switch (el.type) {
    case "text":
      return <TextBlock body={el.config.body} />;
    case "divider":
      return <hr className={styles.divider} />;
    case "metric":
      return <MetricElement el={el} ctx={ctx} />;
    case "chart":
      return <ChartElement el={el} ctx={ctx} />;
    case "table":
    case "record_list":
    case "gallery":
      return <CollectionElement el={el} ctx={ctx} />;
    case "record_detail":
      return <RecordDetailElement el={el} ctx={ctx} />;
    case "form":
      return <FormElement el={el} ctx={ctx} />;
    case "button":
      return <ButtonElement el={el} ctx={ctx} />;
  }
}

/* ------------------------------------------------------------------ */
/* Text */

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

/** A small, safe markdown subset: `#`/`##`/`###` headings, `- ` bullets, `**bold**`, paragraphs. */
export function TextBlock({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={`ul${blocks.length}`} className={styles.textList}>
          {bullets.map((b, i) => (
            <li key={i}>{inline(b)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  body.split("\n").forEach((line, i) => {
    const t = line.trimEnd();
    if (/^[-*] /.test(t)) {
      bullets.push(t.slice(2));
      return;
    }
    flush();
    if (!t.trim()) return;
    const h = /^(#{1,3}) (.*)$/.exec(t);
    if (h) {
      const level = h[1]!.length;
      const cls = level === 1 ? styles.textH1 : level === 2 ? styles.textH2 : styles.textH3;
      blocks.push(
        <div key={i} className={cls} role="heading" aria-level={level + 1}>
          {inline(h[2]!)}
        </div>,
      );
    } else {
      blocks.push(
        <p key={i} className={styles.textP}>
          {inline(t)}
        </p>,
      );
    }
  });
  flush();
  return <div className={styles.text}>{blocks.length ? blocks : <p className={styles.muted}>Empty text</p>}</div>;
}

/* ------------------------------------------------------------------ */
/* Aggregates */

function useAggregate(el: InterfaceElement, ctx: RenderCtx, tableId: string) {
  return useQuery({
    queryKey: ["records", ctx.baseId, tableId, "itf-agg", ctx.interfaceId, ctx.pageId, el.id, ctx.draft, ctx.token],
    queryFn: () => interfacesApi.aggregateElement(ctx.baseId, ctx.interfaceId, ctx.pageId, el.id, { draft: ctx.draft }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

function formatNumber(v: unknown, format?: { style: string; precision?: number; currencyCode?: string }): string {
  const n = typeof v === "number" ? v : Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return "—";
  const precision = format?.precision ?? (Number.isInteger(n) ? 0 : 2);
  try {
    if (format?.style === "currency") {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: format.currencyCode || "USD", maximumFractionDigits: precision, minimumFractionDigits: precision }).format(n);
    }
    if (format?.style === "percent") {
      return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: precision }).format(n / 100);
    }
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: precision, minimumFractionDigits: precision }).format(n);
  } catch {
    return String(n);
  }
}

function MetricElement({ el, ctx }: { el: Extract<InterfaceElement, { type: "metric" }>; ctx: RenderCtx }) {
  const q = useAggregate(el, ctx, el.config.source.tableId);
  const table = tableOf(ctx, el.config.source.tableId);
  const field = table?.fields.find((f) => f.id === el.config.measure.fieldId);
  const caption = el.config.measure.agg === "count" ? "records" : `${el.config.measure.agg.replace("_", " ")} of ${field?.name ?? "field"}`;
  if (!table) return <Problem>This number's table was deleted.</Problem>;
  return (
    <div className={styles.metric}>
      <div className={styles.metricValue} aria-live="polite">
        {q.isLoading ? "…" : q.isError ? "—" : formatNumber(q.data?.value, el.config.format)}
      </div>
      <div className={styles.metricCaption}>{q.isError ? errorText(q.error) : caption}</div>
    </div>
  );
}

const CHART_COLORS = ["#166ee1", "#f7a300", "#1aa365", "#e2405f", "#8e4fc9", "#2bb7c6", "#c96b1a", "#5a6576"];

function pointLabel(field: FieldDto | undefined, p: ChartPoint): string {
  if (p.label === null || p.label === undefined || p.label === "") return "(Empty)";
  if (!field) return String(p.label);
  const text = cellValueToText(field, p.label);
  return text || String(p.label);
}

function ChartElement({ el, ctx }: { el: Extract<InterfaceElement, { type: "chart" }>; ctx: RenderCtx }) {
  const q = useAggregate(el, ctx, el.config.source.tableId);
  const table = tableOf(ctx, el.config.source.tableId);
  const xField = table?.fields.find((f) => f.id === el.config.x.fieldId);
  if (!table) return <Problem>This chart's table was deleted.</Problem>;
  if (!xField) return <Problem>Pick a field to group the chart by.</Problem>;
  if (q.isLoading) return <div className={styles.chartEmpty}>Loading…</div>;
  if (q.isError) return <Problem>{errorText(q.error)}</Problem>;
  const points = (q.data?.points ?? []).map((p) => ({ label: pointLabel(xField, p), value: Number(p.values[0] ?? 0) || 0 }));
  if (points.length === 0) return <div className={styles.chartEmpty}>No data to chart</div>;
  return (
    <div className={styles.chart}>
      {el.config.kind === "pie" || el.config.kind === "donut" ? (
        <PieChart points={points} donut={el.config.kind === "donut"} />
      ) : (
        <XYChart points={points} line={el.config.kind === "line"} />
      )}
      {q.data?.truncated ? <div className={styles.muted}>Showing the first {points.length} groups</div> : null}
    </div>
  );
}

function XYChart({ points, line }: { points: Array<{ label: string; value: number }>; line: boolean }) {
  const W = 560;
  const H = 220;
  const pad = { l: 40, r: 12, t: 12, b: 44 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const slot = (W - pad.l - pad.r) / points.length;
  const yOf = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f * 100) / 100);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chartSvg} role="img" aria-label={points.map((p) => `${p.label}: ${p.value}`).join(", ")}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={yOf(t)} y2={yOf(t)} className={styles.chartGrid} />
          <text x={pad.l - 6} y={yOf(t) + 4} textAnchor="end" className={styles.chartTick}>
            {t}
          </text>
        </g>
      ))}
      {line ? (
        <polyline
          fill="none"
          stroke={CHART_COLORS[0]}
          strokeWidth={2}
          points={points.map((p, i) => `${pad.l + slot * (i + 0.5)},${yOf(p.value)}`).join(" ")}
        />
      ) : null}
      {points.map((p, i) => {
        const cx = pad.l + slot * (i + 0.5);
        const bw = Math.max(4, Math.min(48, slot * 0.6));
        return (
          <g key={i}>
            <title>{`${p.label}: ${p.value}`}</title>
            {line ? (
              <circle cx={cx} cy={yOf(p.value)} r={3.5} fill={CHART_COLORS[0]} />
            ) : (
              <rect x={cx - bw / 2} y={yOf(p.value)} width={bw} height={Math.max(0, H - pad.b - yOf(p.value))} rx={3} fill={CHART_COLORS[0]} />
            )}
            <text x={cx} y={H - pad.b + 16} textAnchor="middle" className={styles.chartTick}>
              {p.label.length > 12 ? `${p.label.slice(0, 11)}…` : p.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PieChart({ points, donut }: { points: Array<{ label: string; value: number }>; donut: boolean }) {
  const total = points.reduce((s, p) => s + p.value, 0) || 1;
  const R = 80;
  const r = donut ? 46 : 0;
  let a0 = -Math.PI / 2;
  const arc = (a: number, rad: number) => `${100 + rad * Math.cos(a)},${100 + rad * Math.sin(a)}`;
  return (
    <div className={styles.pie}>
      <svg viewBox="0 0 200 200" className={styles.pieSvg} role="img" aria-label={points.map((p) => `${p.label}: ${p.value}`).join(", ")}>
        {points.map((p, i) => {
          const frac = p.value / total;
          const a1 = a0 + frac * Math.PI * 2;
          const large = frac > 0.5 ? 1 : 0;
          const d =
            frac >= 0.9999
              ? `M ${arc(-Math.PI / 2, R)} A ${R} ${R} 0 1 1 ${arc(-Math.PI / 2 - 0.0001, R)} Z`
              : `M ${arc(a0, R)} A ${R} ${R} 0 ${large} 1 ${arc(a1, R)} L ${r ? arc(a1, r) : "100,100"} ${r ? `A ${r} ${r} 0 ${large} 0 ${arc(a0, r)}` : ""} Z`;
          a0 = a1;
          return (
            <path key={i} d={d} fill={CHART_COLORS[i % CHART_COLORS.length]}>
              <title>{`${p.label}: ${p.value}`}</title>
            </path>
          );
        })}
        {donut ? <circle cx={100} cy={100} r={r} fill="var(--tabula-color-bg)" /> : null}
      </svg>
      <ul className={styles.legend}>
        {points.map((p, i) => (
          <li key={i}>
            <span className={styles.legendSwatch} style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className={styles.legendLabel}>{p.label}</span>
            <span className={styles.legendValue}>{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Collections (grid / list / gallery) */

function hasDetailFor(ctx: RenderCtx, elementId: string): boolean {
  return ctx.elements.some((e) => e.type === "record_detail" && e.config.dataSource.recordContext.elementId === elementId);
}

function CollectionElement({
  el,
  ctx,
}: {
  el: Extract<InterfaceElement, { type: "table" | "record_list" | "gallery" }>;
  ctx: RenderCtx;
}) {
  const cfg: CollectionConfig = el.config;
  const table = tableOf(ctx, cfg.dataSource.tableId);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState<ElementRecord | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const q = useInfiniteQuery({
    queryKey: ["records", ctx.baseId, cfg.dataSource.tableId, "itf", ctx.interfaceId, ctx.pageId, el.id, ctx.draft, ctx.token, debounced],
    queryFn: ({ pageParam }) =>
      interfacesApi.queryElement(ctx.baseId, ctx.interfaceId, ctx.pageId, el.id, {
        draft: ctx.draft,
        pageSize: el.type === "gallery" ? 24 : 50,
        ...(debounced ? { search: debounced } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });

  const fields = resolveFields(table, cfg.fields);
  const titleField = table?.fields.find((f) => f.id === (cfg.titleFieldId ?? table.primaryFieldId)) ?? fields[0]?.field;
  const records = q.data?.pages.flatMap((p) => p.records) ?? [];
  const selected = ctx.selections[el.id];
  const linked = hasDetailFor(ctx, el.id);

  if (!table) return <Problem>This element's table was deleted.</Problem>;

  const activate = (rec: ElementRecord) => {
    if (cfg.selection === "single" && linked) ctx.select(el.id, rec.id);
    else if (cfg.permissions.allowOpenRecord) setOpen(rec);
  };
  const title = (rec: ElementRecord) => (titleField ? cellValueToText(titleField, rec.fields[titleField.id]) : "") || "Unnamed record";

  return (
    <div className={styles.collection}>
      {cfg.searchable || (cfg.permissions.allowCreate && ctx.canWrite) ? (
        <div className={styles.collectionBar}>
          {cfg.searchable ? (
            <input
              type="search"
              className={styles.searchInput}
              placeholder={`Search ${table.name}`}
              aria-label={`Search ${el.title || table.name}`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          ) : (
            <span />
          )}
          {cfg.permissions.allowCreate && ctx.canWrite ? (
            <button type="button" className={styles.secondaryBtn} onClick={() => setCreating(true)}>
              + New record
            </button>
          ) : null}
        </div>
      ) : null}

      {q.isError ? <Problem>{errorText(q.error)}</Problem> : null}
      {q.isLoading ? <div className={styles.muted}>Loading…</div> : null}
      {!q.isLoading && !q.isError && records.length === 0 ? (
        <div className={styles.emptyRecords}>{cfg.emptyText || (debounced ? "No matching records" : "No records")}</div>
      ) : null}

      {records.length > 0 && el.type === "table" ? (
        <div className={styles.gridWrap}>
          <table className={styles.grid}>
            <thead>
              <tr>
                {fields.map(({ ef, field }) => (
                  <th key={field.id} scope="col">
                    {ef.label?.trim() || field.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((rec) => (
                <tr
                  key={rec.id}
                  data-selected={selected === rec.id || undefined}
                  tabIndex={0}
                  onClick={() => activate(rec)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") activate(rec);
                  }}
                >
                  {fields.map(({ field }) => (
                    <td key={field.id}>
                      <CellValueDisplay field={field} value={rec.fields[field.id]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {records.length > 0 && el.type === "record_list" ? (
        <ul className={styles.recordList}>
          {records.map((rec) => (
            <li key={rec.id}>
              <button type="button" className={styles.recordListItem} data-selected={selected === rec.id || undefined} onClick={() => activate(rec)}>
                <span className={styles.recordListTitle}>{title(rec)}</span>
                <span className={styles.recordListMeta}>
                  {fields
                    .filter(({ field }) => field.id !== titleField?.id)
                    .slice(0, 3)
                    .map(({ field }) => (
                      <span key={field.id} className={styles.recordListCell}>
                        <CellValueDisplay field={field} value={rec.fields[field.id]} />
                      </span>
                    ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {records.length > 0 && el.type === "gallery" ? (
        <div className={styles.gallery}>
          {records.map((rec) => (
            <button key={rec.id} type="button" className={styles.galleryCard} data-selected={selected === rec.id || undefined} onClick={() => activate(rec)}>
              <span className={styles.galleryTitle}>{title(rec)}</span>
              {fields
                .filter(({ field }) => field.id !== titleField?.id)
                .map(({ ef, field }) => (
                  <span key={field.id} className={styles.galleryField}>
                    <span className={styles.galleryLabel}>{ef.label?.trim() || field.name}</span>
                    <span className={styles.galleryValue}>
                      <CellValueDisplay field={field} value={rec.fields[field.id]} />
                    </span>
                  </span>
                ))}
            </button>
          ))}
        </div>
      ) : null}

      {q.hasNextPage ? (
        <button type="button" className={styles.linkBtn} disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}

      {open ? (
        <Dialog title={title(open)} onClose={() => setOpen(null)} wide>
          <RecordFields ctx={ctx} table={table} record={open} fields={cfg.fields} onSaved={(r) => setOpen(r)} />
        </Dialog>
      ) : null}
      {creating ? (
        <Dialog title={`New ${table.name}`} onClose={() => setCreating(false)} wide>
          <FormPreview
            baseId={ctx.baseId}
            table={table}
            form={{
              title: "",
              description: "",
              fields: fields.filter(({ field }) => isEditableField(field)).map(({ ef }) => ({ fieldId: ef.fieldId, required: Boolean(ef.required) })),
              submitLabel: "Create record",
              successMessage: "Record created.",
              allowResubmit: true,
            }}
          />
        </Dialog>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Record details */

/** The element's fields for one record; editable ones save as you type. */
function RecordFields({
  ctx,
  table,
  record,
  fields,
  onSaved,
}: {
  ctx: RenderCtx;
  table: TableDto;
  record: ElementRecord;
  fields: ElementField[];
  onSaved?: (r: ElementRecord) => void;
}) {
  const qc = useQueryClient();
  const items = resolveFields(table, fields);
  const [values, setValues] = useState<Record<string, unknown>>(record.fields);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setValues(record.fields), [record]);

  const flush = async () => {
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const saved = await viewRecordsApi.patch(ctx.baseId, table.id, record.id, patch);
      setError(null);
      onSaved?.({ id: record.id, fields: { ...record.fields, ...saved.fields } });
      void qc.invalidateQueries({ queryKey: ["records", ctx.baseId, table.id] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record.id],
  );

  return (
    <div className={styles.detail}>
      {items.length === 0 ? <div className={styles.muted}>No fields are shown here yet.</div> : null}
      {items.map(({ ef, field }) => {
        const editable = ef.editable && ctx.canWrite && !ctx.editing && isEditableField(field);
        const labelId = `itf-${record.id}-${field.id}`;
        return (
          <div key={field.id} className={styles.detailRow}>
            <div className={styles.detailLabel} id={labelId}>
              {ef.label?.trim() || field.name}
            </div>
            <div className={styles.detailValue}>
              {editable ? (
                <ValueEditor
                  baseId={ctx.baseId}
                  field={field}
                  labelledBy={labelId}
                  value={values[field.id]}
                  onChange={(v) => {
                    setValues((s) => ({ ...s, [field.id]: v }));
                    pending.current[field.id] = v;
                    if (timer.current) clearTimeout(timer.current);
                    timer.current = setTimeout(() => void flush(), 600);
                  }}
                />
              ) : (
                <CellValueDisplay field={field} value={values[field.id]} />
              )}
            </div>
          </div>
        );
      })}
      {error ? <div className={styles.elementProblem}>{error}</div> : null}
      {saving ? <div className={styles.muted}>Saving…</div> : null}
    </div>
  );
}

function RecordDetailElement({ el, ctx }: { el: Extract<InterfaceElement, { type: "record_detail" }>; ctx: RenderCtx }) {
  const srcId = el.config.dataSource.recordContext.elementId;
  const selected = ctx.selections[srcId];
  const table = tableOf(ctx, el.config.dataSource.tableId);
  const source = ctx.elements.find((e) => e.id === srcId);
  const q = useQuery({
    queryKey: ["records", ctx.baseId, el.config.dataSource.tableId, "itf", ctx.interfaceId, ctx.pageId, el.id, ctx.draft, ctx.token, selected],
    queryFn: () =>
      interfacesApi.queryElement(ctx.baseId, ctx.interfaceId, ctx.pageId, el.id, {
        draft: ctx.draft,
        context: { selections: selected ? { [srcId]: selected } : {} },
      }),
    enabled: Boolean(selected && table),
    staleTime: 15_000,
  });
  if (!table) return <Problem>This element's table was deleted.</Problem>;
  if (!source) return <Problem>The element this one follows was removed. Pick another in the settings.</Problem>;
  if (!selected) return <div className={styles.emptyRecords}>Select a record in “{source.title || "the list"}” to see its details.</div>;
  if (q.isLoading) return <div className={styles.muted}>Loading…</div>;
  if (q.isError) return <Problem>{errorText(q.error)}</Problem>;
  const rec = q.data?.records[0];
  if (!rec) return <div className={styles.emptyRecords}>That record is no longer available.</div>;
  return <RecordFields ctx={ctx} table={table} record={rec} fields={el.config.fields} />;
}

/* ------------------------------------------------------------------ */
/* Form + button */

function FormElement({ el, ctx }: { el: Extract<InterfaceElement, { type: "form" }>; ctx: RenderCtx }) {
  const table = tableOf(ctx, el.config.tableId);
  const form = useMemo(
    () => ({
      title: el.title ?? "",
      description: el.description ?? "",
      fields: el.config.fields.map((f) => ({ fieldId: f.fieldId, required: Boolean(f.required), ...(f.label ? { label: f.label } : {}) })),
      submitLabel: el.config.submit.label,
      successMessage: el.config.submit.message,
      allowResubmit: true,
    }),
    [el],
  );
  if (!table) return <Problem>This form's table was deleted.</Problem>;
  if (!ctx.canWrite) return <Problem>You don't have permission to add records to {table.name}.</Problem>;
  return (
    <div className={styles.formWrap}>
      <FormPreview baseId={ctx.baseId} table={table} form={form} interactive={!ctx.editing} />
    </div>
  );
}

function ButtonElement({ el, ctx }: { el: Extract<InterfaceElement, { type: "button" }>; ctx: RenderCtx }) {
  const run = () => {
    if (ctx.editing) return;
    for (const a of el.config.actions) {
      if (a.kind === "open_url") {
        if (/^(https:|mailto:|tel:)/i.test(a.urlTemplate)) window.open(a.urlTemplate, a.newTab ? "_blank" : "_self", "noopener,noreferrer");
      } else if (ctx.pages.some((p) => p.id === a.pageId)) {
        ctx.navigate(a.pageId);
      }
    }
  };
  const cls =
    el.config.style === "secondary"
      ? styles.secondaryBtn
      : el.config.style === "danger"
        ? styles.dangerBtn
        : el.config.style === "link"
          ? styles.linkBtn
          : styles.primaryBtn;
  return (
    <button type="button" className={cls} onClick={run} title={ctx.editing ? "Buttons run in Preview" : undefined}>
      {el.config.label}
    </button>
  );
}
