/**
 * Opening hours parsing using opening_hours.js.
 *
 * Wraps the OSM opening_hours format library and exposes a single
 * `parseHours` function that returns the current open/closed status, the
 * next state change time, and a weekly table for display.
 */

import opening_hours from "opening_hours";

/** Parsed opening hours information for display. */
export interface HoursStatus {
  isOpen: boolean;
  nextChangeLabel: string;
  statusLabel: "Open" | "Closed";
  weeklyTable: WeekRow[] | null;
}

/** A single row in the weekly hours table. */
export interface WeekRow {
  day: string;
  hours: string;
  isToday: boolean;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatRelative(now: Date, target: Date): string {
  const diffMin = Math.round((target.getTime() - now.getTime()) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Parse an OSM opening_hours string and return a structured status.
 *
 * Returns `null` if the input is empty or fails to parse — the caller should
 * fall back to displaying the raw string.
 */
export function parseHours(raw: string | undefined): HoursStatus | null {
  if (!raw) return null;

  try {
    // The library accepts (value, nominatimObject, optional_conf) but the
    // typings require all conf fields. Use single-arg form.
    const oh = new opening_hours(raw);
    const now = new Date();
    const isOpen = oh.getState(now);
    const nextChange = oh.getNextChange(now);

    let nextChangeLabel = "";
    if (nextChange) {
      const verb = isOpen ? "closes" : "opens";
      nextChangeLabel = `${verb} ${formatTime(nextChange)} (${formatRelative(now, nextChange)})`;
    }

    let weeklyTable: WeekRow[] | null = null;
    if (oh.isWeekStable()) {
      const todayIdx = now.getDay();
      weeklyTable = [];
      for (let d = 0; d < 7; d++) {
        const dayIdx = (d + 1) % 7; // Mon..Sun
        const dayStart = new Date(now);
        dayStart.setDate(now.getDate() - todayIdx + dayIdx);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayStart.getDate() + 1);

        const intervals = oh.getOpenIntervals(dayStart, dayEnd);
        let hours = "Closed";
        if (intervals.length > 0) {
          hours = intervals
            .map((iv) => `${formatTime(iv[0])}\u2013${formatTime(iv[1])}`)
            .join(", ");
        }

        weeklyTable.push({
          day: DAY_LABELS[dayIdx] ?? "",
          hours,
          isToday: dayIdx === todayIdx,
        });
      }
    }

    return {
      isOpen,
      nextChangeLabel,
      statusLabel: isOpen ? "Open" : "Closed",
      weeklyTable,
    };
  } catch {
    return null;
  }
}
