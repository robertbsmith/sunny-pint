/**
 * Porthole circle canvas renderer.
 *
 * Draws the main visualisation: map tiles as background, building polygons,
 * shadow polygons, porthole bezel with compass, sun/moon icon, and overlays.
 */

import { state, selectedPub, pubCenter } from "./state";
import type { Building, ShadowPoly, SunPosition } from "./types";
import { drawSunCanvas, drawMoonCanvas } from "./canvas-icons";
import SunCalc from "suncalc";

// ── Tile loading ──────────────────────────────────────────────────────────

const TILE_URL =
  "https://cartodb-basemaps-a.global.ssl.fastly.net/rastertiles/voyager_labels_under/{z}/{x}/{y}.png";
const TILE_ZOOM = 18;
const tileCache = new Map<string, HTMLImageElement>();

let pendingRedraw: number | null = null;
let isRendering = false;

function loadTile(z: number, x: number, y: number, canvas: HTMLCanvasElement): HTMLImageElement | null {
  const key = `${z}_${x}_${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached.complete ? cached : null;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    // Only redraw if we're not already mid-render (prevents loops).
    if (isRendering) return;
    if (pendingRedraw != null) cancelAnimationFrame(pendingRedraw);
    pendingRedraw = requestAnimationFrame(() => {
      pendingRedraw = null;
      renderCircle(canvas);
    });
  };
  img.onerror = () => {
    // Remove failed tiles so we don't retry endlessly.
    tileCache.delete(key);
  };
  img.src = TILE_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  tileCache.set(key, img);
  return null;
}

// ── Coordinate conversions ────────────────────────────────────────────────

const M_PER_DEG_LAT = 111320;

function mPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Convert lat/lng to pixel position relative to circle centre. */
function toPixel(
  lat: number,
  lng: number,
  centreLatLng: { lat: number; lng: number },
  metersPerPixel: number,
): { x: number; y: number } {
  const dx = (lng - centreLatLng.lng) * mPerDegLng(centreLatLng.lat);
  const dy = (lat - centreLatLng.lat) * M_PER_DEG_LAT;
  return { x: dx / metersPerPixel, y: -dy / metersPerPixel }; // y inverted for canvas
}

/** Lat/lng to Web Mercator tile coordinates. */
function lngLatToTile(lng: number, lat: number, z: number): { tx: number; ty: number; px: number; py: number } {
  const n = 2 ** z;
  const tx = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const ty = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return {
    tx: Math.floor(tx),
    ty: Math.floor(ty),
    px: (tx - Math.floor(tx)) * 256,
    py: (ty - Math.floor(ty)) * 256,
  };
}

// ── Sun position ──────────────────────────────────────────────────────────

function getSunPosition(): SunPosition {
  const centre = pubCenter();
  const d = new Date(state.date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(state.timeMins);
  const pos = SunCalc.getPosition(d, centre.lat, centre.lng);
  return {
    azimuth: ((pos.azimuth * 180) / Math.PI + 180) % 360, // convert to compass bearing
    altitude: (pos.altitude * 180) / Math.PI,
  };
}

function getSunTimes(): { sunrise: number; sunset: number } {
  const centre = pubCenter();
  const times = SunCalc.getTimes(state.date, centre.lat, centre.lng);
  const toMins = (d: Date) => d.getHours() * 60 + d.getMinutes();
  return { sunrise: toMins(times.sunrise), sunset: toMins(times.sunset) };
}

// ── Drawing constants ─────────────────────────────────────────────────────

const BEZEL = 14;
const OUTER_PAD = 22; // space outside bezel for compass labels + time text

/** Metres per pixel at a given latitude and zoom level (Web Mercator). */
function tileMetresPerPixel(lat: number, z: number): number {
  return (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

const COLORS = {
  bezelDay: ["#E2E8F0", "#CBD5E0", "#94A3B8"],
  bezelNight: ["#4A5568", "#2D3748", "#1A202C"],
  buildingFill: "rgba(140,150,165,0.85)",
  buildingStroke: "#6B7280",
  pubFill: "rgba(217,119,6,0.65)",
  pubStroke: "#B45309",
  buildingNightFill: "rgba(40,40,60,0.9)",
  buildingNightStroke: "#4A5568",
  pubNightFill: "rgba(180,100,50,0.7)",
  pubNightStroke: "#B45C32",
  shadowFill: "#1E1E3C",
  outdoorFill: "rgba(39,174,96,0.18)",
  outdoorStroke: "#27AE60",
  nightTint: "rgba(26,26,46,",
  pubMarker: "#E53E3E",
  sun: "#F59E0B",
  sunStroke: "#D97706",
  moon: "#94A3B8",
  northTick: "#E53E3E",
  tickDay: "#94A3B8",
  tickNight: "#4A5568",
  textDay: "#4A5568",
  textNight: "#64748B",
  sunPctDay: "rgba(214,158,46,0.9)",
  nameDay: "#2D3748",
  nameNight: "#94A3B8",
};

// ── Color interpolation ───────────────────────────────────────────────────

/** Lerp between two hex colors by t (0=a, 1=b). */
function lerpColor(a: string, b: string, t: number): string {
  const parse = (c: string) => [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ];
  const ca = parse(a);
  const cb = parse(b);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// ── Offscreen shadow canvas ───────────────────────────────────────────────

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

function getOffscreen(w: number, h: number): CanvasRenderingContext2D {
  if (!offscreenCanvas || offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
    offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
    offscreenCtx = offscreenCanvas.getContext("2d")!;
  }
  return offscreenCtx!;
}

// ── Main render function ──────────────────────────────────────────────────

export function renderCircle(canvas: HTMLCanvasElement): void {
  isRendering = true;
  const ctx = canvas.getContext("2d")!;
  // Use logical (CSS) size, not physical (DPR-scaled) pixel size.
  const W = parseInt(canvas.dataset.logicalW || String(canvas.width));
  const H = parseInt(canvas.dataset.logicalH || String(canvas.height));
  const cx = W / 2;
  // Max extent from circle centre: time text at outerR + 16 (base) + 10 (bump) + 8 (half char width)
  // = r + BEZEL + 34. Must fit in W/2.
  const MARGIN = BEZEL + 34;
  const r = W / 2 - MARGIN - 2;
  const outerR = r + BEZEL;
  const cy = outerR + MARGIN + 4;

  const sun = getSunPosition();
  // dayFrac: 0 = full night, 1 = full day. Smooth transition over -2° to +8° altitude.
  const dayFrac = Math.min(Math.max((sun.altitude + 2) / 10, 0), 1);

  const centre = pubCenter();
  const mpp = tileMetresPerPixel(centre.lat, TILE_ZOOM);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ── 1. Bezel ring ──
  drawBezel(ctx, cx, cy, r, outerR, dayFrac);

  // ── 2. Clip to inner circle ──
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  // ── 3. Map tile background ──
  drawTiles(ctx, cx, cy, r, centre);

  // ── 4. Night tint — smooth fade ──
  if (dayFrac < 1) {
    const alpha = (1 - dayFrac) * 0.6;
    ctx.fillStyle = `${COLORS.nightTint}${alpha.toFixed(3)})`;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // ── 5. Shadows (fade in with daylight) ──
  if (dayFrac > 0 && state.shadowPolys.length > 0) {
    drawShadows(ctx, cx, cy, r, W, H, centre, mpp, sun.altitude, dayFrac);
  }

  // ── 7. Buildings ──
  drawBuildings(ctx, cx, cy, centre, mpp, dayFrac);

  // ── 8. Outdoor area ──
  drawOutdoorArea(ctx, cx, cy, centre, mpp, dayFrac);

  // ── 9. Pub marker ──
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.pubMarker;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore(); // unclip

  // ── 10. Compass ticks + labels ──
  drawCompass(ctx, cx, cy, r, outerR, dayFrac);

  // ── 11. Sun/moon icon on bezel ──
  drawSunIcon(ctx, cx, cy, r, outerR, sun, dayFrac);

  // ── 12. Time text ──
  drawTimeText(ctx, cx, cy, r, outerR, sun, dayFrac);

  // ── 13. Sun % text ──
  drawSunPct(ctx, cx, cy, r, sun, dayFrac);

  // ── 14. Pub sign ──
  updatePubSign();

  isRendering = false;
}

// ── Sub-renderers ─────────────────────────────────────────────────────────

function drawBezel(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, outerR: number,
  dayFrac: number,
): void {
  // Outer drop shadow for depth.
  ctx.save();
  ctx.shadowColor = `rgba(0,0,0,${0.1 + 0.1 * (1 - dayFrac)})`;
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  const isDarkTheme = document.documentElement.classList.contains("dark");
  if (isDarkTheme) {
    ctx.fillStyle = lerpColor("#1A1A1A", "#3A3A3A", dayFrac);
  } else {
    ctx.fillStyle = lerpColor("#D0CCC6", "#E8E6E2", dayFrac);
  }
  ctx.fill();
  ctx.restore();

  // Main bezel ring.
  const grad = ctx.createRadialGradient(cx, cy - outerR * 0.3, r * 0.8, cx, cy, outerR);
  if (isDarkTheme) {
    grad.addColorStop(0, lerpColor("#2A2A2A", "#484440", dayFrac));
    grad.addColorStop(0.4, lerpColor("#1E1E1E", "#383430", dayFrac));
    grad.addColorStop(1, lerpColor("#111111", "#282420", dayFrac));
  } else {
    grad.addColorStop(0, lerpColor("#D8D4CE", "#F0EDE8", dayFrac));
    grad.addColorStop(0.4, lerpColor("#C8C4BE", "#E0DCD6", dayFrac));
    grad.addColorStop(1, lerpColor("#B0ACA6", "#C8C4BE", dayFrac));
  }

  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
  ctx.fillStyle = grad;
  ctx.fill();

  // Inner rim — subtle amber highlight in daylight, cool in night.
  ctx.beginPath();
  ctx.arc(cx, cy, r + 0.5, 0, Math.PI * 2);
  const rimAlpha = 0.08 + 0.15 * dayFrac;
  ctx.strokeStyle = dayFrac > 0.5
    ? `rgba(245,158,11,${rimAlpha.toFixed(2)})`
    : `rgba(200,200,200,${rimAlpha.toFixed(2)})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Outer rim.
  ctx.beginPath();
  ctx.arc(cx, cy, outerR - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawTiles(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  centre: { lat: number; lng: number },
): void {
  const z = TILE_ZOOM;
  const { tx, ty, px, py } = lngLatToTile(centre.lng, centre.lat, z);

  // Draw 3×3 grid of tiles.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const img = loadTile(z, tx + dx, ty + dy, ctx.canvas);
      if (img) {
        const drawX = cx - px + dx * 256;
        const drawY = cy - py + dy * 256;
        ctx.drawImage(img, drawX, drawY, 256, 256);
      }
    }
  }
}

