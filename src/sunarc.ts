/**
 * Sun arc time picker canvas widget.
 *
 * Shows the sun's altitude arc for the day. Click/drag to scrub time.
 * Play button animates sunrise to sunset.
 */

import { state, pubCenter } from "./state";
import { renderCircle } from "./circle";
import { computeShadows } from "./shadow";
import { setPlayIcon } from "./icons";
import { drawSunCanvas, drawMoonCanvas } from "./canvas-icons";
import type { SunPosition } from "./types";
import SunCalc from "suncalc";

// ── Constants ─────────────────────────────────────────────────────────────

const PAD_X = 24;
const PAD_TOP = 20;
const PAD_BOT = 14;
const PLAY_SPEED = 120; // minutes per second

const COLORS = {
  arcDay: "#F59E0B",
  arcNight: "#64748B",
  fillDay: "rgba(254,243,199,0.25)",
  fillNight: "rgba(100,116,139,0.08)",
  horizonDay: "#E2E8F0",
  horizonNight: "#4A5568",
  sunFill: "#F59E0B",
  sunStroke: "#D97706",
  sunGlow: "rgba(245,158,11,0.6)",
  moonFill: "#94A3B8",
  lineDay: "rgba(245,158,11,0.3)",
  lineNight: "rgba(100,116,139,0.3)",
  labelDay: "#A0AEC0",
  timeDay: "#4A5568",
  timeNight: "#64748B",
};

// ── State ─────────────────────────────────────────────────────────────────

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let playAnimId: number | null = null;
let lastPlayTime: number | null = null;
let btnPlay: HTMLButtonElement;
let timeDisplay: HTMLSpanElement;
let dragging = false;

// Cached arc points (recomputed on date change).
let arcPoints: { mins: number; alt: number }[] = [];
let sunriseMins = 0;
let sunsetMins = 0;

// ── Init ──────────────────────────────────────────────────────────────────

export function initSunArc(onTimeChange: () => void): void {
  canvas = document.getElementById("arc-canvas") as HTMLCanvasElement;
  btnPlay = document.getElementById("btn-play") as HTMLButtonElement;
  timeDisplay = document.getElementById("time-display") as HTMLSpanElement;

  // Size canvas.
  const resize = () => {
    const w = canvas.parentElement!.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = 110 * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = "110px";
    ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    computeArc();
    renderArc();
  };
  window.addEventListener("resize", resize);
  resize();

  // Click/drag interaction.
  const getTime = (e: MouseEvent | Touch) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width - PAD_X * 2;
    const frac = Math.max(0, Math.min(1, (x - PAD_X) / w));
    // Map fraction to the visible time range (centred on solar noon).
    const solarNoon = (sunriseMins + sunsetMins) / 2;
    const halfSpan = (sunsetMins - sunriseMins) / 2 + 120;
    const mins = solarNoon - halfSpan + frac * halfSpan * 2;
    return Math.max(0, Math.min(1440, Math.round(mins / 5) * 5));
  };

  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    state.timeMins = getTime(e);
    onTimeChange();
    renderArc();
  });
  canvas.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    state.timeMins = getTime(e);
    updateTimeDisplay();
    renderArc();
  });
  canvas.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      onTimeChange();
    }
  });
  canvas.addEventListener("mouseleave", () => {
    if (dragging) {
      dragging = false;
      onTimeChange();
    }
  });

  // Touch support.
  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    dragging = true;
    state.timeMins = getTime(e.touches[0]);
    onTimeChange();
    renderArc();
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (!dragging) return;
    state.timeMins = getTime(e.touches[0]);
    updateTimeDisplay();
    renderArc();
  }, { passive: false });
  canvas.addEventListener("touchend", () => {
    if (dragging) {
      dragging = false;
      onTimeChange();
    }
  });

  // Play button.
  btnPlay.addEventListener("click", () => {
    if (state.playing) {
      stopPlay();
    } else {
      startPlay(onTimeChange);
    }
  });

  // Date picker.
  const btnDate = document.getElementById("btn-date") as HTMLButtonElement;
  const dateInput = document.getElementById("date-input") as HTMLInputElement;
  dateInput.value = state.date.toISOString().slice(0, 10);

  btnDate.addEventListener("click", () => dateInput.showPicker());
  dateInput.addEventListener("change", () => {
    const parts = dateInput.value.split("-");
    state.date = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    btnDate.textContent = isToday(state.date) ? "Today" : dateInput.value;
    computeArc();
    onTimeChange();
    renderArc();
  });
}

