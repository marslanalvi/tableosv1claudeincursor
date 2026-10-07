import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ViewRecord } from "../../lib/api-areas/views.ts";
import { useRecordWrites, useViewRecords, type ViewComponentProps } from "./view-hooks.ts";
import {
  addDays,
  dateValueFor,
  dayDiff,
  parseDateValue,
  primaryText,
  recordColor,
  shiftDateValue,
  startOfDay,
  ymd,
} from "./view-utils.ts";
import { RecordsStatus, statusProps } from "./RecordsStatus.tsx";
import styles from "./views.module.css";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface CalEvent {
  record: ViewRecord;
  start: Date;
  end: Date;
}

/** One week row's slice of an event. */
interface Segment {
  ev: CalEvent;
  col: number;
  span: number;
  lane: number;
  contLeft: boolean;
  contRight: boolean;
}

export function CalendarView(props: ViewComponentProps) {
  const { baseId, table, view, config, update, canEdit, search, onOpenRecord, onCount } = props;
  const cal = config.calendar ?? { dateFieldId: null };
  const dateField = table.fields.find((f) => f.id === cal.dateFieldId);
  const endField = table.fields.find((f) => f.id === cal.endDateFieldId);
  const mode = cal.mode ?? "month";
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const recordsQuery = useViewRecords(baseId, table, view?.id, config, search);
  const { records, queryKey, isLoading } = recordsQuery;
  const writes = useRecordWrites(baseId, table.id, queryKey);
  /** `offset`: days between the event's start and the day the bar was grabbed on. */
  const [drag, setDrag] = useState<{ id: string; offset: number } | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  /** Bars stop taking pointer events while moving, so drops reach the day cells under them. */
  const [moving, setMoving] = useState(false);
  const [resize, setResize] = useState<{ id: string; end: Date } | null>(null);
  const editableDate = Boolean(dateField && (dateField.type === "date" || dateField.type === "datetime"));
  const editableEnd = Boolean(endField && (endField.type === "date" || endField.type === "datetime"));

  const events: CalEvent[] = useMemo(() => {
    if (!dateField) return [];
    const out: CalEvent[] = [];
    for (const r of records) {
      const start = parseDateValue(r.fields[dateField.id]);
      if (!start) continue;
      let end = endField ? parseDateValue(r.fields[endField.id]) : null;
      if (!end || end < start) end = start;
      out.push({ record: r, start: startOfDay(start), end: startOfDay(end) });
    }
    return out;
  }, [records, dateField, endField]);

  useEffect(() => onCount?.(events.length), [events.length, onCount]);

  const days: Date[] = useMemo(() => {
    if (mode === "week") {
      const s = addDays(cursor, -cursor.getDay());
      return Array.from({ length: 7 }, (_, i) => addDays(s, i));
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const s = addDays(first, -first.getDay());
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const weeks = Math.ceil((dayDiff(last, s) + 1) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(s, i));
  }, [cursor, mode]);

  const shown: CalEvent[] = useMemo(
    () =>
      resize
        ? events.map((ev) => (ev.record.id === resize.id ? { ...ev, end: resize.end } : ev))
        : events,
    [events, resize],
  );

  const weeks = useMemo(() => {
    const out: { days: Date[]; segments: Segment[]; lanes: number }[] = [];
    for (let w = 0; w < days.length; w += 7) {
      const week = days.slice(w, w + 7);
      const first = week[0]!;
      const last = week[6]!;
      const segs: Segment[] = [];
      for (const ev of shown) {
        if (ev.end < first || ev.start > last) continue;
        const from = ev.start < first ? first : ev.start;
        const to = ev.end > last ? last : ev.end;
        segs.push({
          ev,
          col: dayDiff(from, first),
          span: dayDiff(to, from) + 1,
          lane: 0,
          contLeft: ev.start < first,
          contRight: ev.end > last,
        });
      }
      segs.sort((a, b) => a.col - b.col || b.span - a.span);
      const laneEnds: number[] = [];
      for (const s of segs) {
        let lane = laneEnds.findIndex((end) => end < s.col);
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = s.col + s.span - 1;
        s.lane = lane;
      }
      out.push({ days: week, segments: segs, lanes: laneEnds.length });
    }
    return out;
  }, [days, shown]);

  const dropRange = useMemo(() => {
    if (!drag || !overDay) return null;
    const ev = events.find((e) => e.record.id === drag.id);
    const over = parseDateValue(overDay);
    if (!ev || !over) return null;
    const start = addDays(over, -drag.offset);
    return { start, end: addDays(start, dayDiff(ev.end, ev.start)) };
  }, [drag, overDay, events]);

  if (!dateField) {
    const dates = table.fields.filter((f) => ["date", "datetime", "created_time", "modified_time"].includes(f.type));
    return (
      <div className={styles.emptyState}>
        <h3>Choose a date field for this calendar</h3>
        {dates.length ? (
          <select
            className={styles.select}
            disabled={!canEdit}
            aria-label="Date field"
            value=""
            onChange={(e) => update({ calendar: { ...cal, dateFieldId: e.target.value || null } })}
          >
            <option value="">Choose a field…</option>
            {dates.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          <p>Add a date field to this table to use a calendar view.</p>
        )}
      </div>
    );
  }

  function navigate(dir: -1 | 1) {
    setCursor((c) =>
      mode === "week" ? addDays(c, 7 * dir) : new Date(c.getFullYear(), c.getMonth() + dir, 1),
    );
  }

  async function dropOn(day: Date) {
    const ev = drag ? events.find((e) => e.record.id === drag.id) : undefined;
    const offset = drag?.offset ?? 0;
    setDrag(null);
    setMoving(false);
    setOverDay(null);
    if (!ev || !dateField || !editableDate) return;
    const delta = dayDiff(addDays(day, -offset), ev.start);
    if (delta === 0) return;
    const patch: Record<string, unknown> = {
      [dateField.id]: shiftDateValue(dateField, ev.record.fields[dateField.id], delta),
    };
    if (endField && ev.record.fields[endField.id] && (endField.type === "date" || endField.type === "datetime")) {
      patch[endField.id] = shiftDateValue(endField, ev.record.fields[endField.id], delta);
    }
    await writes.patchFields(ev.record.id, patch);
  }

  function startResize(e: React.PointerEvent, ev: CalEvent) {
    if (!endField || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const field = endField;
    const id = ev.record.id;
    let end = ev.end;
    setResize({ id, end });
    const onMove = (m: PointerEvent) => {
      const cell = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>("[data-day]");
      const hovered = parseDateValue(cell?.dataset.day);
      if (!hovered) return;
      const day = hovered < ev.start ? ev.start : hovered;
      if (dayDiff(day, end) === 0) return;
      end = day;
      setResize({ id, end });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const delta = dayDiff(end, ev.end);
      const stored = ev.record.fields[field.id];
      if (delta !== 0 || !stored) {
        const value = stored ? shiftDateValue(field, stored, delta) : dateValueFor(field, end);
        void writes.patchFields(id, { [field.id]: value });
      }
      setResize(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  async function createOn(day: Date) {
    if (!canEdit || !editableDate) return;
    const rec = await writes.create({ [dateField!.id]: dateValueFor(dateField!, day) });
    if (rec) onOpenRecord(rec.id);
  }

  const title =
    mode === "week"
      ? `${days[0]!.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6]!.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
      : cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const today = ymd(new Date());

  return (
    <div className={styles.calendar}>
      {writes.error ? <div className={styles.toastError}>{writes.error}</div> : null}
      <RecordsStatus {...statusProps(recordsQuery)} isLoading={false} />
      <div className={styles.calHeader}>
        <div className={styles.calNav}>
          <button type="button" className={styles.secondaryBtn} onClick={() => setCursor(startOfDay(new Date()))}>
            Today
          </button>
          <button type="button" className={styles.iconBtnLg} aria-label="Previous" onClick={() => navigate(-1)}>
            ‹
          </button>
          <button type="button" className={styles.iconBtnLg} aria-label="Next" onClick={() => navigate(1)}>
            ›
          </button>
          <h2 className={styles.calTitle}>{title}</h2>
          {isLoading ? <span className={styles.muted}>Loading…</span> : null}
        </div>
        <div className={styles.segmented} role="radiogroup" aria-label="Calendar range">
          {(["week", "month"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? styles.segOn : styles.seg}
              onClick={() => update({ calendar: { ...cal, mode: m } })}
            >
              {m === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.calWeekdays}>
        {WEEKDAYS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div
        className={[
          styles.calGrid,
          mode === "week" ? styles.calGridWeek : "",
          moving || resize ? styles.calBusy : "",
        ].join(" ")}
      >
        {weeks.map((week) => (
          <div
            key={ymd(week.days[0]!)}
            className={styles.calWeek}
            style={{ gridTemplateRows: `30px repeat(${week.lanes}, 24px) minmax(6px, 1fr)` }}
          >
            {week.days.map((day, i) => {
              const key = ymd(day);
              const inMonth = mode === "week" || day.getMonth() === cursor.getMonth();
              const inDrop = dropRange && day >= dropRange.start && day <= dropRange.end;
              return (
                <div
                  key={key}
                  className={[
                    styles.calDay,
                    inMonth ? "" : styles.calDayOut,
                    inDrop ? styles.calDayOver : "",
                  ].join(" ")}
                  style={{ gridColumn: i + 1, gridRow: "1 / -1" }}
                  data-day={key}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    if (overDay !== key) setOverDay(key);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    void dropOn(day);
                  }}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) void createOn(day);
                  }}
                >
                  <div className={styles.calDayHead}>
                    <span className={key === today ? styles.calToday : styles.calDayNum}>{day.getDate()}</span>
                    {canEdit && editableDate ? (
                      <button
                        type="button"
                        className={styles.calAdd}
                        aria-label={`Add record on ${key}`}
                        onClick={() => void createOn(day)}
                      >
                        +
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {week.segments.map((s) => {
              const { ev } = s;
              const color = recordColor(config, ev.record, table.fields);
              const name = primaryText(table, ev.record) || "Unnamed record";
              const style: CSSProperties = {
                gridColumn: `${s.col + 1} / span ${s.span}`,
                gridRow: s.lane + 2,
                ...(color ? { background: color } : {}),
              };
              return (
                <div
                  key={ev.record.id}
                  className={[
                    styles.calBar,
                    s.contLeft ? styles.calBarContL : "",
                    s.contRight ? styles.calBarContR : "",
                    resize?.id === ev.record.id ? styles.calBarResizing : "",
                  ].join(" ")}
                  style={style}
                  data-record-id={ev.record.id}
                  data-start={ymd(ev.start)}
                  data-end={ymd(ev.end)}
                >
                  <button
                    type="button"
                    className={styles.calBarBtn}
                    draggable={canEdit && editableDate}
                    onDragStart={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const grabbed = Math.min(
                        s.span - 1,
                        Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * s.span)),
                      );
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", ev.record.id);
                      setDrag({ id: ev.record.id, offset: dayDiff(week.days[s.col]!, ev.start) + grabbed });
                      // Chrome cancels the drag if the source's styles change during dragstart.
                      window.setTimeout(() => setMoving(true), 0);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setMoving(false);
                      setOverDay(null);
                    }}
                    onClick={() => onOpenRecord(ev.record.id)}
                    title={name}
                  >
                    {name}
                  </button>
                  {canEdit && editableEnd && !s.contRight ? (
                    <span
                      className={styles.calBarHandle}
                      role="separator"
                      aria-label={`Change end date of ${name}`}
                      onPointerDown={(e) => startResize(e, ev)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
