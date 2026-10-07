import type { ScheduleConfig } from "./types.js";

/** Offset (ms) of `timeZone` at instant `date`: local = utc + offset. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]) % 24,
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function safeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Local wall-clock (in `tz`) → UTC instant. */
function zoned(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m, d, hh, mm, 0);
  let off = tzOffsetMs(new Date(guess), tz);
  let t = guess - off;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off) {
    off = off2;
    t = guess - off;
  }
  return new Date(t);
}

/** Local calendar parts of `date` in `tz`. */
function localParts(date: Date, tz: string): { y: number; m: number; d: number; dow: number } {
  const local = new Date(date.getTime() + tzOffsetMs(date, tz));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(), dow: local.getUTCDay() };
}

/** Next fire time strictly after `after`. */
export function nextScheduledRun(schedule: ScheduleConfig, after: Date): Date {
  const tz = safeZone(schedule.timeZone);
  switch (schedule.interval) {
    case "minutes": {
      const every = Math.max(1, schedule.every ?? 15);
      const ms = every * 60_000;
      return new Date(Math.floor(after.getTime() / ms) * ms + ms);
    }
    case "hourly": {
      const minute = schedule.minute ?? 0;
      const t = new Date(after);
      t.setUTCSeconds(0, 0);
      t.setUTCMinutes(minute);
      if (t.getTime() <= after.getTime()) t.setUTCHours(t.getUTCHours() + 1);
      return t;
    }
    case "daily":
    case "weekly": {
      const [hh, mm] = (schedule.time ?? "09:00").split(":").map(Number) as [number, number];
      const p = localParts(after, tz);
      for (let i = 0; i < 9; i++) {
        const cand = zoned(p.y, p.m, p.d + i, hh, mm, tz);
        if (cand.getTime() <= after.getTime()) continue;
        if (schedule.interval === "weekly") {
          const lp = localParts(cand, tz);
          if (lp.dow !== (schedule.weekday ?? 1)) continue;
        }
        return cand;
      }
      return new Date(after.getTime() + 24 * 3600_000);
    }
    default:
      return new Date(after.getTime() + 3600_000);
  }
}
