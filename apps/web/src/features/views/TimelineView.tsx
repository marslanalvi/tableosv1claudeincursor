import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewRecord } from "../../lib/api-areas/views.ts";
import { useRecordWrites, useViewRecords, type ViewComponentProps } from "./view-hooks.ts";
import {
  addDays,
  colorOf,
  dateValueFor,
  dayDiff,
  groupRecords,
  parseDateValue,
  primaryText,
  recordColor,
  shiftDateValue,
  startOfDay,
  ymd,
  type RecordGroup,
} from "./view-utils.ts";
import styles from "./views.module.css";

const PX_PER_DAY = { day: 44, week: 18, month: 5 } as const;
const ROW_H = 36;

type Row =
  | { kind: "group"; key: string; label: string; color?: string | undefined; depth: number; count: number }
  | { kind: "record"; key: string; record: ViewRecord; start: Date | null; end: Date | null };

interface DragState {
  recordId: string;
  mode: "move" | "start" | "end";
  originX: number;
  deltaDays: number;
}

export function TimelineView(props: ViewComponentProps & { gantt?: boolean }) {
  const { baseId, table, view, config, update, canEdit, search, onOpenRecord, onCount } = props;
  const t = config.timeline ?? { startFieldId: null };
  const scale = t.scale ?? "week";
  const px = PX_PER_DAY[scale];
  const startField = table.fields.find((f) => f.id === t.startFieldId);
  const endField = table.fields.find((f) => f.id === t.endFieldId);
  const editable = (f: typeof startField) => Boolean(f && (f.type === "date" || f.type === "datetime"));
  const { records, queryKey, isLoading } = useViewRecords(baseId, table, view?.id, config, search);
  const writes = useRecordWrites(baseId, table.id, queryKey);
  const [drag, setDrag] = useState<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => onCount?.(records.length), [records.length, onCount]);

  const spanOf = (r: ViewRecord) => {
    if (!startField) return { start: null, end: null };
    const s = parseDateValue(r.fields[startField.id]);
    let e = endField ? parseDateValue(r.fields[endField.id]) : null;
    if (s && (!e || e < s)) e = s;
    return { start: s ? startOfDay(s) : null, end: e ? startOfDay(e) : null };
  };

  const range = useMemo(() => {
    const today = startOfDay(new Date());
    let min = addDays(today, -14);
    let max = addDays(today, scale === "month" ? 180 : scale === "week" ? 70 : 28);
    for (const r of records) {
      const { start, end } = spanOf(r);
      if (start && start < addDays(min, 7)) min = addDays(start, -7);
      if (end && end > addDays(max, -7)) max = addDays(end, 14);
    }
    // Align to week start for nicer ticks.
    min = addDays(min, -min.getDay());
    return { min, days: dayDiff(max, min) + 1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, scale, startField?.id, endField?.id]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const pushRecords = (rs: ViewRecord[]) => {
      for (const r of rs) out.push({ kind: "record", key: r.id, record: r, ...spanOf(r) });
    };
    const walk = (gs: RecordGroup<ViewRecord>[], path: string, depth: number) => {
      for (const g of gs) {
        const id = `${path}/${g.key}`;
        out.push({ kind: "group", key: id, label: `${g.field.name}: ${g.label}`, color: g.color, depth, count: g.records.length });
        if (collapsed.has(id)) continue;
        if (g.children.length) walk(g.children, id, depth + 1);
        else pushRecords(g.records);
      }
    };
    const groups = groupRecords(records, config.groups, table.fields);
    if (groups.length) walk(groups, "", 0);
    else pushRecords(records);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, config.groups, table.fields, collapsed, startField?.id, endField?.id]);

  // Scroll to today on first render / scale change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, dayDiff(new Date(), range.min) * px - 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, startField?.id]);

  if (!startField) {
    const dates = table.fields.filter((f) => f.type === "date" || f.type === "datetime");
    return (
      <div className={styles.emptyState}>
        <h3>Choose a start date field for this timeline</h3>
        {dates.length ? (
          <select
            className={styles.select}
            disabled={!canEdit}
            aria-label="Start date field"
            value=""
            onChange={(e) => update({ timeline: { ...t, startFieldId: e.target.value || null } })}
          >
            <option value="">Choose a field…</option>
            {dates.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          <p>Add a date field to this table to use a timeline view.</p>
        )}
      </div>
    );
  }

  const width = range.days * px;
  const ticks: { x: number; label: string; major: boolean }[] = [];
  for (let i = 0; i < range.days; i += 1) {
    const d = addDays(range.min, i);
    if (scale === "day") ticks.push({ x: i * px, label: String(d.getDate()), major: d.getDate() === 1 || i === 0 });
    else if (scale === "week" && d.getDay() === 0)
      ticks.push({ x: i * px, label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), major: d.getDate() <= 7 });
    else if (scale === "month" && d.getDate() === 1)
      ticks.push({ x: i * px, label: d.toLocaleDateString(undefined, { month: "short", year: "2-digit" }), major: d.getMonth() === 0 });
  }
  const months: { x: number; label: string }[] = [];
  if (scale === "day") {
    for (let i = 0; i < range.days; i += 1) {
      const d = addDays(range.min, i);
      if (i === 0 || d.getDate() === 1) months.push({ x: i * px, label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) });
    }
  }
  const todayX = dayDiff(new Date(), range.min) * px;

  function onPointerDown(e: React.PointerEvent, recordId: string, mode: DragState["mode"]) {
    if (!canEdit) return;
    if (mode !== "end" && !editable(startField)) return;
    if (mode === "end" && !editable(endField)) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ recordId, mode, originX: e.clientX, deltaDays: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.originX) / px);
    if (delta !== drag.deltaDays) setDrag({ ...drag, deltaDays: delta });
  }

  async function onPointerUp() {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const rec = records.find((r) => r.id === d.recordId);
    if (!rec || !startField) return;
    if (d.deltaDays === 0) {
      onOpenRecord(rec.id);
      return;
    }
    const { start, end } = spanOf(rec);
    const patch: Record<string, unknown> = {};
    if (d.mode === "move" || d.mode === "start") {
      if (d.mode === "start" && end && start && dayDiff(end, addDays(start, d.deltaDays)) < 0) return;
      patch[startField.id] = shiftDateValue(startField, rec.fields[startField.id], d.deltaDays);
    }
    if (endField && editable(endField) && (d.mode === "move" || d.mode === "end")) {
      const base = rec.fields[endField.id] ?? rec.fields[startField.id];
      if (d.mode === "end" && start && end && dayDiff(addDays(end, d.deltaDays), start) < 0) return;
      patch[endField.id] = shiftDateValue(endField, base, d.deltaDays);
    }
    await writes.patchFields(rec.id, patch);
  }

  async function schedule(rec: ViewRecord, e: React.MouseEvent) {
    if (!canEdit || !editable(startField)) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const day = addDays(range.min, Math.floor((e.clientX - rect.left) / px));
    const patch: Record<string, unknown> = { [startField!.id]: dateValueFor(startField!, day) };
    if (endField && editable(endField)) patch[endField.id] = dateValueFor(endField, addDays(day, scale === "day" ? 0 : 2));
    await writes.patchFields(rec.id, patch);
  }

  async function add() {
    const today = startOfDay(new Date());
    const fields: Record<string, unknown> = {};
    if (startField && editable(startField)) fields[startField.id] = dateValueFor(startField, today);
    if (endField && editable(endField)) fields[endField.id] = dateValueFor(endField, addDays(today, 3));
    const rec = await writes.create(fields);
    if (rec) onOpenRecord(rec.id);
  }

  return (
    <div className={styles.timeline}>
      {writes.error ? <div className={styles.toastError}>{writes.error}</div> : null}
      <div className={styles.calHeader}>
        <div className={styles.calNav}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => {
              if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayX - 120);
            }}
          >
            Today
          </button>
          {canEdit ? (
            <button type="button" className={styles.secondaryBtn} onClick={() => void add()}>
              + Add record
            </button>
          ) : null}
          {isLoading ? <span className={styles.muted}>Loading…</span> : null}
          {!endField ? <span className={styles.muted}>Tip: choose an end date field in Settings to show ranges.</span> : null}
        </div>
        <div className={styles.segmented} role="radiogroup" aria-label="Timeline scale">
          {(["day", "week", "month"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scale === s}
              className={scale === s ? styles.segOn : styles.seg}
              onClick={() => update({ timeline: { ...t, scale: s } })}
            >
              {s[0]!.toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.tlBody}>
        <div className={styles.tlLabels}>
          <div className={styles.tlLabelsHead}>{table.name}</div>
          {rows.map((row) =>
            row.kind === "group" ? (
              <button
                key={row.key}
                type="button"
                className={styles.tlGroupLabel}
                style={{ paddingLeft: 8 + row.depth * 14, height: ROW_H }}
                onClick={() =>
                  setCollapsed((s) => {
                    const n = new Set(s);
                    if (n.has(row.key)) n.delete(row.key);
                    else n.add(row.key);
                    return n;
                  })
                }
              >
                <span className={styles.listChevronIcon} data-open={collapsed.has(row.key) ? "false" : "true"}>
                  ▸
                </span>
                <span className={styles.ellipsis}>{row.label}</span>
                <span className={styles.stackCount}>{row.count}</span>
              </button>
            ) : (
              <button
                key={row.key}
                type="button"
                className={styles.tlLabel}
                style={{ height: ROW_H }}
                onClick={() => onOpenRecord(row.record.id)}
              >
                <span className={styles.ellipsis}>{primaryText(table, row.record) || "Unnamed record"}</span>
                {!row.start ? <span className={styles.tlUnscheduled}>unscheduled</span> : null}
              </button>
            ),
          )}
        </div>
        <div className={styles.tlScroll} ref={scrollRef}>
          <div className={styles.tlCanvas} style={{ width }}>
            <div className={styles.tlHead}>
              {months.map((m) => (
                <span key={m.x} className={styles.tlMonth} style={{ left: m.x }}>
                  {m.label}
                </span>
              ))}
              {ticks.map((tk) => (
                <span
                  key={tk.x}
                  className={tk.major ? styles.tlTickMajor : styles.tlTick}
                  style={{ left: tk.x }}
                >
                  {tk.label}
                </span>
              ))}
            </div>
            <div className={styles.tlRows} onPointerMove={onPointerMove} onPointerUp={() => void onPointerUp()}>
              {ticks.map((tk) => (
                <div key={tk.x} className={styles.tlGridLine} style={{ left: tk.x }} />
              ))}
              {todayX >= 0 && todayX <= width ? <div className={styles.tlToday} style={{ left: todayX }} /> : null}
              {rows.map((row) => {
                if (row.kind === "group") {
                  const c = row.color ? colorOf(row.color) : null;
                  return (
                    <div
                      key={row.key}
                      className={styles.tlGroupRow}
                      style={{ height: ROW_H, ...(c ? { background: `${c.bg}55` } : {}) }}
                    />
                  );
                }
                const rec = row.record;
                if (!row.start || !row.end) {
                  return (
                    <div
                      key={row.key}
                      className={styles.tlRow}
                      style={{ height: ROW_H }}
                      title={canEdit ? "Double-click to schedule" : undefined}
                      onDoubleClick={(e) => void schedule(rec, e)}
                    />
                  );
                }
                const isDrag = drag?.recordId === rec.id;
                const dd = isDrag ? drag!.deltaDays : 0;
                const s = isDrag && (drag!.mode === "move" || drag!.mode === "start") ? addDays(row.start, dd) : row.start;
                const e = isDrag && (drag!.mode === "move" || drag!.mode === "end") ? addDays(row.end, dd) : row.end;
                const left = dayDiff(s, range.min) * px;
                const w = Math.max(px, (dayDiff(e, s) + 1) * px);
                const color = recordColor(config, rec, table.fields) ?? "#cfdfff";
                return (
                  <div key={row.key} className={styles.tlRow} style={{ height: ROW_H }}>
                    <div
                      className={`${styles.tlBar} ${isDrag ? styles.tlBarDragging : ""}`}
                      style={{ left, width: w, background: color }}
                      data-record-id={rec.id}
                      data-start={ymd(s)}
                      title={`${primaryText(table, rec)} · ${ymd(s)} → ${ymd(e)}`}
                      onPointerDown={(ev) => onPointerDown(ev, rec.id, "move")}
                    >
                      {canEdit && editable(startField) ? (
                        <span
                          className={styles.tlHandleL}
                          onPointerDown={(ev) => onPointerDown(ev, rec.id, "start")}
                        />
                      ) : null}
                      <span className={styles.tlBarLabel}>{primaryText(table, rec) || "Unnamed record"}</span>
                      {canEdit && editable(endField) ? (
                        <span
                          className={styles.tlHandleR}
                          onPointerDown={(ev) => onPointerDown(ev, rec.id, "end")}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
