import "./style.css";

import SunCalc from "suncalc";
import { loadBuildingsForPub } from "./buildings";
import { initCircle, renderCircle, setPanChangeCallback, setViewChangeCallback } from "./circle";
import {
  DEFAULT_LAT,
  DEFAULT_LNG,
  DEFAULT_LOCATION_NAME,
  googleMapsUrl,
  PHOTON_URL,
} from "./config";
import { initContact, openContact } from "./contact";
import { parseHours } from "./hours";
import { initIcons } from "./icons";
import { initLocation } from "./location";
import { initPubList, renderList, sortByDistance } from "./publist";
import { computeShadows, terrainShadowEdge } from "./shadow";
import { shareSnapshot } from "./share";
import { selectedPub, state } from "./state";
import { type LocationSource, loadLocation, saveLocation, type ZoomStep } from "./storage";
import { initSunArc, renderArc } from "./sunarc";
import { largeSunBadgeHtml } from "./sunbadge";
import { ukDateAt, ukTimeMins } from "./time";
import type { Pub } from "./types";
import {
  clearTimeUserDriven,
  markTimeUserDriven,
  onPopState,
  readURL,
  setBasePath,
  setLocationQuery,
  syncDocumentHead,
  withSuppressedWrites,
  writeURL,
  writeURLDebounced,
} from "./url";
import { getWeather, weatherEmoji, weatherLabel } from "./weather";
import { maybeShowWelcome } from "./welcome";

/** Base URL for data files. In production, served from R2 via custom
 *  domain. In dev, falls back to Vite's local public/ dir. */
const DATA_BASE_URL = (() => {
  const meta = document.querySelector('meta[name="data-url"]');
  return meta?.getAttribute("content") || "/data";
})();

async function loadPubs(): Promise<void> {
  const resp = await fetch(`${DATA_BASE_URL}/pubs-index.json`);
  const pubs: Pub[] = await resp.json();
  state.pubs = pubs;
}

/** Cache of loaded per-pub data, keyed by slug. */
const pubDetailCache = new Map<string, Partial<Pub>>();

/** Load the per-pub JSON from R2 (full pub record + 10 nearest) and merge
 *  the extra fields onto the slim-index pub object. Replaces the old
 *  geographic-cell detail chunks — slug-keyed direct fetch is cheaper at
 *  startup time and lets the /pub/ Pages Function use the same files. */
async function loadPubDetail(pub: Pub): Promise<void> {
  if (pub.outdoor !== undefined || !pub.slug) return; // already merged
  let detail = pubDetailCache.get(pub.slug);
  if (!detail) {
    try {
      const resp = await fetch(`${DATA_BASE_URL}/pub/${pub.slug}.json`);
      if (resp.ok) {
        detail = (await resp.json()) as Partial<Pub>;
        pubDetailCache.set(pub.slug, detail);
      }
    } catch {
      // Network error — pub renders without outdoor/horizon data.
    }
  }
  if (detail) Object.assign(pub, detail);
}

// ── Porthole controls (satellite + zoom) ────────────────────────────

const ZOOM_STEPS: ZoomStep[] = [1, 2, 4];

