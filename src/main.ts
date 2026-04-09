import "./style.css";

import { state, selectedPub } from "./state";
import type { Pub } from "./types";
import { initPubList, sortByDistance, renderList } from "./publist";
import { initCircle, renderCircle } from "./circle";
import { initSunArc, renderArc } from "./sunarc";
import { computeShadows, isTerrainOccluded } from "./shadow";
import { loadBuildingsForPub } from "./buildings";
import { initIcons, updateThemeIcon } from "./icons";
import { initLocation } from "./location";
import { readURL, writeURL, writeURLDebounced, setLocationQuery } from "./url";
import { shareSnapshot } from "./share";
import { getWeather, weatherEmoji, weatherLabel } from "./weather";
import { parseHours } from "./hours";
import SunCalc from "suncalc";

// Norwich default location.
const DEFAULT_LAT = 52.6309;
const DEFAULT_LNG = 1.2974;

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
  const card = document.getElementById("pub-info")!;
  card.hidden = false;

  // Name + status.
  const hours = parseHours(pub.opening_hours);
  const nameEl = document.getElementById("pub-info-name")!;
  if (hours) {
    const cls = hours.isOpen ? "status-open" : "status-closed";
    nameEl.innerHTML = `${pub.name} <span class="${cls}">${hours.statusLabel}</span>`;
  } else {
    nameEl.textContent = pub.name;
  }

  // Brand + next change.
  const brandParts = [pub.brand, pub.brewery].filter(Boolean);
  if (hours?.nextChangeLabel) brandParts.push(hours.nextChangeLabel);
  document.getElementById("pub-info-brand")!.textContent = brandParts.join(" · ");

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

  document.getElementById("pub-info-grid")!.innerHTML =
    cell("Real ale", pub.real_ale) +
    cell("Outdoor", pub.outdoor_seating || pub.beer_garden) +
    cell("Food", pub.food) +
    cell("Dogs", pub.dog) +
    cell("Wheelchair", pub.wheelchair) +
    cell("WiFi", pub.wifi);

  // Hours — weekly table or raw string.
  const hoursEl = document.getElementById("pub-info-hours")!;
  if (hours?.weeklyTable) {
    hoursEl.innerHTML = `<table class="hours-table">${hours.weeklyTable.map((r) =>
      `<tr class="${r.isToday ? "hours-today" : ""}"><td>${r.day}</td><td>${r.hours}</td></tr>`
    ).join("")}</table>`;
  } else if (pub.opening_hours) {
    hoursEl.innerHTML = `<span class="cell-label">Hours</span> ${pub.opening_hours}`;
  } else {
    hoursEl.innerHTML = `<span class="cell-label">Hours</span> <span class="val-unknown">\u2013</span>`;
  }

  // Links.
  const links: string[] = [];
  if (pub.phone) links.push(`<a href="tel:${pub.phone}">${pub.phone}</a>`);
  if (pub.website) {
    const domain = pub.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    links.push(`<a href="${pub.website}" target="_blank" rel="noopener">${domain}</a>`);
  }
  const query = encodeURIComponent(pub.name);
  links.push(`<a href="https://www.google.com/maps/search/${query}/@${pub.lat},${pub.lng},17z" target="_blank" rel="noopener">Directions</a>`);
  document.getElementById("pub-info-links")!.innerHTML = links.join(" · ");
}

function setLocation(lat: number, lng: number): void {
  state.userLat = lat;
  state.userLng = lng;
  sortByDistance(lat, lng);

  // Fetch weather in background.
  fetchWeather(lat, lng);

  if (state.pubs.length > 0) {
    if (!state.selectedPubId) {
      state.selectedPubId = state.pubs[0].id;
      onPubSelected(state.pubs[0]);
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
    theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  localStorage.setItem("theme", theme);
}

function setTheme(theme: Theme): void {
  applyTheme(theme);
  updateThemeIcon();
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
      // Set pub ID first so setLocation doesn't auto-select a different pub.
      state.selectedPubId = urlPub.id;
      setLocation(urlPub.lat, urlPub.lng);
      const label = urlState.query || "Norwich";
      document.getElementById("location-label")!.textContent = `Pubs near ${label}`;
      if (urlState.query) setLocationQuery(urlState.query);
      renderList();
      await onPubSelected(urlPub);
    } else if (urlState.query) {
      // Search term but no pub — geocode and sort.
      try {
        const resp = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(urlState.query)}&countrycodes=gb&limit=1`,
          { headers: { "User-Agent": "SunnyPint/0.1" } },
        );
        const results = await resp.json();
        if (results.length > 0) {
          setLocation(parseFloat(results[0].lat), parseFloat(results[0].lon));
        } else {
          setLocation(DEFAULT_LAT, DEFAULT_LNG);
        }
      } catch {
        setLocation(DEFAULT_LAT, DEFAULT_LNG);
      }
      document.getElementById("location-label")!.textContent = `Pubs near ${urlState.query}`;
      setLocationQuery(urlState.query);
    } else if (urlState.lat != null && urlState.lng != null) {
      setLocation(urlState.lat, urlState.lng);
      document.getElementById("location-label")!.textContent = `Pubs near ${urlState.lat.toFixed(3)}, ${urlState.lng.toFixed(3)}`;
    } else {
      // No URL params — default to Norwich, try GPS in background.
      setLocation(DEFAULT_LAT, DEFAULT_LNG);
      document.getElementById("location-label")!.textContent = "Pubs near Norwich";
      setLocationQuery("Norwich");

      if (navigator.geolocation) {
        document.getElementById("location-label")!.textContent = "Finding your location...";
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            const { latitude, longitude } = pos.coords;
            setLocation(latitude, longitude);
            try {
              const resp = await fetch(
                `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14`,
                { headers: { "User-Agent": "SunnyPint/0.1" } },
              );
              const data = await resp.json();
              const name = data.address?.city || data.address?.town || data.address?.village || data.address?.suburb || "your location";
              document.getElementById("location-label")!.textContent = `Pubs near ${name}`;
              setLocationQuery(name);
            } catch {
              document.getElementById("location-label")!.textContent = "Pubs near you";
            }
            writeURL();
          },
          () => {
            document.getElementById("location-label")!.textContent = "Pubs near Norwich";
          },
          { timeout: 5000, maximumAge: 60000 },
        );
      }
    }

    // Theme select.
    document.getElementById("theme-select")!.addEventListener("change", (e) => {
      setTheme((e.target as HTMLSelectElement).value as Theme);
    });

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

    // Directions button — opens selected pub in maps.
    document.getElementById("btn-directions")!.addEventListener("click", () => {
      const pub = selectedPub();
      if (!pub) return;
      const query = encodeURIComponent(pub.name);
      window.open(`https://www.google.com/maps/search/${query}/@${pub.lat},${pub.lng},17z`, "_blank");
    });
  } catch (err) {
    console.error("Init failed:", err);
    document.getElementById("location-label")!.textContent = "Error — check console";
  }
}

init();
