/**
 * Location picker — GPS + search via Nominatim.
 */

import { setLocationQuery } from "./url";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
let searchInput: HTMLInputElement | null = null;
let resultsList: HTMLElement | null = null;
let onLocationChange: ((lat: number, lng: number) => void) | null = null;
let debounceTimer: number | null = null;

export function initLocation(callback: (lat: number, lng: number) => void): void {
  onLocationChange = callback;

  const label = document.getElementById("location-label")!;
  const header = document.getElementById("header")!;

  // Search button or label click → show search input.
  document.getElementById("btn-search")!.addEventListener("click", (e) => {
    e.stopPropagation();
    showSearch(header, label);
  });
  label.addEventListener("click", (e) => {
    e.stopPropagation();
    showSearch(header, label);
  });

  // GPS button.
  document.getElementById("btn-locate")!.addEventListener("click", requestGPS);
}

function requestGPS(): void {
  const label = document.getElementById("location-label")!;

  if (!navigator.geolocation) return;

  label.textContent = "Locating...";

  const previousLabel = label.textContent;

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
      // Silently restore — don't show an error, just keep current location.
      label.textContent = previousLabel;
    },
    { timeout: 8000, maximumAge: 60000 },
  );
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14`;
    const resp = await fetch(url, { headers: { "User-Agent": "SunnyPint/0.1" } });
    const data = await resp.json();
    const addr = data.address;
    return addr?.city || addr?.town || addr?.village || addr?.suburb || `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  } catch {
    return `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  }
}

function showSearch(header: HTMLElement, label: HTMLSpanElement): void {
  if (searchInput) {
    searchInput.focus();
    return;
  }

  // Hide label + search button, show search input.
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
  label.parentElement!.insertBefore(wrapper, label.nextSibling);

  searchInput.focus();

  // Search on input (debounced).
  searchInput.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      const q = searchInput!.value.trim();
      if (q.length >= 2) search(q);
      else clearResults();
    }, 300);
  });

  // Close on escape.
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearch(label);
  });

  // Close on click outside.
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
    const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { "User-Agent": "SunnyPint/0.1" },
    });
    const results = await resp.json();
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
      const label = document.getElementById("location-label")!;
      label.textContent = `Pubs near ${shortName}`;
      setLocationQuery(shortName);
      closeSearch(label);
      onLocationChange?.(lat, lng);
    });
    resultsList.appendChild(li);
  }
}

function clearResults(): void {
  if (resultsList) resultsList.innerHTML = "";
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
}