function isToday(d: Date): boolean {
  const now = new Date();
  return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

// ── Arc computation ───────────────────────────────────────────────────────

function computeArc(): void {
  const centre = pubCenter();
  const times = SunCalc.getTimes(state.date, centre.lat, centre.lng);
  sunriseMins = times.sunrise.getHours() * 60 + times.sunrise.getMinutes();
  sunsetMins = times.sunset.getHours() * 60 + times.sunset.getMinutes();

  arcPoints = [];
  for (let m = 0; m <= 1440; m += 3) {
    const d = new Date(state.date);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(m);
    const pos = SunCalc.getPosition(d, centre.lat, centre.lng);
    arcPoints.push({ mins: m, alt: (pos.altitude * 180) / Math.PI });
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderArc(): void {
  if (!ctx) return;
  const W = canvas.width / (window.devicePixelRatio || 1);
  const H = 110;
  const areaW = W - PAD_X * 2;
  const areaH = H - PAD_TOP - PAD_BOT;

  ctx.clearRect(0, 0, W, H);

  // X-axis: centre on solar noon, show sunrise-2h to sunset+2h.
  const solarNoon = (sunriseMins + sunsetMins) / 2;
  const halfSpan = (sunsetMins - sunriseMins) / 2 + 120; // +2h each side
  const xMin = solarNoon - halfSpan;
  const xMax = solarNoon + halfSpan;

  // Y-axis: show above and below horizon. Horizon at 65% height (more room above).
  const maxAlt = Math.max(...arcPoints.map((p) => p.alt), 1);
  const minAlt = Math.min(...arcPoints.filter((p) => p.mins >= xMin && p.mins <= xMax).map((p) => p.alt), -5);
  const altRange = maxAlt - minAlt;

  const toX = (mins: number) => PAD_X + ((mins - xMin) / (xMax - xMin)) * areaW;
  const toY = (alt: number) => PAD_TOP + areaH - ((alt - minAlt) / altRange) * areaH;

  // Current sun state — smooth dayFrac matching porthole.
  const currentAlt = interpolateAlt(state.timeMins);
  const dayFrac = Math.min(Math.max((currentAlt + 2) / 10, 0), 1);
  const isNight = currentAlt <= 0;

  // Horizon line.
  const horizonY = toY(0);
  ctx.beginPath();
  ctx.moveTo(PAD_X, horizonY);
  ctx.lineTo(W - PAD_X, horizonY);
  const hR = Math.round(74 + (226 - 74) * dayFrac);
  const hG = Math.round(85 + (232 - 85) * dayFrac);
  const hB = Math.round(104 + (240 - 104) * dayFrac);
  ctx.strokeStyle = `rgb(${hR},${hG},${hB})`;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Below-horizon fill (subtle dark tint).
  ctx.fillStyle = "rgba(26,26,46,0.06)";
  ctx.fillRect(PAD_X, horizonY, areaW, PAD_TOP + areaH - horizonY);

  // Fill under arc above horizon (sunrise to sunset).
  ctx.beginPath();
  ctx.moveTo(toX(sunriseMins), horizonY);
  for (const p of arcPoints) {
    if (p.mins < sunriseMins || p.mins > sunsetMins) continue;
    if (p.alt <= 0) continue;
    ctx.lineTo(toX(p.mins), toY(p.alt));
  }
  ctx.lineTo(toX(sunsetMins), horizonY);
  ctx.closePath();
  const fillAlpha = 0.06 + 0.19 * dayFrac;
  ctx.fillStyle = dayFrac > 0.5
    ? `rgba(254,243,199,${fillAlpha.toFixed(2)})`
    : `rgba(100,116,139,${(fillAlpha * 0.4).toFixed(2)})`;
  ctx.fill();

  // Arc curve — full curve including below horizon.
  ctx.beginPath();
  let first = true;
  for (const p of arcPoints) {
    if (p.mins < xMin || p.mins > xMax) continue;
    const x = toX(p.mins);
    const y = toY(p.alt);
    if (first) { ctx.moveTo(x, y); first = false; }
    else ctx.lineTo(x, y);
  }
  // Arc stroke — interpolated color.
  const arcR = Math.round(100 + 145 * dayFrac);
  const arcG = Math.round(116 + 42 * dayFrac);
  const arcB = Math.round(139 - 128 * dayFrac);
  ctx.strokeStyle = `rgb(${arcR},${arcG},${arcB})`;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Redraw below-horizon portion with dashed night style.
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  first = true;
  for (const p of arcPoints) {
    if (p.mins < xMin || p.mins > xMax) continue;
    if (p.alt >= 0) { first = true; continue; }
    const x = toX(p.mins);
    const y = toY(p.alt);
    if (first) { ctx.moveTo(x, y); first = false; }
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#4A5568";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  // Vertical line from current position to horizon.
  const curX = toX(state.timeMins);
  const curY = toY(currentAlt);
  ctx.beginPath();
  ctx.moveTo(curX, curY);
  ctx.lineTo(curX, horizonY);
  const lineAlpha = 0.15 + 0.2 * dayFrac;
  ctx.strokeStyle = `rgba(${arcR},${arcG},${arcB},${lineAlpha.toFixed(2)})`;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Sun/moon icon — same Lucide icons as porthole, smooth crossfade.
  const iconSize = 7;
  if (dayFrac < 0.3) {
    drawMoonCanvas(ctx, curX, curY, iconSize);
  } else if (dayFrac > 0.7) {
    drawSunCanvas(ctx, curX, curY, iconSize);
  } else {
    const t = (dayFrac - 0.3) / 0.4;
    drawMoonCanvas(ctx, curX, curY, iconSize, 1 - t);
    drawSunCanvas(ctx, curX, curY, iconSize, t);
  }

  // Sunrise/sunset labels — positioned at their x positions.
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = COLORS.labelDay;
  ctx.textAlign = "center";
  ctx.fillText(formatTime(sunriseMins), toX(sunriseMins), H - 2);
  ctx.fillText(formatTime(sunsetMins), toX(sunsetMins), H - 2);

  // Current time label above/below dot.
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  const tR = Math.round(100 + (51 - 100) * dayFrac);
  const tG = Math.round(116 + (65 - 116) * dayFrac);
  const tB = Math.round(139 + (85 - 139) * dayFrac);
  ctx.fillStyle = `rgb(${tR},${tG},${tB})`;
  const labelY = currentAlt >= 0 ? curY - 10 : curY + 14;
  ctx.fillText(formatTime(state.timeMins), curX, labelY);

  updateTimeDisplay();
}

/** Interpolate altitude at a given time from arc points. */
function interpolateAlt(mins: number): number {
  for (let i = 1; i < arcPoints.length; i++) {
    if (arcPoints[i].mins >= mins) {
      const p0 = arcPoints[i - 1];
      const p1 = arcPoints[i];
      const t = (mins - p0.mins) / (p1.mins - p0.mins);
      return p0.alt + t * (p1.alt - p0.alt);
    }
  }
  return arcPoints[arcPoints.length - 1]?.alt ?? 0;
}

export { renderArc };

// ── Animation ─────────────────────────────────────────────────────────────

function startPlay(onTimeChange: () => void): void {
  if (state.timeMins >= sunsetMins) {
    state.timeMins = sunriseMins;
  }

  state.playing = true;
  setPlayIcon(true);
  lastPlayTime = performance.now();

  const frame = (now: number) => {
    if (!state.playing) return;

    const dt = (now - (lastPlayTime ?? now)) / 1000;
    lastPlayTime = now;

    state.timeMins += dt * PLAY_SPEED;

    if (state.timeMins >= sunsetMins) {
      state.timeMins = sunsetMins;
      stopPlay();
      onTimeChange();
      return;
    }

    onTimeChange();
    renderArc();
    playAnimId = requestAnimationFrame(frame);
  };

  playAnimId = requestAnimationFrame(frame);
}

function stopPlay(): void {
  state.playing = false;
  setPlayIcon(false);
  lastPlayTime = null;
  if (playAnimId != null) {
    cancelAnimationFrame(playAnimId);
    playAnimId = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function updateTimeDisplay(): void {
  timeDisplay.textContent = formatTime(state.timeMins);
}

function formatTime(mins: number): string {
  const total = Math.round(mins);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
