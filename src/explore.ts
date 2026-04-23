/**
 * Explore page interactive map + list.
 *
 * County data is embedded in the page as JSON (no fetch needed).
 * Click a county on the map → zoom + show towns in sidebar.
 * Click a town → inline pub list below the map.
 */

import { parseHours } from "./hours";
import { smallSunBadgeHtml } from "./sunbadge";
import type { Pub } from "./types";

const DATA_URL =
  typeof document !== "undefined" && location.hostname === "localhost"
    ? "/data"
    : document.querySelector<HTMLMetaElement>('meta[name="data-url"]')?.content || "/data";

interface CountyInfo {
  name: string;
  slug: string;
  country: string;
  countrySlug: string;
  pubCount: number;
  avgScore: number | null;
  towns: TownInfo[];
}

interface TownInfo {
  name: string;
  slug: string;
  pubCount: number;
  avgScore: number | null;
  lat?: number;
  lng?: number;
}

let counties: CountyInfo[] = [];
let selectedCounty: string | null = null;
let selectedTown: string | null = null;
let sortMode: "score" | "pubs" | "name" = "score";

// Lazy-loaded pub index for the inline pub panel.
let allPubs: Pub[] | null = null;
let pubsLoadPromise: Promise<Pub[]> | null = null;
let pubSortMode: "sun" | "size" | "name" = "sun";
let pubFilterOpen = false;

async function loadPubs(): Promise<Pub[]> {
  if (allPubs) return allPubs;
  if (pubsLoadPromise) return pubsLoadPromise;
  pubsLoadPromise = (async () => {
    const resp = await fetch(`${DATA_URL}/pubs-index.json`);
    if (!resp.ok) throw new Error(`Failed to load pubs: ${resp.status}`);
    allPubs = (await resp.json()) as Pub[];
    return allPubs;
  })();
  return pubsLoadPromise;
}

// Voronoi overlay group ID.
const VORONOI_GROUP_ID = "explore-voronoi";

// ── Projection (must match geo_svg.ts build-time projection) ───────────

const GB = { minLng: -8.9, maxLng: 2.0, minLat: 49.7, maxLat: 61.1 };
const COS_LAT = Math.cos((55 * Math.PI) / 180);
const PROJ_W = (GB.maxLng - GB.minLng) * COS_LAT;
const PROJ_H = GB.maxLat - GB.minLat;
const PAD = 12;
const SVG_H = 600;
const SVG_W = Math.round((SVG_H * PROJ_W) / PROJ_H) + PAD * 2;

function project(lng: number, lat: number): [number, number] {
  const x = PAD + (((lng - GB.minLng) * COS_LAT) / PROJ_W) * (SVG_W - PAD * 2);
  const y = PAD + (1 - (lat - GB.minLat) / PROJ_H) * (SVG_H - PAD * 2);
  return [x, y];
}

/** Match the 5-tier badge colors from sunbadge.ts / style.css. */
function scoreColor(score: number | null): string {
  if (score === null) return "#e0deda";
  if (score >= 80) return "#fde68a"; // Sun trap
  if (score >= 60) return "#fef3c7"; // Very sunny
  if (score >= 40) return "#fffbeb"; // Sunny
  if (score >= 20) return "#e0dcda"; // Partly shaded
  return "#c4c0bb"; // Shaded
}

// ── Voronoi + town dots overlay ────────────────────────────────────────

function clearOverlays(): void {
  document.getElementById(VORONOI_GROUP_ID)?.remove();
}

