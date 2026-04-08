import "./style.css";

import { state, selectedPub } from "./state";
import type { Pub } from "./types";
import { initPubList, sortByDistance, renderList } from "./publist";
import { initCircle, renderCircle } from "./circle";
import { initSunArc } from "./sunarc";
import { computeShadows } from "./shadow";
import { loadBuildingsForPub } from "./buildings";
import { initIcons } from "./icons";
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

  state.shadowPolys = computeShadows(state.buildings, sun);

  const canvas = document.getElementById("circle-canvas") as HTMLCanvasElement;
  renderCircle(canvas);
}

async function onPubSelected(pub: Pub): Promise<void> {
  await loadBuildingsForPub(pub);
  updateScene();
}

function setLocation(lat: number, lng: number): void {
  state.userLat = lat;
  state.userLng = lng;
  sortByDistance(lat, lng);

  const label = document.getElementById("location-label")!;
  label.textContent = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;

  if (state.pubs.length > 0) {
    if (!state.selectedPubId) {
      state.selectedPubId = state.pubs[0].id;
      onPubSelected(state.pubs[0]);
    }
    renderList();
  }
}

function requestGeolocation(): void {
  if (!navigator.geolocation) {
    setLocation(DEFAULT_LAT, DEFAULT_LNG);
    return;
  }

  const label = document.getElementById("location-label")!;
  label.textContent = "Locating...";

  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude),
    () => setLocation(DEFAULT_LAT, DEFAULT_LNG),
    { timeout: 5000, maximumAge: 60000 },
  );
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

function cycleTheme(): void {
  const order: Theme[] = ["system", "light", "dark"];
  const current = getStoredTheme();
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
  initIcons();
  // Re-render canvas with new theme colors.
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

    // Init UI components.
    initPubList(onPubSelected);
    initCircle();
    initSunArc(updateScene);

    // Load pub data.
    await loadPubs();
    console.log(`Loaded ${state.pubs.length} pubs`);

    // Set time to now.
    const now = new Date();
    state.timeMins = now.getHours() * 60 + now.getMinutes();

    // Render immediately with default location.
    setLocation(DEFAULT_LAT, DEFAULT_LNG);

    // Wire up buttons.
    document.getElementById("btn-locate")!.addEventListener("click", requestGeolocation);
    document.getElementById("location-label")!.addEventListener("click", requestGeolocation);
    document.getElementById("btn-theme")!.addEventListener("click", cycleTheme);

    // Try GPS in background.
    requestGeolocation();
  } catch (err) {
    console.error("Init failed:", err);
    document.getElementById("location-label")!.textContent = "Error — check console";
  }
}

init();
