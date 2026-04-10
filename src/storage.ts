/**
 * localStorage persistence for the app.
 *
 * Today this is just the user's last-known location and the welcome-modal
 * dismissal flag. Centralised here so the try/catch boilerplate (private
 * browsing, storage quota, etc.) lives in one place and feature flags can
 * be added without scattering localStorage references through the codebase.
 */

const LOCATION_KEY = "sunny-pint:location";
const WELCOME_DISMISSED_KEY = "sunny-pint:welcome-dismissed";
const SATELLITE_KEY = "sunny-pint:satellite";
const ZOOM_KEY = "sunny-pint:zoom";

/** How a saved location was originally chosen. Used to decide whether to
 *  show the welcome modal again or override silently. */
export type LocationSource = "gps" | "search" | "city";

export interface SavedLocation {
  lat: number;
  lng: number;
  /** Display label like "Norwich" or "Stoke Newington, London". */
  label: string;
  source: LocationSource;
  /** Unix ms — used to age out very old entries (>30d). */
  savedAt: number;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Read the saved location, or null if none / stale / parse error / no
 *  storage. Stale entries (older than 30 days) are dropped on read so a
 *  one-time tourist hit doesn't anchor someone forever. */
export function loadLocation(): SavedLocation | null {
  try {
    const raw = localStorage.getItem(LOCATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedLocation>;
    if (
      typeof parsed.lat !== "number" ||
      typeof parsed.lng !== "number" ||
      typeof parsed.label !== "string" ||
      typeof parsed.savedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(LOCATION_KEY);
      return null;
    }
    return {
      lat: parsed.lat,
      lng: parsed.lng,
      label: parsed.label,
      source: (parsed.source as LocationSource) ?? "search",
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

/** Persist a location chosen by the user. Failures (private browsing,
 *  quota exceeded) are swallowed silently — persistence is best-effort. */
export function saveLocation(loc: Omit<SavedLocation, "savedAt">): void {
  try {
    const payload: SavedLocation = { ...loc, savedAt: Date.now() };
    localStorage.setItem(LOCATION_KEY, JSON.stringify(payload));
  } catch {
    // Storage unavailable — fall through. The session will still work.
  }
}

/** Clear any saved location. Currently unused but useful for debugging. */
export function clearLocation(): void {
  try {
    localStorage.removeItem(LOCATION_KEY);
  } catch {
    // Ignore.
  }
}

/** Has the user already seen and dismissed the welcome modal? */
export function isWelcomeDismissed(): boolean {
  try {
    return localStorage.getItem(WELCOME_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mark the welcome modal as dismissed — never show it again. */
export function markWelcomeDismissed(): void {
  try {
    localStorage.setItem(WELCOME_DISMISSED_KEY, "1");
  } catch {
    // Ignore.
  }
}

// ── Satellite mode ──────────────────────────────────────────────────

export function loadSatelliteMode(): boolean {
  try {
    return localStorage.getItem(SATELLITE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSatelliteMode(on: boolean): void {
  try {
    localStorage.setItem(SATELLITE_KEY, on ? "1" : "0");
  } catch {
    // Ignore.
  }
}

// ── Zoom level ──────────────────────────────────────────────────────

export type ZoomStep = 1 | 2 | 4;

export function loadZoomLevel(): ZoomStep {
  try {
    const v = parseInt(localStorage.getItem(ZOOM_KEY) ?? "1", 10);
    if (v === 2 || v === 4) return v;
    return 1;
  } catch {
    return 1;
  }
}

export function saveZoomLevel(z: ZoomStep): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(z));
  } catch {
    // Ignore.
  }
}
