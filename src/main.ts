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
import type { Pub } from "./types";
import { readURL, setLocationQuery, writeURL, writeURLDebounced } from "./url";
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
  // Close mobile drawer.
  document.getElementById("pubs")?.classList.remove("open");
  updatePubInfo(pub);
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

    // Set time — URL param, or now.
    const now = new Date();
    state.timeMins = urlState.time ?? now.getHours() * 60 + now.getMinutes();
    if (urlState.date) state.date = urlState.date;

    // Init UI components.
    initPubList(onPubSelected);
    initCircle();
    initSunArc(updateScene);

    // Load pub data.
    await loadPubs();
    console.log(`Loaded ${state.pubs.length} pubs`);

    // Location picker (GPS + search).
    initLocation((lat, lng) => {
      setLocation(lat, lng);
      writeURL();
    });

    // If URL specifies a pub, use that pub's location as the sort centre.
    const urlPub = urlState.pubId ? state.pubs.find((p) => p.id === urlState.pubId) : null;

    if (urlPub) {
      // URL specified a pub — use it as the centre and keep it selected.
      state.selectedPubId = urlPub.id;
      setLocation(urlPub.lat, urlPub.lng, { keepPub: true });
      const label = urlState.query || "Norwich";
      document.getElementById("location-label")!.textContent = label;
      if (urlState.query) setLocationQuery(urlState.query);
      await onPubSelected(urlPub);
    } else if (urlState.query) {
      // Search term but no pub — geocode and sort.
      try {
        const resp = await fetch(
          `${NOMINATIM_URL}/search?format=json&q=${encodeURIComponent(urlState.query)}&countrycodes=gb&limit=1`,
          { headers: { "User-Agent": USER_AGENT } },
        );
        const results = (await resp.json()) as Array<{ lat: string; lon: string }>;
        const first = results[0];
        if (first) {
          setLocation(parseFloat(first.lat), parseFloat(first.lon));
        } else {
          setLocation(DEFAULT_LAT, DEFAULT_LNG);
        }
      } catch {
        setLocation(DEFAULT_LAT, DEFAULT_LNG);
      }
      document.getElementById("location-label")!.textContent = urlState.query;
      setLocationQuery(urlState.query);
    } else if (urlState.lat != null && urlState.lng != null) {
      setLocation(urlState.lat, urlState.lng);
      document.getElementById("location-label")!.textContent =
        `${urlState.lat.toFixed(3)}, ${urlState.lng.toFixed(3)}`;
    } else {
      // No URL params — default to Norwich, try GPS in background.
      setLocation(DEFAULT_LAT, DEFAULT_LNG);
      const labelEl = document.getElementById("location-label");
      if (labelEl) labelEl.textContent = DEFAULT_LOCATION_NAME;
      setLocationQuery(DEFAULT_LOCATION_NAME);

      if (navigator.geolocation) {
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
                addr.neighbourhood ||
                addr.suburb ||
                addr.quarter ||
                addr.hamlet ||
                addr.city_district;
              const main = addr.city || addr.town || addr.village || addr.municipality;
              const name =
                local && main && local !== main
                  ? `${local}, ${main}`
                  : local || main || "your location";
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

    // Now button — reset time to current.
    document.getElementById("btn-now")!.addEventListener("click", () => {
      const now = new Date();
      state.timeMins = now.getHours() * 60 + now.getMinutes();
      state.date = new Date();
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
