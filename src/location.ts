/**
 * Location picker — modal overlay with GPS + Nominatim search.
 *
 * The header shows a single tappable location button. Clicking it opens an
 * overlay with a "Use my location" button and a search input. Both update
 * the active location via the `onLocationChange` callback.
 */

import {
  GPS_MAX_AGE_MS,
  GPS_TIMEOUT_MS,
  NOMINATIM_URL,
  SEARCH_DEBOUNCE_MS,
  USER_AGENT,
} from "./config";
import { setLocationQuery } from "./url";

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
}

let onLocationChange: ((lat: number, lng: number) => void) | null = null;
let debounceTimer: number | null = null;

/** Initialise the location picker overlay. */
export function initLocation(callback: (lat: number, lng: number) => void): void {
  onLocationChange = callback;

  const button = document.getElementById("btn-location");
  const overlay = document.getElementById("location-overlay");
  if (!button || !overlay) return;

  const closeBtn = overlay.querySelector(".location-overlay-close");
  const backdrop = overlay.querySelector(".location-overlay-backdrop");
  const gpsBtn = document.getElementById("btn-locate");
  const searchInput = document.getElementById("location-search-input") as HTMLInputElement | null;
  const resultsList = document.getElementById("location-search-results") as HTMLUListElement | null;

  function open(): void {
    overlay!.hidden = false;
    setTimeout(() => searchInput?.focus(), 50);
  }

  function close(): void {
    overlay!.hidden = true;
    if (searchInput) searchInput.value = "";
    if (resultsList) resultsList.innerHTML = "";
  }

  button.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) close();
  });

  gpsBtn?.addEventListener("click", () => {
    requestGPS();
    close();
  });

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        const q = searchInput.value.trim();
        if (q.length >= 2) search(q, resultsList, close);
        else if (resultsList) resultsList.innerHTML = "";
      }, SEARCH_DEBOUNCE_MS);
    });
  }
}

/**
 * Trigger the browser's GPS prompt, reverse-geocode the result, and route
 * it through the location callback registered in `initLocation`. Exported
 * so the welcome modal can drive the same flow without duplicating the
 * Nominatim + label-update plumbing.
 */
export function requestGPSLocation(): void {
  requestGPS();
}

function requestGPS(): void {
  const label = document.getElementById("location-label");
  if (!label || !navigator.geolocation) return;

  const previousLabel = label.textContent;
  label.textContent = "Locating...";

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      reverseGeocode(latitude, longitude).then((name) => {
        label.textContent = name;
        setLocationQuery(name);
        onLocationChange?.(latitude, longitude);
      });
    },
    () => {
      label.textContent = previousLabel;
    },
    { timeout: GPS_TIMEOUT_MS, maximumAge: GPS_MAX_AGE_MS },
  );
}

/**
 * Reverse-geocode a coordinate to a friendly place name.
 *
 * Prefers more-specific names: suburb/neighbourhood/quarter first, then
 * village/town/city. Combines them with a comma when both exist so users
 * see "Eaton, Norwich" rather than just "Norwich".
 */
async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const url = `${NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16`;
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const data = (await resp.json()) as { address?: Record<string, string> };
    const addr = data.address;
    if (!addr) return `${lat.toFixed(3)}, ${lng.toFixed(3)}`;

    const local =
      addr.neighbourhood || addr.suburb || addr.quarter || addr.hamlet || addr.city_district;
    const main = addr.city || addr.town || addr.village || addr.municipality;

    if (local && main && local !== main) return `${local}, ${main}`;
    return local || main || `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  } catch {
    return `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  }
}

async function search(
  query: string,
  resultsList: HTMLUListElement | null,
  close: () => void,
): Promise<void> {
  if (!resultsList) return;
  try {
    const params = new URLSearchParams({
      q: query,
      format: "json",
      countrycodes: "gb",
      limit: "5",
      addressdetails: "1",
    });
    const resp = await fetch(`${NOMINATIM_URL}/search?${params}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    const results = (await resp.json()) as NominatimResult[];
    showResults(results, resultsList, close);
  } catch {
    resultsList.innerHTML = "";
  }
}

function showResults(
  results: NominatimResult[],
  resultsList: HTMLUListElement,
  close: () => void,
): void {
  resultsList.innerHTML = "";

  if (results.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No results found";
    li.className = "no-results";
    resultsList.appendChild(li);
    return;
  }

  for (const r of results) {
    const li = document.createElement("li");
    li.textContent = r.display_name.split(",").slice(0, 3).join(", ");
    li.addEventListener("click", () => {
      const lat = parseFloat(r.lat);
      const lng = parseFloat(r.lon);
      const shortName = r.display_name.split(",").slice(0, 2).join(", ");
      const label = document.getElementById("location-label");
      if (label) label.textContent = shortName;
      setLocationQuery(shortName);
      close();
      onLocationChange?.(lat, lng);
    });
    resultsList.appendChild(li);
  }
}
