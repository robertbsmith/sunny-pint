/**
 * Pub list — search, filter, distance sort, click selection.
 */

import { googleMapsUrl, PUB_LIST_MAX } from "./config";
import { haversineM } from "./geo";
import { parseHours } from "./hours";
import { state } from "./state";
import { smallSunBadgeHtml } from "./sunbadge";
import type { Pub } from "./types";

let listEl: HTMLUListElement;
let searchEl: HTMLInputElement;
let filterOpenEl: HTMLButtonElement;
let filterOpen = false;
let onSelect: ((pub: Pub) => void) | null = null;

type SortMode = "distance" | "sun";

const SORT_STORAGE_KEY = "sunny-pint:sort-mode";

function loadSortMode(): SortMode {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v === "sun" || v === "distance") return v;
  } catch {
    // localStorage may be unavailable in private browsing — fall through.
  }
  return "distance";
}

let sortMode: SortMode = loadSortMode();

/** Maximum distance in metres, or 0 for "any". Filters which pubs render. */
let maxDistance = 1000;

/** Initialise the pub list. Pass a callback fired when a pub is clicked. */
export function initPubList(selectCallback: (pub: Pub) => void): void {
  listEl = document.getElementById("pub-list") as HTMLUListElement;
  searchEl = document.getElementById("pub-search") as HTMLInputElement;
  filterOpenEl = document.getElementById("filter-open") as HTMLButtonElement;
  onSelect = selectCallback;

  searchEl.addEventListener("input", () => renderList());
  filterOpenEl.addEventListener("click", () => {
    filterOpen = !filterOpen;
    filterOpenEl.classList.toggle("active", filterOpen);
    renderList();
  });

  // Distance / Sun sort selector — segmented control next to "Open now".
  // Restore the active state from the persisted choice on first paint.
  const sortButtons = document.querySelectorAll<HTMLButtonElement>(".sort-toggle button");
  for (const b of sortButtons) {
    b.classList.toggle("active", b.dataset.sort === sortMode);
  }
  for (const btn of sortButtons) {
    btn.addEventListener("click", () => {
      const mode = (btn.dataset.sort as SortMode | undefined) ?? "distance";
      setSortMode(mode);
      for (const b of sortButtons) {
        b.classList.toggle("active", b.dataset.sort === mode);
      }
    });
  }

  // Within-distance filter — second segmented control on the row below.
  const distanceButtons = document.querySelectorAll<HTMLButtonElement>(".distance-toggle button");
  for (const btn of distanceButtons) {
    btn.addEventListener("click", () => {
      const meters = parseInt(btn.dataset.distance ?? "0", 10);
      maxDistance = Number.isFinite(meters) ? meters : 0;
      for (const b of distanceButtons) {
        b.classList.toggle("active", b.dataset.distance === btn.dataset.distance);
      }
      renderList();
    });
  }
}

/** Apply the current sort mode to state.pubs in place. */
function applySort(): void {
  if (sortMode === "sun") {
    // Sun rating descending, with distance as secondary sort so nearby pubs
    // bubble up when the user has a location set.
    state.pubs.sort((a, b) => {
      const scoreDiff = (b.sun?.score ?? -1) - (a.sun?.score ?? -1);
      if (scoreDiff !== 0) return scoreDiff;
      const da = a.distance ?? Number.MAX_SAFE_INTEGER;
      const db = b.distance ?? Number.MAX_SAFE_INTEGER;
      return da - db;
    });
  } else {
    state.pubs.sort((a, b) => {
      const da = a.distance ?? Number.MAX_SAFE_INTEGER;
      const db = b.distance ?? Number.MAX_SAFE_INTEGER;
      return da - db;
    });
  }
}

/** Switch the sort order (distance ↔ Sunny Rating) and re-render. */
export function setSortMode(mode: SortMode): void {
  sortMode = mode;
  try {
    localStorage.setItem(SORT_STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures (private browsing, quota exceeded, etc.).
  }
  applySort();
  renderList();
}

/** Read the current sort mode (used by initPubList to set the active button). */
export function getSortMode(): SortMode {
  return sortMode;
}

/** Recompute distances from a location and re-sort by the current mode. */
export function sortByDistance(lat: number, lng: number): void {
  for (const pub of state.pubs) {
    pub.distance = haversineM(lat, lng, pub.lat, pub.lng);
  }
  applySort();
  renderList();
}

/** Render the pub list from current state, applying search and filters. */
export function renderList(): void {
  const query = searchEl.value.toLowerCase().trim();
  let filtered = query
    ? state.pubs.filter((p) => p.name.toLowerCase().includes(query))
    : state.pubs;

  if (filterOpen) {
    filtered = filtered.filter((p) => {
      const h = parseHours(p.opening_hours);
      return h ? h.isOpen : false;
    });
  }

  // Within-distance filter. Only applies when we have user coords (otherwise
  // pub.distance is undefined and the filter would hide everything). When
  // maxDistance is 0 ("Any") the filter is a no-op.
  if (maxDistance > 0 && state.userLat != null && state.userLng != null) {
    filtered = filtered.filter((p) => p.distance != null && p.distance <= maxDistance);
  }

  const shown = filtered.slice(0, PUB_LIST_MAX);

  listEl.innerHTML = "";
  for (const pub of shown) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", pub.id === state.selectedPubId ? "true" : "false");

    const dist = pub.distance != null ? formatDistance(pub.distance) : "";
    const mapsUrl = googleMapsUrl(pub.name, pub.lat, pub.lng);

    const hours = parseHours(pub.opening_hours);
    let hoursHtml = "";
    if (hours) {
      const cls = hours.isOpen ? "status-open" : "status-closed";
      const parts = [`<span class="${cls}">${hours.statusLabel}</span>`];
      if (hours.nextChangeLabel) parts.push(escapeHtml(hours.nextChangeLabel));
      hoursHtml = `<div class="pub-meta">${parts.join(" · ")}</div>`;
    } else if (pub.opening_hours) {
      hoursHtml = `<div class="pub-meta">${escapeHtml(pub.opening_hours)}</div>`;
    }

    const sunHtml = smallSunBadgeHtml(pub);

    li.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span class="pub-name">${escapeHtml(pub.name)}</span>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          ${sunHtml}
          ${dist ? `<span class="pub-dist">${dist}</span>` : ""}
        </div>
      </div>
      ${hoursHtml}
      <a href="${mapsUrl}" target="_blank" rel="noopener" class="pub-maps" onclick="event.stopPropagation()">Directions</a>
    `;

    li.addEventListener("click", () => {
      state.selectedPubId = pub.id;
      updateSelection();
      onSelect?.(pub);
    });

    listEl.appendChild(li);
  }
}

/** Update selected state on list items without a full re-render. */
function updateSelection(): void {
  for (const li of listEl.children) {
    const el = li as HTMLElement;
    const name = el.querySelector(".pub-name")?.textContent ?? "";
    const pub = state.pubs.find((p) => p.name === name);
    el.setAttribute("aria-selected", pub?.id === state.selectedPubId ? "true" : "false");
  }
  const selected = listEl.querySelector('[aria-selected="true"]');
  selected?.scrollIntoView({ block: "nearest" });
}

function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)}m`;
  return `${(metres / 1000).toFixed(1)}km`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
