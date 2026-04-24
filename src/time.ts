/**
 * UK wall-clock helpers.
 *
 * All pubs on the site are in the UK, so "noon", "now", and the scrubber's
 * chosen minute-of-day always mean Europe/London regardless of where the
 * user's browser thinks it is. `Date.setHours/setMinutes` uses local time
 * and would put the sun in the wrong place for non-UK visitors.
 */

const UK_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface UkParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function ukParts(d: Date): UkParts {
  const parts = UK_FORMATTER.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

/** Minutes-past-midnight in UK wall-clock for the given instant. */
export function ukTimeMins(d: Date): number {
  const p = ukParts(d);
  return p.h * 60 + p.mi;
}

/** Year/month/day of the given instant as seen in UK wall-clock. */
export function ukCalendarDay(d: Date): { y: number; m: number; d: number } {
  const p = ukParts(d);
  return { y: p.y, m: p.mo, d: p.d };
}

/** Build a Date representing UK wall-clock Y-M-D (from `cal`'s UK calendar day)
 *  at `mins` minutes past midnight. Correct across BST/GMT. */
export function ukDateAt(cal: Date, mins: number): Date {
  const p = ukParts(cal);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const utcMs = Date.UTC(p.y, p.mo - 1, p.d, h, m, 0);
  const uk = ukParts(new Date(utcMs));
  const ukMs = Date.UTC(uk.y, uk.mo - 1, uk.d, uk.h, uk.mi, uk.s);
  const offset = ukMs - utcMs;
  return new Date(utcMs - offset);
}