function drawShadows(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  W: number, H: number,
  centre: { lat: number; lng: number },
  mpp: number, altitude: number, dayFrac: number,
): void {
  const offCtx = getOffscreen(W, H);
  offCtx.clearRect(0, 0, W, H);
  offCtx.fillStyle = COLORS.shadowFill;

  for (const poly of state.shadowPolys) {
    offCtx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const p = toPixel(poly[i][0], poly[i][1], centre, mpp);
      if (i === 0) offCtx.moveTo(cx + p.x, cy + p.y);
      else offCtx.lineTo(cx + p.x, cy + p.y);
    }
    offCtx.closePath();
    offCtx.fill();
  }

  // Composite — opacity fades smoothly with dayFrac.
  const alpha = dayFrac * Math.min(altitude / 8, 0.5);
  ctx.globalAlpha = alpha;
  ctx.drawImage(offscreenCanvas!, 0, 0);
  ctx.globalAlpha = 1;
}

function drawBuildings(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  centre: { lat: number; lng: number },
  mpp: number, dayFrac: number,
): void {
  // Interpolate building colors based on day/night.
  const bFillR = Math.round(40 + 100 * dayFrac);
  const bFillG = Math.round(40 + 110 * dayFrac);
  const bFillB = Math.round(60 + 105 * dayFrac);
  const buildFill = `rgba(${bFillR},${bFillG},${bFillB},0.85)`;
  const buildStroke = lerpColor("#4A5568", "#6B7280", dayFrac);

  const pubFillR = Math.round(180 + 37 * dayFrac);
  const pubFillG = Math.round(100 + 19 * dayFrac);
  const pubFillB = Math.round(50 - 44 * dayFrac);
  const pubFill = `rgba(${pubFillR},${pubFillG},${pubFillB},0.65)`;
  const pubStroke = lerpColor("#B45C32", "#B45309", dayFrac);

  for (let i = 0; i < state.buildings.length; i++) {
    const b = state.buildings[i];
    const isPub = i === state.pubBuildingIndex;

    ctx.beginPath();
    for (let j = 0; j < b.coords.length; j++) {
      const p = toPixel(b.coords[j][0], b.coords[j][1], centre, mpp);
      if (j === 0) ctx.moveTo(cx + p.x, cy + p.y);
      else ctx.lineTo(cx + p.x, cy + p.y);
    }
    ctx.closePath();

    ctx.fillStyle = isPub ? pubFill : buildFill;
    ctx.strokeStyle = isPub ? pubStroke : buildStroke;
    ctx.lineWidth = isPub ? 2 : 1;
    ctx.fill();
    ctx.stroke();
  }
}

