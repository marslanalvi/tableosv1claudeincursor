import { useEffect, useMemo, useState } from "react";
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
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const editableDate = Boolean(dateField && (dateField.type === "date" || dateField.type === "datetime"));

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

  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    const first = days[0]!;
    const last = days[days.length - 1]!;
    for (const ev of events) {
      if (ev.end < first || ev.start > last) continue;
      const from = ev.start < first ? first : ev.start;
      const to = ev.end > last ? last : ev.end;
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const key = ymd(d);
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(ev);
      }
    }
    return m;
  }, [events, days]);

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
    const ev = events.find((e) => e.record.id === dragId);
    setDragId(null);
    setOverDay(null);
    if (!ev || !dateField || !editableDate) return;
    const delta = dayDiff(day, ev.start);
    if (delta === 0) return;
    const patch: Record<string, unknown> = {
      [dateField.id]: shiftDateValue(dateField, ev.record.fields[dateField.id], delta),
    };
    if (endField && ev.record.fields[endField.id] && (endField.type === "date" || endField.type === "datetime")) {
      patch[endField.id] = shiftDateValue(endField, ev.record.fields[endField.id], delta);
    }
    await writes.patchFields(ev.record.id, patch);
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
      <div className={`${styles.calGrid} ${mode === "week" ? styles.calGridWeek : ""}`}>
        {days.map((day) => {
          const key = ymd(day);
          const inMonth = mode === "week" || day.getMonth() === cursor.getMonth();
          const list = eventsByDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={[
                styles.calDay,
                inMonth ? "" : styles.calDayOut,
                overDay === key ? styles.calDayOver : "",
              ].join(" ")}
              data-day={key}
              onDragOver={(e) => {
                if (!dragId) return;
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
              <div className={styles.calEvents}>
                {list.map((ev) => {
                  const color = recordColor(config, ev.record, table.fields);
                  const multi = dayDiff(ev.end, ev.start) > 0;
                  return (
                    <button
                      key={ev.record.id}
                      type="button"
                      className={`${styles.calEvent} ${multi ? styles.calEventRange : ""}`}
                      style={color ? { background: color } : undefined}
                      draggable={canEdit && editableDate}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", ev.record.id);
                        setDragId(ev.record.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverDay(null);
                      }}
                      onClick={() => onOpenRecord(ev.record.id)}
                      title={primaryText(table, ev.record)}
                    >
                      {primaryText(table, ev.record) || "Unnamed record"}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
