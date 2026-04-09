/**
 * Pub list — search, filter, distance sort, click selection.
 */

import { googleMapsUrl, PUB_LIST_MAX } from "./config";
import { haversineM } from "./geo";
import { parseHours } from "./hours";
import { state } from "./state";
import type { Pub } from "./types";

let listEl: HTMLUListElement;
let searchEl: HTMLInputElement;
let filterOpenEl: HTMLButtonElement;
let filterOpen = false;
let onSelect: ((pub: Pub) => void) | null = null;

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
}

/** Compute distance from a location to every pub and re-sort the list. */
export function sortByDistance(lat: number, lng: number): void {
  for (const pub of state.pubs) {
    pub.distance = haversineM(lat, lng, pub.lat, pub.lng);
  }
  state.pubs.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
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

    li.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="pub-name">${escapeHtml(pub.name)}</span>
        ${dist ? `<span class="pub-dist">${dist}</span>` : ""}
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