function drawOutdoorArea(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  centre: { lat: number; lng: number },
  mpp: number, dayFrac: number,
): void {
  const pub = selectedPub();
  if (!pub) return;
  if (!pub.outdoor) return;

  ctx.beginPath();
  for (let i = 0; i < pub.outdoor.length; i++) {
    const p = toPixel(pub.outdoor[i][0], pub.outdoor[i][1], centre, mpp);
    if (i === 0) ctx.moveTo(cx + p.x, cy + p.y);
    else ctx.lineTo(cx + p.x, cy + p.y);
  }
  ctx.closePath();

  const greenAlpha = 0.12 + 0.12 * dayFrac;
  ctx.fillStyle = `rgba(39,174,96,${greenAlpha.toFixed(2)})`;
  ctx.fill();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#27AE60";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawCompass(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, outerR: number,
  dayFrac: number,
): void {
  const labels = ["N", "E", "S", "W"];
  const tickColor = lerpColor("#4A5568", "#94A3B8", dayFrac);

  for (let i = 0; i < 8; i++) {
    const angle = (i * 45 - 90) * (Math.PI / 180);
    const isMajor = i % 2 === 0;
    const inner = r + 2;
    const outer = r + BEZEL * 0.5;

    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.strokeStyle = tickColor;
    ctx.lineWidth = isMajor ? 2 : 1;
    ctx.stroke();
  }

  // Cardinal labels — outside the bezel.
  ctx.font = "bold 15px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const labelR = outerR + 14;

  for (let i = 0; i < 4; i++) {
    const angle = (i * 90 - 90) * (Math.PI / 180);
    const x = cx + Math.cos(angle) * labelR;
    const y = cy + Math.sin(angle) * labelR;
    const isDark = document.documentElement.classList.contains("dark");
    const labelColor = isDark
      ? lerpColor("#D4D0CC", "#F0ECE8", dayFrac)
      : lerpColor("#2A2825", "#1A1815", dayFrac);
    ctx.fillStyle = i === 0 ? "#E53E3E" : labelColor;
    ctx.fillText(labels[i], x, y);
  }
}

