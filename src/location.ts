/**
 * Location picker — GPS + Nominatim search.
 *
 * Provides three ways to set the active location:
 *  1. The "Locate me" button → browser geolocation
 *  2. Tapping the location label or search button → text search via Nominatim
 *  3. Direct call from `main.ts` for URL-restored locations
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

let searchInput: HTMLInputElement | null = null;
let resultsList: HTMLElement | null = null;
let onLocationChange: ((lat: number, lng: number) => void) | null = null;
let debounceTimer: number | null = null;

/** Initialise the location picker. */
export function initLocation(callback: (lat: number, lng: number) => void): void {
  onLocationChange = callback;

  const label = document.getElementById("location-label");
  const header = document.getElementById("header");
  const searchBtn = document.getElementById("btn-search");
  const locateBtn = document.getElementById("btn-locate");
  if (!label || !header || !searchBtn || !locateBtn) return;

  searchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showSearch(label as HTMLSpanElement);
  });
  label.addEventListener("click", (e) => {
    e.stopPropagation();
    showSearch(label as HTMLSpanElement);
  });
  locateBtn.addEventListener("click", requestGPS);
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
        label.textContent = `Pubs near ${name}`;
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

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const url = `${NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14`;
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const data = (await resp.json()) as { address?: Record<string, string> };
    const addr = data.address;
    return (
      addr?.city ||
      addr?.town ||
      addr?.village ||
      addr?.suburb ||
      `${lat.toFixed(3)}, ${lng.toFixed(3)}`
    );
  } catch {
    return `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  }
}

function showSearch(label: HTMLSpanElement): void {
  if (searchInput) {
    searchInput.focus();
    return;
  }

  label.style.display = "none";
  const searchBtn = document.getElementById("btn-search");
  if (searchBtn) searchBtn.style.display = "none";

  const wrapper = document.createElement("div");
  wrapper.id = "location-search";

  searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Postcode, address, or place...";
  searchInput.autofocus = true;

  resultsList = document.createElement("ul");
  resultsList.id = "location-results";

  wrapper.appendChild(searchInput);
  wrapper.appendChild(resultsList);
  label.parentElement?.insertBefore(wrapper, label.nextSibling);

  searchInput.focus();

  searchInput.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      const q = searchInput?.value.trim() ?? "";
      if (q.length >= 2) search(q);
      else clearResults();
    }, SEARCH_DEBOUNCE_MS);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearch(label);
  });

  setTimeout(() => {
    document.addEventListener("click", function handler(e) {
      if (!wrapper.contains(e.target as Node)) {
        closeSearch(label);
        document.removeEventListener("click", handler);
      }
    });
  }, 100);
}

function closeSearch(label: HTMLSpanElement): void {
  const wrapper = document.getElementById("location-search");
  if (wrapper) wrapper.remove();
  searchInput = null;
  resultsList = null;
  label.style.display = "";
  const searchBtn = document.getElementById("btn-search");
  if (searchBtn) searchBtn.style.display = "";
}

async function search(query: string): Promise<void> {
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
    showResults(results);
  } catch {
    clearResults();
  }
}

function showResults(results: NominatimResult[]): void {
  if (!resultsList) return;
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
      if (label) {
        label.textContent = `Pubs near ${shortName}`;
        setLocationQuery(shortName);
        closeSearch(label as HTMLSpanElement);
      }
      onLocationChange?.(lat, lng);
    });
    resultsList.appendChild(li);
  }
}

function clearResults(): void {
  if (resultsList) resultsList.innerHTML = "";
}
