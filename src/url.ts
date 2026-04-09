/**
 * URL state — sync app state to/from URL query params.
 *
 * Params:
 *   q       — search term / location name (e.g. "Silver Road, Norwich")
 *   pub     — selected pub ID
 *   t       — time in minutes (0-1440)
 *   d       — date (YYYY-MM-DD), omitted if today
 *   lat,lng — fallback if no search term
 */

import { state } from "./state";

// Track the current location label for URL serialisation.
let currentLocationQuery = "";

export function setLocationQuery(q: string): void {
  currentLocationQuery = q;
}

export function getLocationQuery(): string {
  return currentLocationQuery;
}

export interface URLState {
  query?: string;
  lat?: number;
  lng?: number;
  pubId?: string;
  time?: number;
  date?: Date;
}

/** Read state from current URL on page load. */
export function readURL(): URLState {
  const params = new URLSearchParams(window.location.search);
  const result: URLState = {};

  const q = params.get("q");
  if (q) result.query = q;

  const lat = params.get("lat");
  const lng = params.get("lng");
  if (lat && lng) {
    result.lat = parseFloat(lat);
    result.lng = parseFloat(lng);
  }

  const pub = params.get("pub");
  if (pub) result.pubId = pub;

  const t = params.get("t");
  if (t) {
    const time = parseInt(t, 10);
    if (Number.isFinite(time)) result.time = time;
  }

  const d = params.get("d");
  if (d) {
    const [y, m, day] = d.split("-").map((s) => parseInt(s, 10));
    if (
      y != null &&
      m != null &&
      day != null &&
      Number.isFinite(y) &&
      Number.isFinite(m) &&
      Number.isFinite(day)
    ) {
      result.date = new Date(y, m - 1, day);
    }
  }

  return result;
}

/** Update URL to reflect current state. */
export function writeURL(): void {
  const params = new URLSearchParams();

  if (currentLocationQuery) {
    params.set("q", currentLocationQuery);
  } else if (state.userLat != null && state.userLng != null) {
    params.set("lat", state.userLat.toFixed(4));
    params.set("lng", state.userLng.toFixed(4));
  }

  if (state.selectedPubId) {
    params.set("pub", state.selectedPubId);
  }

  params.set("t", String(Math.round(state.timeMins)));

  const now = new Date();
  if (
    state.date.getFullYear() !== now.getFullYear() ||
    state.date.getMonth() !== now.getMonth() ||
    state.date.getDate() !== now.getDate()
  ) {
    const y = state.date.getFullYear();
    const m = String(state.date.getMonth() + 1).padStart(2, "0");
    const d = String(state.date.getDate()).padStart(2, "0");
    params.set("d", `${y}-${m}-${d}`);
  }

  const str = params.toString();
  const url = str ? `${window.location.pathname}?${str}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

/** Debounced URL update — don't hammer history during scrubbing. */
let writeTimer: number | null = null;

export function writeURLDebounced(): void {
  if (writeTimer != null) clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    writeURL();
  }, 300);
}