function drawSunIcon(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, outerR: number,
  sun: SunPosition, dayFrac: number,
): void {
  const angle = (sun.azimuth - 90) * (Math.PI / 180);
  const iconR = r + BEZEL * 0.5;
  const x = cx + Math.cos(angle) * iconR;
  const y = cy + Math.sin(angle) * iconR;
  const iconSize = 10;

  if (dayFrac < 0.3) {
    drawMoonCanvas(ctx, x, y, iconSize);
  } else if (dayFrac > 0.7) {
    drawSunCanvas(ctx, x, y, iconSize);
  } else {
    // Twilight crossfade.
    const t = (dayFrac - 0.3) / 0.4;
    drawMoonCanvas(ctx, x, y, iconSize, 1 - t);
    drawSunCanvas(ctx, x, y, iconSize, t);
  }
}

function drawTimeText(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, outerR: number,
  sun: SunPosition, dayFrac: number,
): void {
  const total = Math.round(state.timeMins);
  const hours = Math.floor(total / 60) % 24;
  const mins = total % 60;
  const text = `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;

  // Time follows the sun's azimuth around the bezel.
  const sunAngle = (sun.azimuth - 90) * (Math.PI / 180);
  const baseTextR = outerR + 16;
  const bumpR = 10;
  const charSpacing = 8 / baseTextR;
  // Four cardinals at canvas angles.
  const cardinalAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

  // Compute ONE bump radius for the whole text based on its centre angle.
  function bumpForAngle(angle: number): number {
    let minDist = Math.PI;
    for (const c of cardinalAngles) {
      let d = angle - c;
      // Normalize to -PI..PI.
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) < minDist) minDist = Math.abs(d);
    }
    const t = Math.max(0, 1 - minDist / 0.5);
    return t * t * (3 - 2 * t) * bumpR;
  }

  const textR = baseTextR + bumpForAngle(sunAngle);

  ctx.font = "bold 13px system-ui, sans-serif";
  const isDarkTime = document.documentElement.classList.contains("dark");
  ctx.fillStyle = isDarkTime
    ? lerpColor("#D4D0CC", "#F0ECE8", dayFrac)
    : lerpColor("#2A2825", "#1A1815", dayFrac);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const startAngle = sunAngle - ((text.length - 1) * charSpacing) / 2;
  for (let i = 0; i < text.length; i++) {
    const a = startAngle + i * charSpacing;
    const tx = cx + textR * Math.cos(a);
    const ty = cy + textR * Math.sin(a);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  }
}

function drawSunPct(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  sun: SunPosition, dayFrac: number,
): void {
  if (dayFrac < 0.3) {
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.moon;
    ctx.globalAlpha = 1 - dayFrac / 0.3; // fade out as dawn approaches
    ctx.fillText("\u263D", cx, cy - r + 22);
    ctx.globalAlpha = 1;
  }
  // TODO: compute actual sun percentage on outdoor area
}

// ── Coat of arms (Armoria API) ─────────────────────────────────────────────

const coaCache = new Map<string, HTMLImageElement | null>();

function getCoatOfArms(name: string): HTMLImageElement | null {
  if (coaCache.has(name)) {
    const img = coaCache.get(name)!;
    return img?.complete ? img : null;
  }

  // Mark as loading.
  coaCache.set(name, null);

  const seed = encodeURIComponent(name);
  const url = `https://armoria.herokuapp.com/?seed=${seed}&format=svg&size=80`;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    coaCache.set(name, img);
    // Trigger re-render of sign.
    lastSignPubId = null;
    const canvas = document.getElementById("circle-canvas") as HTMLCanvasElement;
    if (canvas) renderCircle(canvas);
  };
  img.onerror = () => {
    // Failed — don't retry.
    coaCache.set(name, null);
  };
  img.src = url;
  return null;
}

