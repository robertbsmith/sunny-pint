import "./style.css";

import SunCalc from "suncalc";
import { loadBuildingsForPub } from "./buildings";
import { initCircle, renderCircle } from "./circle";
import {
  DEFAULT_LAT,
  DEFAULT_LNG,
  DEFAULT_LOCATION_NAME,
  googleMapsUrl,
  NOMINATIM_URL,
  USER_AGENT,
} from "./config";
import { parseHours } from "./hours";
import { initIcons } from "./icons";
import { initLocation } from "./location";
import { initPubList, renderList, sortByDistance } from "./publist";
import { computeShadows, isTerrainOccluded } from "./shadow";
import { shareSnapshot } from "./share";
import { selectedPub, state } from "./state";
import { initSunArc, renderArc } from "./sunarc";
import { largeSunBadgeHtml, smallSunBadgeHtml } from "./sunbadge";
import type { Pub } from "./types";
import {
  clearTimeUserDriven,
  markTimeUserDriven,
  onPopState,
  readURL,
  setBasePath,
  setLocationQuery,
  withSuppressedWrites,
  writeURL,
  writeURLDebounced,
} from "./url";
import { getWeather, weatherEmoji, weatherLabel } from "./weather";

async function loadPubs(): Promise<void> {
  const resp = await fetch("/data/pubs.json");
  const pubs: Pub[] = await resp.json();
  state.pubs = pubs;
}

/** Recompute shadows and redraw everything for current time. */
function updateScene(): void {
  const pub = selectedPub();
  if (!pub) return;

  const d = new Date(state.date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(state.timeMins);
  const pos = SunCalc.getPosition(d, pub.lat, pub.lng);
  const sun = {
    azimuth: ((pos.azimuth * 180) / Math.PI + 180) % 360,
    altitude: (pos.altitude * 180) / Math.PI,
  };

  // Terrain occlusion: if a hill blocks the sun, no shadows at all.
  if (isTerrainOccluded(pub, sun)) {
    state.shadowPolys = [];
  } else {
    state.shadowPolys = computeShadows(state.buildings, sun, pub.elev ?? 0);
  }

  const canvas = document.getElementById("circle-canvas") as HTMLCanvasElement;
  renderCircle(canvas);

  writeURLDebounced();
}

async function onPubSelected(pub: Pub): Promise<void> {
  // Close mobile drawer and scroll back to the porthole. Targets both
  // window and #main so it works whether the page or main is the
  // scroll container.
  document.getElementById("pubs")?.classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.getElementById("main")?.scrollTo({ top: 0, behavior: "smooth" });
  updatePubInfo(pub);
  // Immediate URL push so the browser back button has a real history entry
  // for this pub. updateScene() then runs the debounced writer for any
  // subsequent time scrubbing on top.
  writeURL();
  await loadBuildingsForPub(pub);
  updateScene();
}

function updatePubInfo(pub: Pub): void {
  const card = document.getElementById("pub-info");
  if (!card) return;
  card.hidden = false;

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

  // Compact rating overlay on the porthole itself (top-left corner).
  const portholeRatingEl = document.getElementById("porthole-rating");
  if (portholeRatingEl) portholeRatingEl.innerHTML = smallSunBadgeHtml(pub);

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
    const domain = pub.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    links.push(
      `<a href="${escapeHtml(pub.website)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a>`,
    );
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

function setLocation(lat: number, lng: number, opts: { keepPub?: boolean } = {}): void {
  state.userLat = lat;
  state.userLng = lng;
  sortByDistance(lat, lng);

  // Fetch weather in background.
  fetchWeather(lat, lng);

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
      setLocation(latitude, longitude);
      try {
        const resp = await fetch(
          `${NOMINATIM_URL}/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=16`,
          { headers: { "User-Agent": USER_AGENT } },
        );
        const data = (await resp.json()) as { address?: Record<string, string> };
        const addr = data.address ?? {};
        const local =
          addr.neighbourhood || addr.suburb || addr.quarter || addr.hamlet || addr.city_district;
        const main = addr.city || addr.town || addr.village || addr.municipality;
        const name =
          local && main && local !== main ? `${local}, ${main}` : local || main || "your location";
        if (labelEl) labelEl.textContent = name;
        setLocationQuery(name);
      } catch {
        if (labelEl) labelEl.textContent = "Your location";
      }
      writeURL();
    },
    () => {
      if (labelEl) labelEl.textContent = DEFAULT_LOCATION_NAME;
    },
    { timeout: 5000, maximumAge: 60000 },
  );
}

// ── Init ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
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
    const now = new Date();
    if (urlState.time != null) {
      state.timeMins = urlState.time;
      markTimeUserDriven();
    } else {
      state.timeMins = now.getHours() * 60 + now.getMinutes();
    }
    if (urlState.date) state.date = urlState.date;

    // Init UI components. Wrap the sun-arc callback so any user-driven time
    // change (scrub or play) flips the URL flag and writeURL starts emitting
    // ?t= for sharing/reload preservation.
    initPubList(onPubSelected);
    initCircle();
    initSunArc(() => {
      markTimeUserDriven();
      updateScene();
    });

    // Load pub data.
    await loadPubs();
    console.log(`Loaded ${state.pubs.length} pubs`);

    // Location picker (GPS + search).
    initLocation((lat, lng) => {
      setLocation(lat, lng);
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
        }
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
      // Shared GPS coords URL.
      setLocation(urlState.route.lat, urlState.route.lng);
      if (labelEl) {
        labelEl.textContent = `${urlState.route.lat.toFixed(3)}, ${urlState.route.lng.toFixed(3)}`;
      }
    } else {
      // Plain homepage — default centre, GPS in background.
      defaultHomeHydration(labelEl);
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
      const now = new Date();
      state.timeMins = now.getHours() * 60 + now.getMinutes();
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
