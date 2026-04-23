/**
 * Location picker — modal overlay with GPS + Photon search.
 *
 * The header shows a single tappable location button. Clicking it opens an
 * overlay with a "Use my location" button and a search input. Both update
 * the active location via the `onLocationChange` callback.
 *
 * Uses Photon (Komoot-hosted) rather than Nominatim because Nominatim's
 * usage policy bans client-side autocomplete.
 */

import {
  GPS_MAX_AGE_MS,
  GPS_TIMEOUT_MS,
  MIN_SEARCH_CHARS,
  PHOTON_URL,
  SEARCH_DEBOUNCE_MS,
} from "./config";
import { setLocationQuery } from "./url";

/** Photon GeoJSON Feature — flat subset of the fields we care about. */
interface PhotonFeature {
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    postcode?: string;
    city?: string;
    district?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    osm_key?: string;
    osm_value?: string;
  };
}

interface PhotonResponse {
  type: "FeatureCollection";
  features: PhotonFeature[];
}

/** Compose a human-readable label from a Photon feature. Prefers the most
 *  specific identifier first (housenumber+street, then name, then city)
 *  and dedupes repeated locality fields. */
function formatLabel(f: PhotonFeature, maxParts = 3): string {
  const p = f.properties;
  const parts: string[] = [];
  const push = (s: string | undefined) => {
    if (s && !parts.includes(s)) parts.push(s);
  };

  if (p.housenumber && p.street) push(`${p.housenumber} ${p.street}`);
  else if (p.street) push(p.street);
  else if (p.name) push(p.name);

  push(p.city);
  push(p.district);
  push(p.state);

  return parts.slice(0, maxParts).join(", ") || "Unknown location";
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
        if (q.length >= MIN_SEARCH_CHARS) search(q, resultsList, close);
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
 * Reverse-geocode a coordinate to a friendly place name via Photon.
 * Returns "Eaton, Norwich" style — the most specific locality we know.
 */
async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const url = `${PHOTON_URL}/reverse?lat=${lat}&lon=${lng}&lang=en&limit=1`;
    const resp = await fetch(url);
    const data = (await resp.json()) as PhotonResponse;
    const first = data.features[0];
    if (!first) return `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    return formatLabel(first, 2);
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
      limit: "5",
      lang: "en",
      // countrycode in Photon is an ISO 3166 alpha-2 code (lowercase).
      // Restricts to GB so users don't get US/Canadian places with the
      // same name as a UK one.
      countrycode: "gb",
    });
    const resp = await fetch(`${PHOTON_URL}/api/?${params}`);
    const data = (await resp.json()) as PhotonResponse;
    showResults(data.features, resultsList, close);
  } catch {
    resultsList.innerHTML = "";
  }
}

function showResults(
  results: PhotonFeature[],
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
    li.textContent = formatLabel(r, 3);
    li.addEventListener("click", () => {
      // Photon returns geometry as [lon, lat] — note the ordering.
      const [lng, lat] = r.geometry.coordinates;
      const shortName = formatLabel(r, 2);
      const label = document.getElementById("location-label");
      if (label) label.textContent = shortName;
      setLocationQuery(shortName);
      close();
      onLocationChange?.(lat, lng);
    });
    resultsList.appendChild(li);
  }
}