function initPortholeControls(): void {
  const satBtn = document.getElementById("btn-satellite");
  const zoomIn = document.getElementById("btn-zoom-in");
  const zoomOut = document.getElementById("btn-zoom-out");
  const zoomLabel = document.getElementById("zoom-label");
  const resetBtn = document.getElementById("btn-reset-pan");

  // Restore saved state to UI
  syncPortholeUI();

  satBtn?.addEventListener("click", () => {
    state.satellite = !state.satellite;
    syncPortholeUI();
    updateScene();
  });

  zoomIn?.addEventListener("click", () => {
    const idx = ZOOM_STEPS.indexOf(state.zoomStep);
    if (idx < ZOOM_STEPS.length - 1) {
      state.zoomStep = ZOOM_STEPS[idx + 1]!;
      syncPortholeUI();
      updateScene();
    }
  });

  zoomOut?.addEventListener("click", () => {
    const idx = ZOOM_STEPS.indexOf(state.zoomStep);
    if (idx > 0) {
      state.zoomStep = ZOOM_STEPS[idx - 1]!;
      if (state.zoomStep === 1) {
        state.panX = 0;
        state.panY = 0;
      }
      syncPortholeUI();
      updateScene();
    }
  });

  resetBtn?.addEventListener("click", () => {
    state.panX = 0;
    state.panY = 0;
    state.zoomStep = 1;
    syncPortholeUI();
    updateScene();
  });

  setPanChangeCallback(syncPortholeUI);
  setViewChangeCallback(syncPortholeUI);
  portholeUISync = syncPortholeUI;

  function syncPortholeUI(): void {
    satBtn?.classList.toggle("active", state.satellite);
    if (zoomLabel) zoomLabel.textContent = `${state.zoomStep}x`;
    if (zoomIn) (zoomIn as HTMLButtonElement).disabled = state.zoomStep >= 4;
    if (zoomOut) (zoomOut as HTMLButtonElement).disabled = state.zoomStep <= 1;
    const panned = state.panX !== 0 || state.panY !== 0;
    const needsReset = panned || state.zoomStep > 1;
    if (resetBtn) (resetBtn as HTMLButtonElement).disabled = !needsReset;
  }
}

let portholeUISync: (() => void) | null = null;

/** Recompute shadows and redraw everything for current time. */
function updateScene(): void {
  const pub = selectedPub();
  if (!pub) return;

  const d = ukDateAt(state.date, state.timeMins);
  const pos = SunCalc.getPosition(d, pub.lat, pub.lng);
  const sun = {
    azimuth: ((pos.azimuth * 180) / Math.PI + 180) % 360,
    altitude: (pos.altitude * 180) / Math.PI,
  };

  // Terrain shadow: compute edge distance (null = no terrain, negative = fully shaded).
  state.terrainShadowEdgeM = terrainShadowEdge(pub, sun);
  state.terrainShadowAzimuth = sun.azimuth;

  // Always compute building shadows — as sun descends toward the ridge,
  // shadow length grows smoothly (height / tan(alt)), and past the ridge
  // the terrain-shadow overlay naturally darkens the whole porthole on top.
  // Zeroing the list at the ridge-crossing moment caused a jarring pop.
  state.shadowPolys = computeShadows(state.buildings, sun);

  const canvas = document.getElementById("circle-canvas") as HTMLCanvasElement;
  renderCircle(canvas);

  writeURLDebounced();
}

async function onPubSelected(pub: Pub): Promise<void> {
  // Only dismiss SEO content when navigating to a different pub.
  // If this is the landing pub (from meta tag), keep the SEO visible.
  if (pub.slug !== landingSlug) {
    dismissSeoContent();
    landingSlug = null; // once dismissed, don't re-show
  }
  // Close mobile drawer and scroll back to the porthole. Targets both
  // window and #main so it works whether the page or main is the
  // scroll container.
  document.getElementById("pubs")?.classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.getElementById("main")?.scrollTo({ top: 0, behavior: "smooth" });
  state.panX = 0;
  state.panY = 0;
  state.zoomStep = 1;
  state.satellite = false;
  portholeUISync?.();
  updatePubInfo(pub);
  // Immediate URL push so the browser back button has a real history entry
  // for this pub. updateScene() then runs the debounced writer for any
  // subsequent time scrubbing on top.
  writeURL();
  // Keep document.title + canonical in sync during SPA navigation so
  // browser tabs, share sheets, and any bot that evaluates JS see the
  // correct per-pub title instead of the static homepage title.
  if (pub.slug) {
    const titleScore = pub.sun ? ` — Sunny Rating ${pub.sun.score}/100` : "";
    syncDocumentHead({
      title: `${pub.name}${titleScore} — Sunny Pint`,
      canonicalPath: `/pub/${pub.slug}/`,
    });
  }
  // Load detail data (outdoor polygon, elev, horizon) + building tiles
  // in parallel. Detail typically arrives first (~80 KB chunk from CDN)
  // while building tiles stream from PMTiles range requests.
  await Promise.all([loadPubDetail(pub), loadBuildingsForPub(pub)]);
  // Re-render pub info now that detail fields are available.
  updatePubInfo(pub);
  updateScene();
}