// ── Pub sign (hanging sign above porthole) ────────────────────────────────

let signCanvas: HTMLCanvasElement | null = null;
let lastSignPubId: string | null = null;

function updatePubSign(): void {
  const pub = selectedPub();
  if (!pub) return;
  if (pub.id === lastSignPubId) return; // no change
  lastSignPubId = pub.id;

  if (!signCanvas) {
    signCanvas = document.createElement("canvas");
    signCanvas.id = "pub-sign";
    // Attach to #viz (the full-width section) so it reaches the left edge.
    const viz = document.getElementById("viz");
    if (viz) {
      viz.style.position = "relative";
      viz.appendChild(signCanvas);
    }
  }

  const dpr = window.devicePixelRatio || 1;
  // Width: from left edge of viz to roughly halfway across the porthole.
  const viz = document.getElementById("viz")!;
  const circleWrap = document.getElementById("circle-wrap")!;
  const vizRect = viz.getBoundingClientRect();
  const circleRect = circleWrap.getBoundingClientRect();
  const signEndX = circleRect.left - vizRect.left + circleRect.width * 0.05;
  const w = Math.max(130, Math.round(signEndX));
  const h = 110;
  signCanvas.width = w * dpr;
  signCanvas.height = h * dpr;
  signCanvas.style.width = `${w}px`;
  signCanvas.style.height = `${h}px`;
  signCanvas.style.position = "absolute";
  signCanvas.style.top = "0";
  signCanvas.style.left = "0";
  signCanvas.style.pointerEvents = "none";
  signCanvas.style.zIndex = "10";

  const ctx = signCanvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  drawPubSign(ctx, w, h, pub.name);
}

