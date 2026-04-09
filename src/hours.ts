/**
 * Opening hours parsing and display using opening_hours.js.
 */

import opening_hours from "opening_hours";

export interface HoursStatus {
  isOpen: boolean;
  nextChange: Date | undefined;
  nextChangeLabel: string; // "closes 23:00" or "opens 12:00"
  statusLabel: string; // "Open" or "Closed"
  weeklyTable: WeekRow[] | null; // null if not week-stable or parse fails
  prettified: string; // cleaned up string
}

export interface WeekRow {
  day: string; // "Mo", "Tu", etc.
  hours: string; // "11:00–23:00" or "Closed"
  isToday: boolean;
}

const DAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatRelative(now: Date, target: Date): string {
  const diffMs = target.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function parseHours(raw: string | undefined): HoursStatus | null {
  if (!raw) return null;

  try {
    const oh = new opening_hours(raw, undefined, { locale: "en" });
    const now = new Date();
    const isOpen = oh.getState(now);
    const nextChange = oh.getNextChange(now);

    let nextChangeLabel = "";
    if (nextChange) {
      const verb = isOpen ? "closes" : "opens";
      nextChangeLabel = `${verb} ${formatTime(nextChange)} (${formatRelative(now, nextChange)})`;
    }

    // Weekly table.
    let weeklyTable: WeekRow[] | null = null;
    if (oh.isWeekStable()) {
      const todayIdx = now.getDay(); // 0=Sun
      weeklyTable = [];

      // Get intervals for each day of the current week.
      for (let d = 0; d < 7; d++) {
        // Start from Monday (d=1) through Sunday (d=0).
        const dayIdx = (d + 1) % 7; // 1,2,3,4,5,6,0 = Mo-Su
        const dayStart = new Date(now);
        dayStart.setDate(now.getDate() - todayIdx + dayIdx);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayStart.getDate() + 1);

        const intervals = oh.getOpenIntervals(dayStart, dayEnd);
        let hours = "Closed";
        if (intervals.length > 0) {
          hours = intervals
            .map((iv: [Date, Date]) => `${formatTime(iv[0])}\u2013${formatTime(iv[1])}`)
            .join(", ");
        }

        weeklyTable.push({
          day: DAY_LABELS[(d + 1) % 7]!,
          hours,
          isToday: dayIdx === todayIdx,
        });
      }
    }

    let prettified = raw;
    try {
      prettified = oh.prettifyValue();
    } catch {
      // fall back to raw
    }

    return { isOpen, nextChange, nextChangeLabel, statusLabel: isOpen ? "Open" : "Closed", weeklyTable, prettified };
  } catch {
    // Parse failed — return null, caller shows raw string.
    return null;
  }
}