function updatePubInfo(pub: Pub): void {
  const card = document.getElementById("pub-info");
  if (!card) return;
  card.hidden = false;

  // Show "Report a problem" link
  const reportBtn = document.getElementById("btn-report") as HTMLElement | null;
  if (reportBtn) {
    reportBtn.hidden = false;
    reportBtn.onclick = (e) => {
      e.preventDefault();
      openContact({ pubSlug: pub.slug, pubName: pub.name });
    };
  }

  // Name + status.
  const hours = parseHours(pub.opening_hours);
  const nameEl = document.getElementById("pub-info-name");
  if (nameEl) {
    if (hours) {
      const cls = hours.isOpen ? "status-open" : "status-closed";
      nameEl.innerHTML = `${escapeHtml(pub.name)} <span class="${cls}">${hours.statusLabel}</span>`;
    } else {
      nameEl.textContent = pub.name;
    }
  }

  // Brand + next change.
  const brandParts = [pub.brand, pub.brewery].filter(Boolean);
  if (hours?.nextChangeLabel) brandParts.push(hours.nextChangeLabel);
  const brandEl = document.getElementById("pub-info-brand");
  if (brandEl) brandEl.textContent = brandParts.join(" · ");

  // Sunny Rating badge — the headline metric, just below the name.
  const sunEl = document.getElementById("pub-info-sun");
  if (sunEl) sunEl.innerHTML = largeSunBadgeHtml(pub);

  // Attribute grid.
  function fmtVal(v: string | undefined): { text: string; cls: string } {
    if (!v) return { text: "\u2013", cls: "val-unknown" };
    if (v === "no") return { text: "No", cls: "val-no" };
    if (v === "limited") return { text: "Limited", cls: "val-limited" };
    return { text: "Yes", cls: "val-yes" };
  }

  function cell(label: string, value: string | undefined): string {
    const v = fmtVal(value);
    return `<div class="pub-info-cell"><span class="cell-label">${label}</span><span class="cell-value ${v.cls}">${v.text}</span></div>`;
  }

  const gridEl = document.getElementById("pub-info-grid");
  if (gridEl) {
    gridEl.innerHTML =
      cell("Real ale", pub.real_ale) +
      cell("Outdoor", pub.outdoor_seating || pub.beer_garden) +
      cell("Food", pub.food) +
      cell("Dogs", pub.dog) +
      cell("Wheelchair", pub.wheelchair) +
      cell("WiFi", pub.wifi);
  }

  // Hours — weekly table or raw string.
  const hoursEl = document.getElementById("pub-info-hours");
  if (hoursEl) {
    if (hours?.weeklyTable) {
      hoursEl.innerHTML = `<table class="hours-table">${hours.weeklyTable
        .map(
          (r) =>
            `<tr class="${r.isToday ? "hours-today" : ""}"><td>${escapeHtml(r.day)}</td><td>${escapeHtml(r.hours)}</td></tr>`,
        )
        .join("")}</table>`;
    } else if (pub.opening_hours) {
      hoursEl.innerHTML = `<span class="cell-label">Hours</span> ${escapeHtml(pub.opening_hours)}`;
    } else {
      hoursEl.innerHTML = `<span class="cell-label">Hours</span> <span class="val-unknown">\u2013</span>`;
    }
  }

  // Links.
  const links: string[] = [];
  if (pub.phone) links.push(`<a href="tel:${escapeHtml(pub.phone)}">${escapeHtml(pub.phone)}</a>`);
  if (pub.website) {
    // OSM's website tag can be anything the editor typed. Common shapes:
    //   "https://example.com/" → use as-is
    //   "www.example.com"      → prepend https://
    //   "example.com"          → prepend https://
    // We also drop anything that's not http(s) so a rogue "javascript:..."
    // or "file://..." never becomes a clickable link.
    const raw = pub.website.trim();
    let href: string | null = null;
    if (/^https?:\/\//i.test(raw)) href = raw;
    else if (/^(?!.*:)([\w-]+\.)+[a-z]{2,}/i.test(raw)) href = `https://${raw}`;
    if (href) {
      const domain = href.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      links.push(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a>`,
      );
    }
  }
  links.push(
    `<a href="${googleMapsUrl(pub.name, pub.lat, pub.lng)}" target="_blank" rel="noopener">Directions</a>`,
  );
  const linksEl = document.getElementById("pub-info-links");
  if (linksEl) linksEl.innerHTML = links.join(" · ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setLocation(
  lat: number,
  lng: number,
  opts: { keepPub?: boolean; persistAs?: LocationSource; label?: string } = {},
): void {
  state.userLat = lat;
  state.userLng = lng;
  sortByDistance(lat, lng);

  // Fetch weather in background.
  fetchWeather(lat, lng);

  // Persist if the caller explicitly opted in. We only do this for
  // user-initiated location choices (GPS, search) — not for app defaults
  // or pub-page hydration where the coords aren't necessarily "where the
  // user is".
  if (opts.persistAs) {
    saveLocation({
      lat,
      lng,
      label: opts.label ?? `${lat.toFixed(3)}, ${lng.toFixed(3)}`,
      source: opts.persistAs,
    });
  }

  if (state.pubs.length > 0) {
    // Auto-select the closest pub on every location change unless explicitly
    // asked to keep the current pub (e.g., when ?pub= URL param specified one).
    if (!opts.keepPub) {
      const closest = state.pubs[0]!;
      state.selectedPubId = closest.id;
      onPubSelected(closest);
    }
    renderList();
  }
}

// ── Weather ──────────────────────────────────────────────────────────

async function fetchWeather(lat: number, lng: number): Promise<void> {
  const ws = await getWeather(lat, lng);
  state.weatherState = ws;
  const badge = document.getElementById("weather-badge");
  if (badge) {
    badge.textContent = `${weatherEmoji(ws)} ${weatherLabel(ws)}`;
    badge.title = weatherLabel(ws);
  }
  // Re-render porthole with weather state.
  updateScene();
}

// ── Theme ────────────────────────────────────────────────────────────

type Theme = "light" | "dark" | "system";

function getStoredTheme(): Theme {
  return (localStorage.getItem("theme") as Theme) || "system";
}

function applyTheme(theme: Theme): void {
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  localStorage.setItem("theme", theme);
}

function setTheme(theme: Theme): void {
  applyTheme(theme);
  updateScene();
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Read a `<meta name="...">` content attribute, returning '' if absent. */
function getMeta(name: string): string {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el?.getAttribute("content")?.trim() ?? "";
}

function parseFloatOrNull(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Hydrate the homepage with the default location and try GPS in the
 * background — but only if the user has *already* granted geolocation
 * permission. Asking on first load (without a user gesture) trips the
 * Lighthouse "Requests geolocation permission on page load" anti-pattern
 * and is jarring UX for first-time visitors.
 *
 * Returning visitors who clicked the location button on a previous visit
 * (or any page with geolocation already granted) get the auto-detect
 * behaviour as before — `permissions.query` returns "granted" and we
 * call `getCurrentPosition` immediately. Everyone else stays on the
 * default centroid until they tap the location button themselves.
 */
async function defaultHomeHydration(labelEl: HTMLElement | null): Promise<void> {
  // Returning visitor with a saved location → use that immediately and
  // don't fall through to Norwich or auto-GPS. They've already told us
  // where they want to look from.
  const saved = loadLocation();
  if (saved) {
    setLocation(saved.lat, saved.lng);
    if (labelEl) labelEl.textContent = saved.label;
    setLocationQuery(saved.label);
    return;
  }

  setLocation(DEFAULT_LAT, DEFAULT_LNG);
  if (labelEl) labelEl.textContent = DEFAULT_LOCATION_NAME;
  setLocationQuery(DEFAULT_LOCATION_NAME);

  if (!navigator.geolocation) return;

  // Check the permission state before triggering the prompt. Browsers
  // without the Permissions API (Safari < 16) skip auto-GPS entirely.
  let alreadyGranted = false;
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
      alreadyGranted = status.state === "granted";
    }
  } catch {
    // Permissions API failed — fall back to never auto-prompting.
  }
  if (!alreadyGranted) return;

  if (labelEl) labelEl.textContent = "Locating...";

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      let locationLabel = "Your location";
      try {
        const resp = await fetch(
          `${PHOTON_URL}/reverse?lat=${latitude}&lon=${longitude}&lang=en&limit=1`,
        );
        const data = (await resp.json()) as {
          features?: { properties: Record<string, string> }[];
        };
        const p = data.features?.[0]?.properties ?? {};
        // Photon has flat locality fields (no neighbourhood/suburb distinction).
        // Prefer city/town/district; fall back to name if nothing else matches.
        const local = p.district;
        const main = p.city || p.name;
        locationLabel =
          local && main && local !== main ? `${local}, ${main}` : main || local || "Your location";
      } catch {
        // Reverse-geocode failed — keep the generic label.
      }
      // Persist the auto-GPS hit so the next visit hydrates from storage
      // and skips the permission prompt entirely.
      setLocation(latitude, longitude, { persistAs: "gps", label: locationLabel });
      if (labelEl) labelEl.textContent = locationLabel;
      setLocationQuery(locationLabel);
      writeURL();
    },
    () => {
      if (labelEl) labelEl.textContent = DEFAULT_LOCATION_NAME;
    },
    { timeout: 5000, maximumAge: 60000 },
  );
}

// ── Init ─────────────────────────────────────────────────────────────

/** The pub slug from the landing page meta tag (if any). SEO content
 *  stays visible while the user is viewing this pub — only dismissed
 *  when they navigate to a different pub or start searching. */
let landingSlug: string | null = null;

/** Hide the SEO landing-page content (city intro, pub list, breadcrumbs). */
function dismissSeoContent(): void {
  const el = document.getElementById("seo-intro");
  if (el) {
    el.classList.remove("seo-intro--landing");
    el.classList.add("sr-only");
  }
}

async function init(): Promise<void> {
  // Explore pages run their own mini-app instead of the porthole SPA.
  if (document.querySelector(".seo-intro--explore")) {
    applyTheme(getStoredTheme());
    initIcons();
    const main = document.getElementById("main");
    if (main) main.style.display = "none";
    const { initExplore } = await import("./explore");
    await initExplore();
    return;
  }

  try {
    // Apply theme.
    applyTheme(getStoredTheme());
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (getStoredTheme() === "system") applyTheme("system");
    });

    // Render icons.
    initIcons();

    // Read URL params (may override defaults).
    const urlState = readURL();

    // Read landing-page meta tags. Statically generated city / pub pages
    // populate these so the app boots straight into the right context with
    // no extra fetches and no client-side route detection.
    const metaArea = getMeta("sp:area");
    const metaPub = getMeta("sp:pub");
    const metaAreaName = getMeta("sp:area-name");
    const metaAreaLat = parseFloatOrNull(getMeta("sp:area-lat"));
    const metaAreaLng = parseFloatOrNull(getMeta("sp:area-lng"));

    // Lock the base path for url.ts — all subsequent writes stay on this path.
    setBasePath(window.location.pathname.replace(/[^/]*$/, "") || "/");

    // Set time — URL param, or now. If the incoming URL already had a ?t=
    // it was either user-shared or scrubbed previously, so preserve it on
    // subsequent writes. Otherwise leave the URL clean until the user
    // actually moves the slider.
    //
    // "Now" means UK now — every pub on the site is in the UK, so a user
    // in another timezone still wants the initial view to show the sun
    // as it currently is in the UK, not their local wall-clock hour.
    if (urlState.time != null) {
      state.timeMins = urlState.time;
      markTimeUserDriven();
    } else {
      state.timeMins = ukTimeMins(new Date());
    }
    if (urlState.date) state.date = urlState.date;

    // Init UI components. Wrap the sun-arc callback so any user-driven time
    // change (scrub or play) flips the URL flag and writeURL starts emitting
    // ?t= for sharing/reload preservation.
    initPubList(onPubSelected);
    // Dismiss SEO landing content on first search interaction.
    document
      .getElementById("pub-search")
      ?.addEventListener("input", dismissSeoContent, { once: true });
    initCircle();
    initContact();
    initPortholeControls();
    initSunArc(() => {
      markTimeUserDriven();
      updateScene();
    });

    // Load pub data.
    await loadPubs();
    console.log(`Loaded ${state.pubs.length} pubs`);

    // Google sitelinks SearchAction hits the homepage with ?q=... matching
    // the urlTemplate we advertise in structured data. Seed the search
    // input with the query and fire the input handler so the list filters
    // straight away — otherwise the advertised search template is a
    // phantom and clicking a sitelinks search result does nothing.
    if (urlState.searchQuery) {
      const searchEl = document.getElementById("pub-search") as HTMLInputElement | null;
      if (searchEl) {
        searchEl.value = urlState.searchQuery;
        searchEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    // Location picker (GPS + search). Both paths route through here, and
    // both represent an explicit user choice — so persist the location to
    // localStorage so the next visit hydrates from it instead of defaulting
    // to Norwich. The label is read off the header element which the
    // location module updates synchronously before this callback fires.
    initLocation((lat, lng) => {
      const label = document.getElementById("location-label")?.textContent ?? undefined;
      setLocation(lat, lng, { persistAs: "search", label });
      writeURL();
    });

    // Browser back/forward — re-hydrate from the new URL. Routes we handle:
    //   /pub/<slug>/  → look up pub by slug, select it, render
    //   /<city>/      → no-op for now (stays in current city context)
    //   /             → no-op (homepage; user is just clearing the slug)
    // Time/date scrubbing carries over via the urlState's time/date fields.
    onPopState((s) => {
      if (s.time != null) {
        state.timeMins = s.time;
        markTimeUserDriven();
      }
      if (s.date) state.date = s.date;
      const route = s.route;
      if (route.kind === "pub") {
        const pub = state.pubs.find((p) => p.slug === route.pubSlug);
        if (pub && pub.id !== state.selectedPubId) {
          // Suppress writes during programmatic navigation so onPubSelected
          // doesn't push another history entry on top of the one we just
          // popped to.
          withSuppressedWrites(() => {
            state.selectedPubId = pub.id;
            void onPubSelected(pub);
          });
          // onPubSelected already syncs the document head for the new pub.
        }
      } else if (route.kind === "home") {
        // Popped back to the homepage — reset title + canonical so the
        // tab label doesn't stay pinned to the previously-selected pub.
        state.selectedPubId = null;
        syncDocumentHead({
          title: "Sunny Pint — Find sunny beer gardens at UK pubs",
          canonicalPath: "/",
        });
      }
      updateScene();
    });

    // ── Hydrate location/pub from the route ─────────────────────────
    //
    // Precedence:
    //   1. meta sp:pub  → per-pub landing page (PR #2)
    //   2. meta sp:area → city landing page
    //   3. ?lat=&lng=   → shared GPS coords on the homepage
    //   4. nothing      → default location + try GPS in the background

    const labelEl = document.getElementById("location-label");

    if (metaPub) {
      landingSlug = metaPub;
      const pub = state.pubs.find((p) => p.slug === metaPub);
      if (pub) {
        state.selectedPubId = pub.id;
        setLocation(pub.lat, pub.lng, { keepPub: true });
        if (labelEl && pub.town) labelEl.textContent = pub.town;
        if (pub.town) setLocationQuery(pub.town);
        await onPubSelected(pub);
      } else {
        // Stale slug — fall back to home behaviour.
        void defaultHomeHydration(labelEl);
      }
    } else if (metaArea && metaAreaLat != null && metaAreaLng != null) {
      // City landing page. Centre on the supplied coordinates and DO NOT
      // auto-request GPS — we don't want to silently relocate a user who
      // arrived from a "/<city>/" Google result to wherever they happen
      // to be standing.
      setLocation(metaAreaLat, metaAreaLng);
      const name = metaAreaName || metaArea;
      if (labelEl) labelEl.textContent = name;
      setLocationQuery(name);
    } else if (
      urlState.route.kind === "home" &&
      urlState.route.lat != null &&
      urlState.route.lng != null
    ) {
      // Shared GPS coords URL — adopt the shared coords as if the user
      // had picked them, so a returning visit to "/" hydrates here too.
      const coordLabel = `${urlState.route.lat.toFixed(3)}, ${urlState.route.lng.toFixed(3)}`;
      setLocation(urlState.route.lat, urlState.route.lng, {
        persistAs: "search",
        label: coordLabel,
      });
      if (labelEl) labelEl.textContent = coordLabel;
    } else {
      // Plain homepage — default centre, GPS in background. Also show
      // the welcome modal on the very first visit so people understand
      // what they're looking at instead of staring at a random Norwich
      // pub. The modal is suppressed on landing pages (city/theme/pub)
      // because those URLs already have explicit intent.
      defaultHomeHydration(labelEl);
      // Defer slightly so the porthole has a chance to paint underneath
      // and the modal feels like an overlay on a real page rather than
      // a popup on a blank screen.
      setTimeout(() => maybeShowWelcome(), 150);
    }

    // Theme toggle in footer.
    const themeButtons = document.querySelectorAll<HTMLButtonElement>(".theme-toggle button");
    function updateThemeButtons(): void {
      const current = getStoredTheme();
      themeButtons.forEach((b) => {
        b.classList.toggle("active", b.dataset.theme === current);
      });
    }
    themeButtons.forEach((b) => {
      b.addEventListener("click", () => {
        setTheme((b.dataset.theme as Theme) ?? "system");
        updateThemeButtons();
      });
    });
    updateThemeButtons();

    // Now button — reset time to current. Also clear the user-driven flag
    // so writeURL stops emitting ?t= and the URL goes back to clean.
    document.getElementById("btn-now")!.addEventListener("click", () => {
      state.timeMins = ukTimeMins(new Date());
      state.date = new Date();
      clearTimeUserDriven();
      updateScene();
      renderArc();
    });

    // Mobile pub drawer toggle.
    document.getElementById("pubs-handle")!.addEventListener("click", () => {
      document.getElementById("pubs")!.classList.toggle("open");
    });

    // Share button.
    document.getElementById("btn-share")!.addEventListener("click", () => shareSnapshot());

    // Directions button — opens selected pub in Google Maps.
    document.getElementById("btn-directions")?.addEventListener("click", () => {
      const pub = selectedPub();
      if (!pub) return;
      window.open(googleMapsUrl(pub.name, pub.lat, pub.lng), "_blank");
    });
  } catch (err) {
    console.error("Init failed:", err);
    const labelEl = document.getElementById("location-label");
    if (labelEl) labelEl.textContent = "Error — check console";
  }
}

init();