/** Simple hash from string to number. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Generate a warm hue from pub name for the sign background. */
function pubColor(name: string): { bg: string; accent: string; text: string } {
  const h = hashStr(name);
  // Warm hues: 15-50 (oranges/browns/ambers).
  const hue = 15 + (h % 40);
  const sat = 30 + (h % 25);
  return {
    bg: `hsl(${hue}, ${sat}%, 22%)`,
    accent: `hsl(${hue}, ${sat + 10}%, 35%)`,
    text: `hsl(${hue}, ${sat - 10}%, 85%)`,
  };
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawPubSign(ctx: CanvasRenderingContext2D, W: number, H: number, name: string): void {
  const colors = pubColor(name);
  const isDark = document.documentElement.classList.contains("dark");

  const iron = isDark ? "#5A5550" : "#3E3A35";
  const ironHi = isDark ? "#7A756E" : "#5A5550";

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  function ironBar(lineW: number = 3): void {
    ctx.strokeStyle = iron;
    ctx.lineWidth = lineW;
    ctx.stroke();
    ctx.strokeStyle = ironHi;
    ctx.lineWidth = lineW * 0.3;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Key positions (all relative to W and H) ──
  const plateX = 0;       // wall = left edge
  const plateW = 6;
  const armY = 16;         // arm height
  const armStartX = plateX + plateW - 1; // arm starts at right edge of plate
  const armEndX = W - 6;  // arm tip
  const armLen = armEndX - armStartX;

  // Sign hangs close to the wall.
  const signW = Math.min(140, W * 0.8);
  const signH = 52;
  const signX = armEndX - signW + 4; // right-aligned to arm end
  const signY = H - signH - 4;
  const signCx = signX + signW / 2;
  const r = 4;

  // Chain attachment points on the sign.
  const hookL = signX + 14;
  const hookR = signX + signW - 14;

  // ── 1. Backplate ──
  ctx.fillStyle = iron;
  ctx.beginPath();
  ctx.rect(plateX, armY - 16, plateW, 46);
  ctx.fill();
  // Bolts.
  ctx.fillStyle = ironHi;
  for (const by of [armY - 11, armY + 1, armY + 13, armY + 24]) {
    ctx.beginPath();
    ctx.arc(plateW / 2, by, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = iron;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(plateW / 2 - 1.5, by);
    ctx.lineTo(plateW / 2 + 1.5, by);
    ctx.stroke();
  }

  // ── 2. Main arm (plate → armEnd) ──
  ctx.beginPath();
  ctx.moveTo(armStartX, armY);
  ctx.bezierCurveTo(
    armStartX + armLen * 0.3, armY - 4,
    armStartX + armLen * 0.7, armY - 2,
    armEndX, armY,
  );
  ironBar(3.5);

  // ── 3. Top scroll (curls up from plate near arm junction) ──
  const scrollW = Math.min(armLen * 0.35, 35);
  ctx.beginPath();
  ctx.moveTo(armStartX, armY - 1);
  ctx.bezierCurveTo(
    armStartX + scrollW * 0.3, armY - 12,
    armStartX + scrollW * 0.8, armY - 14,
    armStartX + scrollW, armY - 8,
  );
  ctx.bezierCurveTo(
    armStartX + scrollW * 1.05, armY - 4,
    armStartX + scrollW * 0.85, armY - 1,
    armStartX + scrollW * 0.65, armY - 1,
  );
  ironBar(2);

  // ── 4. Bottom brace (plate → curves down → back up to arm) ──
  const braceDropY = armY + Math.min(28, H * 0.28);
  ctx.beginPath();
  ctx.moveTo(armStartX, armY + 6);
  ctx.bezierCurveTo(
    armStartX + armLen * 0.1, braceDropY,
    armStartX + armLen * 0.3, braceDropY + 2,
    armStartX + armLen * 0.5, braceDropY - 10,
  );
  ctx.bezierCurveTo(
    armStartX + armLen * 0.7, armY + 6,
    armStartX + armLen * 0.85, armY + 2,
    armEndX - 4, armY + 1,
  );
  ironBar(2.5);

  // ── 5. Fill scroll (between arm and brace, near wall) ──
  const fs1x = armStartX + armLen * 0.12;
  ctx.beginPath();
  ctx.moveTo(fs1x, armY + 4);
  ctx.bezierCurveTo(fs1x + 6, armY + 14, fs1x + 16, armY + 12, fs1x + 12, armY + 4);
  ironBar(1.5);

  // ── 6. Finial (ball + point at arm tip) ──
  ctx.fillStyle = iron;
  ctx.beginPath();
  ctx.arc(armEndX + 2, armY, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(armEndX + 5, armY);
  ctx.lineTo(armEndX + 9, armY - 1.5);
  ctx.lineTo(armEndX + 9, armY + 1.5);
  ctx.closePath();
  ctx.fill();

  // ── 7. Hooks (under the arm at chain points) ──
  for (const hx of [hookL, hookR]) {
    // Vertical stub down from arm.
    ctx.strokeStyle = iron;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hx, armY + 1);
    ctx.lineTo(hx, armY + 6);
    ctx.stroke();
    // Small hook curl.
    ctx.beginPath();
    ctx.arc(hx, armY + 6, 2.5, 0, Math.PI);
    ctx.stroke();
  }

  // ── 8. Chains (hooks → sign rings) ──
  const chainTop = armY + 9;
  const chainBot = signY - 1;
  const chainLen = chainBot - chainTop;
  const linkCount = Math.max(2, Math.round(chainLen / 8));

  for (const cx of [hookL, hookR]) {
    const dy = chainLen / linkCount;
    for (let i = 0; i < linkCount; i++) {
      const ly = chainTop + i * dy + dy / 2;
      ctx.beginPath();
      ctx.ellipse(cx, ly, 2.5, dy * 0.35, 0, 0, Math.PI * 2);
      ctx.strokeStyle = i % 2 === 0 ? iron : ironHi;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
  }

  // ── 9. Sign rings (at top of sign board) ──
  for (const rx of [hookL, hookR]) {
    ctx.beginPath();
    ctx.arc(rx, signY + 2, 3, 0, Math.PI * 2);
    ctx.strokeStyle = iron;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // ── 10. Sign board — shape varies by pub name ──
  const shapeIdx = hashStr(name) % 4;

  function signPath(): void {
    const cx = signX + signW / 2;
    switch (shapeIdx) {
      case 1: // Arched top.
        ctx.moveTo(signX, signY + signH);
        ctx.lineTo(signX, signY + signH * 0.35);
        ctx.quadraticCurveTo(signX, signY, cx, signY);
        ctx.quadraticCurveTo(signX + signW, signY, signX + signW, signY + signH * 0.35);
        ctx.lineTo(signX + signW, signY + signH);
        ctx.closePath();
        break;
      case 2: // Pointed bottom (pennant).
        ctx.roundRect(signX, signY, signW, signH * 0.75, r);
        ctx.moveTo(signX, signY + signH * 0.74);
        ctx.lineTo(cx, signY + signH);
        ctx.lineTo(signX + signW, signY + signH * 0.74);
        break;
      case 3: // Oval.
        ctx.ellipse(cx, signY + signH / 2, signW / 2, signH / 2, 0, 0, Math.PI * 2);
        break;
      default: // Rectangle.
        ctx.roundRect(signX, signY, signW, signH, r);
    }
  }

  function signFramePath(): void {
    const cx = signX + signW / 2;
    const i = 4; // inset
    const l = signX + i;
    const rr = signX + signW - i;
    const t = signY + i;
    const b = signY + signH - i;
    switch (shapeIdx) {
      case 1: // Arched top.
        ctx.moveTo(l, b);
        ctx.lineTo(l, t + signH * 0.3);
        ctx.quadraticCurveTo(l, t, cx, t);
        ctx.quadraticCurveTo(rr, t, rr, t + signH * 0.3);
        ctx.lineTo(rr, b);
        ctx.closePath();
        break;
      case 2: // Pennant.
        ctx.moveTo(l + r, t);
        ctx.lineTo(rr - r, t);
        ctx.arcTo(rr, t, rr, t + r, r - 1);
        ctx.lineTo(rr, signY + signH * 0.72);
        ctx.lineTo(cx, b);
        ctx.lineTo(l, signY + signH * 0.72);
        ctx.lineTo(l, t + r);
        ctx.arcTo(l, t, l + r, t, r - 1);
        break;
      case 3: // Oval.
        ctx.ellipse(cx, signY + signH / 2, signW / 2 - i, signH / 2 - i, 0, 0, Math.PI * 2);
        break;
      default: // Rectangle.
        ctx.roundRect(l, t, signW - i * 2, signH - i * 2, r - 1);
    }
  }

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  signPath();
  ctx.fillStyle = colors.bg;
  ctx.fill();
  ctx.restore();

  // Wood grain.
  ctx.save();
  ctx.beginPath();
  signPath();
  ctx.clip();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = colors.text;
  ctx.lineWidth = 0.5;
  const hash = hashStr(name);
  for (let i = 0; i < 10; i++) {
    const gy = signY + 3 + (i * (signH - 6)) / 10 + ((hash >> i) % 2);
    ctx.beginPath();
    ctx.moveTo(signX, gy);
    ctx.lineTo(signX + signW, gy);
    ctx.stroke();
  }
  ctx.restore();

  // ── Safe text area per shape (inset from edges where text won't clip) ──
  // [top, bottom, left, right] insets from sign bounds.
  const safeInset = (() => {
    switch (shapeIdx) {
      case 1: return { top: 14, bot: 6, side: 8 };  // arched: more top room for curve
      case 2: return { top: 8, bot: signH * 0.32, side: 8 }; // pennant: avoid pointed bottom
      case 3: return { top: 14, bot: 14, side: 18 }; // oval: tight all around
      default: return { top: 8, bot: 8, side: 8 };  // rect: even padding
    }
  })();

  const safeTop = signY + safeInset.top;
  const safeBot = signY + signH - safeInset.bot;
  const safeH = safeBot - safeTop;
  const safeLeft = signX + safeInset.side;
  const safeRight = signX + signW - safeInset.side;

  // Coat of arms (loaded async from Armoria).
  const coaImg = getCoatOfArms(name);
  const coaSize = Math.min(safeH - 4, 36); // cap size to safe height
  let coaActualW = 0;

  if (coaImg) {
    const coaX = safeLeft;
    const coaY = safeTop + (safeH - coaSize) / 2;
    ctx.save();
    ctx.beginPath();
    signPath();
    ctx.clip();
    ctx.drawImage(coaImg, coaX, coaY, coaSize, coaSize);
    ctx.restore();
    coaActualW = coaSize + 4;
  }

  // Gold frame.
  ctx.beginPath();
  signFramePath();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // ── 11. Pub name — clipped to sign, positioned in safe area ──
  const textLeft = safeLeft + coaActualW;
  const textRight = safeRight;
  const textW = textRight - textLeft;
  const textCenterX = textLeft + textW / 2;

  // Clip text to sign shape.
  ctx.save();
  ctx.beginPath();
  signPath();
  ctx.clip();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = colors.text;

  let fontSize = 12;
  ctx.font = `700 ${fontSize}px Georgia, serif`;
  let lines = wrapText(ctx, name, textW - 2);

  // Shrink until it fits.
  const maxLines = safeH > 30 ? 3 : 2;
  while ((lines.length > maxLines || (lines.length === 1 && ctx.measureText(name).width > textW - 2)) && fontSize > 7) {
    fontSize--;
    ctx.font = `700 ${fontSize}px Georgia, serif`;
    lines = wrapText(ctx, name, textW - 2);
  }
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);

  const lineHeight = fontSize + 2;
  const textBlockH = lines.length * lineHeight;
  const textStartY = safeTop + (safeH - textBlockH) / 2 + lineHeight / 2;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textCenterX, textStartY + i * lineHeight);
  }
  ctx.restore();
}

// ── Canvas sizing ─────────────────────────────────────────────────────────

export function sizeCanvas(canvas: HTMLCanvasElement, container: HTMLElement): void {
  const w = Math.min(container.clientWidth, 500);
  const margin = BEZEL + 34;
  const rCalc = w / 2 - margin - 2;
  const h = Math.round(2 * (rCalc + BEZEL + margin + 4));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  // Store logical size for rendering.
  canvas.dataset.logicalW = String(w);
  canvas.dataset.logicalH = String(h);
}

/** Init the circle canvas — call once on startup. */
export function initCircle(): void {
  const canvas = document.getElementById("circle-canvas") as HTMLCanvasElement;
  const wrap = document.getElementById("circle-wrap")!;

  const resize = () => {
    sizeCanvas(canvas, wrap);
    renderCircle(canvas);
  };

  window.addEventListener("resize", resize);
  resize();
}