async function renderCountyOverlay(county: CountyInfo): Promise<void> {
  const svg = document.querySelector(".explore-map") as SVGSVGElement | null;
  if (!svg) return;

  const towns = county.towns.filter((t) => t.lat && t.lng);
  if (towns.length < 3) return;

  // Dynamic import — only loaded when a county is clicked.
  const { Delaunay } = await import("d3-delaunay");

  const projected = towns.map((t) => project(t.lng!, t.lat!));

  // Compute Voronoi clipped to the SVG viewBox.
  const delaunay = Delaunay.from(projected);
  const voronoi = delaunay.voronoi([0, 0, SVG_W, SVG_H]);

  // Create Voronoi group.
  const ns = "http://www.w3.org/2000/svg";
  const vGroup = document.createElementNS(ns, "g");
  vGroup.id = VORONOI_GROUP_ID;
  vGroup.setAttribute("opacity", "0.85");

  for (let i = 0; i < towns.length; i++) {
    const cell = voronoi.cellPolygon(i);
    if (!cell || cell.length < 3) continue;

    const town = towns[i]!;
    const d =
      cell.map(([x, y], j) => `${j === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join("") +
      "Z";

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", scoreColor(town.avgScore));
    path.setAttribute("stroke", "#a8a29e");
    path.setAttribute("stroke-width", "0.2");
    path.setAttribute("cursor", "pointer");
    path.dataset.townName = town.name;

    const title = document.createElementNS(ns, "title");
    title.textContent = `${town.name} — ${town.pubCount} pubs${town.avgScore !== null ? `, avg ${town.avgScore}/100` : ""}`;
    path.appendChild(title);

    path.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTown(town.name);
    });

    vGroup.appendChild(path);
  }

  // Clip Voronoi to the county shape — find the county paths and use as clipPath.
  const countyPathD: string[] = [];
  for (const p of svg.querySelectorAll("path")) {
    const title = p.querySelector("title")?.textContent || "";
    if (title.startsWith(`${county.name} —`) || title === county.name) {
      countyPathD.push(p.getAttribute("d") || "");
    }
  }
  if (countyPathD.length > 0) {
    const clipPath = document.createElementNS(ns, "clipPath");
    clipPath.id = "county-voronoi-clip";
    const clipPathEl = document.createElementNS(ns, "path");
    clipPathEl.setAttribute("d", countyPathD.join(" "));
    clipPath.appendChild(clipPathEl);

    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS(ns, "defs");
      svg.insertBefore(defs, svg.firstChild);
    }
    // Remove old clip if any.
    defs.querySelector("#county-voronoi-clip")?.remove();
    defs.appendChild(clipPath);

    vGroup.setAttribute("clip-path", "url(#county-voronoi-clip)");
  }

  // Insert after county boundaries so Voronoi renders on top.
  svg.appendChild(vGroup);
}

// ── SVG map interaction ────────────────────────────────────────────────

function zoomToCounty(countyName: string): void {
  const svg = document.querySelector(".explore-map") as SVGSVGElement | null;
  if (!svg) return;

  // Find all paths belonging to this county.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let found = false;

  for (const path of svg.querySelectorAll("path")) {
    const title = path.querySelector("title")?.textContent || "";
    if (!title.startsWith(`${countyName} —`) && title !== countyName) continue;
    found = true;
    const bbox = path.getBBox();
    if (bbox.x < minX) minX = bbox.x;
    if (bbox.y < minY) minY = bbox.y;
    if (bbox.x + bbox.width > maxX) maxX = bbox.x + bbox.width;
    if (bbox.y + bbox.height > maxY) maxY = bbox.y + bbox.height;
  }
  if (!found) return;

  const pad = 20;
  svg.style.transition = "all 0.4s ease";
  svg.setAttribute(
    "viewBox",
    `${(minX - pad).toFixed(0)} ${(minY - pad).toFixed(0)} ${(maxX - minX + pad * 2).toFixed(0)} ${(maxY - minY + pad * 2).toFixed(0)}`,
  );

  // Scale stroke width based on zoom level so borders don't get thick.
  const origVb = svg.dataset.originalViewbox?.split(" ").map(Number) || [0, 0, 350, 600];
  const zoomRatio = (maxX - minX + pad * 2) / (origVb[2] || 350);
  const thinStroke = (0.5 * zoomRatio).toFixed(2);
  const selectedStroke = (1.5 * zoomRatio).toFixed(2);

  // Dim non-selected counties.
  for (const path of svg.querySelectorAll("path")) {
    const title = path.querySelector("title")?.textContent || "";
    if (title.startsWith(`${countyName} —`) || title === countyName) {
      path.setAttribute("stroke", "#D97706");
      path.setAttribute("stroke-width", selectedStroke);
      path.removeAttribute("opacity");
    } else {
      path.setAttribute("stroke", "#a8a29e");
      path.setAttribute("stroke-width", thinStroke);
      path.setAttribute("opacity", "0.3");
    }
  }
}

function zoomToUK(): void {
  const svg = document.querySelector(".explore-map") as SVGSVGElement | null;
  if (!svg) return;

  const original = svg.dataset.originalViewbox;
  if (original) {
    svg.style.transition = "all 0.4s ease";
    svg.setAttribute("viewBox", original);
  }

  for (const path of svg.querySelectorAll("path")) {
    path.setAttribute("stroke", "#a8a29e");
    path.setAttribute("stroke-width", "0.5");
    path.removeAttribute("opacity");
  }
}

// ── Sidebar rendering ──────────────────────────────────────────────────

function sortItems<T extends { avgScore: number | null; name: string }>(
  items: T[],
  countFn: (item: T) => number,
): T[] {
  const sorted = [...items];
  if (sortMode === "score") sorted.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
  else if (sortMode === "pubs") sorted.sort((a, b) => countFn(b) - countFn(a));
  else sorted.sort((a, b) => a.name.localeCompare(b.name));
  return sorted;
}

function scoreBadge(score: number | null): string {
  if (score === null) return "";
  return `<span class="explore-score">${score}</span>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSidebar(): void {
  const container = document.getElementById("explore-list");
  const heading = document.getElementById("explore-list-heading");
  if (!container || !heading) return;

  if (!selectedCounty) {
    // County list.
    const sorted = sortItems(counties, (c) => c.pubCount);
    heading.innerHTML = `${sorted.length} counties`;
    container.innerHTML = sorted
      .map(
        (c) =>
          `<li class="explore-list-item" data-county="${esc(c.name)}">` +
          `<span class="explore-item-name">${esc(c.name)}</span>` +
          `<span class="explore-item-meta">${c.pubCount} pubs</span>` +
          scoreBadge(c.avgScore) +
          `</li>`,
      )
      .join("");

    for (const li of container.querySelectorAll<HTMLElement>("[data-county]")) {
      li.addEventListener("click", () => {
        selectCounty(li.dataset.county!);
      });
    }
  } else {
    // Town list for selected county.
    const county = counties.find((c) => c.name === selectedCounty);
    if (!county) return;

    let sorted = sortItems(county.towns, (t) => t.pubCount);
    // Pin selected town to the top so it's visible after a click.
    if (selectedTown) {
      const sel = sorted.find((t) => t.name === selectedTown);
      if (sel) {
        sorted = [sel, ...sorted.filter((t) => t.name !== selectedTown)];
      }
    }
    heading.innerHTML =
      `<a href="#" id="explore-back">&larr;</a> ` +
      `<strong>${esc(county.name)}</strong> ` +
      `<span class="explore-item-meta">${county.pubCount} pubs</span> ` +
      scoreBadge(county.avgScore);

    container.innerHTML = sorted
      .map((t) => {
        const isSelected = t.name === selectedTown;
        return (
          `<li class="explore-list-item${isSelected ? " selected" : ""}" data-town="${esc(t.name)}">` +
          `<span class="explore-item-name">${esc(t.name)}</span>` +
          `<span class="explore-item-meta">${t.pubCount} pubs</span>` +
          scoreBadge(t.avgScore) +
          `</li>`
        );
      })
      .join("");

    for (const li of container.querySelectorAll<HTMLElement>("[data-town]")) {
      li.addEventListener("click", () => {
        selectTown(li.dataset.town!);
      });
    }

    // Scroll the selected item into view (top after pinning).
    if (selectedTown) {
      container.scrollTop = 0;
    }

    document.getElementById("explore-back")?.addEventListener("click", (e) => {
      e.preventDefault();
      selectCounty(null);
    });
  }
}

// ── Town selection + inline pub panel ─────────────────────────────────

function selectTown(name: string | null): void {
  selectedTown = name;
  renderSidebar();
  renderPubPanel();
}

async function renderPubPanel(): Promise<void> {
  const panel = document.getElementById("explore-pub-panel");
  if (!panel) return;

  if (!selectedTown) {
    panel.innerHTML = "";
    panel.classList.remove("visible");
    return;
  }

  panel.classList.add("visible");
  panel.innerHTML = `<h3>${esc(selectedTown)}</h3><p class="explore-loading">Loading pubs...</p>`;

  let pubs: Pub[];
  try {
    pubs = await loadPubs();
  } catch (err) {
    panel.innerHTML = `<h3>${esc(selectedTown)}</h3><p class="explore-loading">Could not load pubs</p>`;
    console.error(err);
    return;
  }

  const requestedTown = selectedTown;
  let townPubs = pubs.filter((p) => p.town === requestedTown);
  const totalCount = townPubs.length;

  if (totalCount === 0) {
    panel.innerHTML = `<h3>${esc(requestedTown!)}</h3><p class="explore-loading">No pubs found</p>`;
    return;
  }

  // Apply open-now filter.
  if (pubFilterOpen) {
    townPubs = townPubs.filter((p) => parseHours(p.opening_hours)?.isOpen ?? false);
  }

  // Apply sort.
  if (pubSortMode === "sun") {
    townPubs.sort((a, b) => (b.sun?.score ?? -1) - (a.sun?.score ?? -1));
  } else if (pubSortMode === "size") {
    townPubs.sort((a, b) => (b.outdoor_area_m2 ?? -1) - (a.outdoor_area_m2 ?? -1));
  } else {
    townPubs.sort((a, b) => a.name.localeCompare(b.name));
  }

  const items = townPubs
    .map((p) => {
      const badge = smallSunBadgeHtml(p);
      const label = p.sun?.label
        ? `<span class="explore-pub-label">${esc(p.sun.label)}</span>`
        : "";
      const win = p.sun?.best_window
        ? `<span class="explore-pub-window">Best ${esc(p.sun.best_window)}</span>`
        : "";
      const area = p.outdoor_area_m2
        ? `<span class="explore-pub-area">${Math.round(p.outdoor_area_m2)} m²</span>`
        : "";
      const tags: string[] = [];
      if (p.sun?.all_day_sun) tags.push(`<span class="explore-pub-tag">All day sun</span>`);
      else if (p.sun?.evening_sun) tags.push(`<span class="explore-pub-tag">Evening sun</span>`);
      const tagsHtml = tags.length ? `<div class="explore-pub-tags">${tags.join("")}</div>` : "";
      return (
        `<li class="explore-pub-item">` +
        `<div class="explore-pub-info">` +
        `  <a href="/pub/${esc(p.slug || "")}/" class="explore-pub-name">${esc(p.name)}</a>` +
        `  <div class="explore-pub-meta">${label}${win}${area}</div>` +
        `  ${tagsHtml}` +
        `</div>` +
        badge +
        `</li>`
      );
    })
    .join("");

  const townSlug = requestedTown!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const viewAll =
    totalCount >= 8 ? `<a href="/${townSlug}/" class="explore-pub-link">View all →</a>` : "";
  const showingCount =
    townPubs.length === totalCount ? `${totalCount}` : `${townPubs.length}/${totalCount}`;
  panel.innerHTML =
    `<div class="explore-pub-header">` +
    `  <h3>${esc(requestedTown!)} <span class="explore-item-meta">${showingCount} pubs</span></h3>` +
    `  ${viewAll}` +
    `</div>` +
    `<div class="explore-pub-controls">` +
    `  <div class="explore-pub-sort">` +
    `    <button type="button" data-pub-sort="sun"${pubSortMode === "sun" ? ' class="active"' : ""}>☀ Sunniest</button>` +
    `    <button type="button" data-pub-sort="size"${pubSortMode === "size" ? ' class="active"' : ""}>Biggest</button>` +
    `    <button type="button" data-pub-sort="name"${pubSortMode === "name" ? ' class="active"' : ""}>A–Z</button>` +
    `  </div>` +
    `  <button type="button" id="explore-pub-open"${pubFilterOpen ? ' class="active"' : ""}>Open now</button>` +
    `</div>` +
    `<ul class="explore-pub-list">${items}</ul>`;

  // Wire up controls.
  for (const btn of panel.querySelectorAll<HTMLElement>("[data-pub-sort]")) {
    btn.addEventListener("click", () => {
      pubSortMode = (btn.dataset.pubSort as typeof pubSortMode) || "sun";
      renderPubPanel();
    });
  }
  document.getElementById("explore-pub-open")?.addEventListener("click", () => {
    pubFilterOpen = !pubFilterOpen;
    renderPubPanel();
  });
}

function selectCounty(name: string | null): void {
  selectedCounty = name;
  selectedTown = null;
  clearOverlays();
  if (name) {
    zoomToCounty(name);
    const county = counties.find((c) => c.name === name);
    if (county) renderCountyOverlay(county);
  } else {
    zoomToUK();
  }
  renderSidebar();
  renderPubPanel();
}

// ── Init ───────────────────────────────────────────────────────────────

export async function initExplore(): Promise<void> {
  // Load embedded county data.
  const dataEl = document.getElementById("explore-data");
  if (dataEl) {
    try {
      counties = JSON.parse(dataEl.textContent || "[]") as CountyInfo[];
    } catch {
      console.error("Failed to parse explore data");
    }
  }

  if (counties.length === 0) {
    console.warn("No county data found");
    return;
  }

  // Store original viewBox.
  const svg = document.querySelector(".explore-map") as SVGSVGElement | null;
  if (svg) {
    svg.dataset.originalViewbox = svg.getAttribute("viewBox") || "";
  }

  // Replace static sidebar with interactive list.
  const sidebar = document.querySelector(".explore-sidebar");
  if (sidebar) {
    sidebar.innerHTML =
      `<div class="explore-sort-bar">` +
      `  <button data-sort="score" class="explore-sort-btn active">Sunniest</button>` +
      `  <button data-sort="pubs" class="explore-sort-btn">Most pubs</button>` +
      `  <button data-sort="name" class="explore-sort-btn">A–Z</button>` +
      `</div>` +
      `<h2 id="explore-list-heading"></h2>` +
      `<ul id="explore-list" class="explore-list"></ul>`;
  }

  // Sort controls.
  for (const btn of document.querySelectorAll<HTMLElement>("[data-sort]")) {
    btn.addEventListener("click", () => {
      sortMode = (btn.dataset.sort as typeof sortMode) || "score";
      for (const b of document.querySelectorAll("[data-sort]")) {
        b.classList.toggle("active", b === btn);
      }
      renderSidebar();
    });
  }

  renderSidebar();

  // SVG click — intercept <a> navigation, zoom instead.
  if (svg) {
    svg.addEventListener("click", (e) => {
      const anchor = (e.target as Element).closest("a");
      if (anchor) e.preventDefault();

      const path = (e.target as Element).closest("path");
      if (!path) {
        selectCounty(null);
        return;
      }
      const title = path.querySelector("title")?.textContent || "";
      const countyName = title.split(" — ")[0]!.trim();
      if (countyName && counties.some((c) => c.name === countyName)) {
        selectCounty(countyName);
      }
    });
  }
}
