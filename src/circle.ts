/**
 * Porthole canvas renderer.
 *
 * Composites the main visualisation: basemap tiles, building polygons,
 * geometric shadows, outdoor area outline, bezel ring with compass, sun/moon
 * icon and time text, plus the hanging pub sign above the porthole.
 *
 * All shadow polygons are drawn to an offscreen canvas first then composited
 * with a single alpha blit, which gives uniform shadow opacity regardless of
 * how many overlapping building shadows are stacked.
 */

import SunCalc from "suncalc";
import { drawMoonCanvas, drawSunCanvas } from "./canvas-icons";
import {
  DAY_FRAC_OFFSET,
  DAY_FRAC_RANGE,
  M_PER_DEG_LAT,
  PORTHOLE_RADIUS_M,
  TILE_ZOOM,
  TWILIGHT_DAY,
  TWILIGHT_NIGHT,
} from "./config";
import { lngLatToTile, tileMetresPerPixel, toPixel } from "./geo";
import { drawPubSign, measureSignLayout, type SignLayout } from "./sign";
import { pubCenter, pubOrigin, selectedPub, state } from "./state";
import { isDark, lerpColor } from "./theme";
import { loadTile, setSuppressTileRedraw, setTileRedrawCallback } from "./tiles";
import { ukDateAt } from "./time";
import type { SunPosition } from "./types";

// ── Callbacks ────────────────────────────────────────────────────────────

let panChangeCallback: (() => void) | null = null;
let viewChangeCallback: (() => void) | null = null;

/** Register a callback for when the user finishes a pan drag. */
export function setPanChangeCallback(cb: () => void): void {
  panChangeCallback = cb;
}

/** Register a callback for when zoom/satellite changes via gesture. */
export function setViewChangeCallback(cb: () => void): void {
  viewChangeCallback = cb;
}

// ── Drawing constants ─────────────────────────────────────────────────────

const BEZEL = 14;
const COLORS = {
  shadowFill: "#1E1E3C",
  pubMarker: "#E53E3E",
  northTick: "#E53E3E",
  nightTint: "rgba(26,26,46,",
  moon: "#94A3B8",
};

// ── Sun position ──────────────────────────────────────────────────────────

function getSunPosition(): SunPosition {
  const centre = pubCenter();
  const d = ukDateAt(state.date, state.timeMins);
  const pos = SunCalc.getPosition(d, centre.lat, centre.lng);
  return {
    azimuth: ((pos.azimuth * 180) / Math.PI + 180) % 360,
    altitude: (pos.altitude * 180) / Math.PI,
  };
}

// ── Offscreen shadow canvas ───────────────────────────────────────────────

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

function getOffscreen(w: number, h: number): CanvasRenderingContext2D {
  if (!offscreenCanvas || offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
    offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
    offscreenCtx = offscreenCanvas.getContext("2d");
    if (!offscreenCtx) throw new Error("Failed to get 2d context");
  }
  return offscreenCtx as CanvasRenderingContext2D;
}

// ── Main render function ──────────────────────────────────────────────────

/** Render the porthole canvas at its current state. */
export function renderCircle(canvas: HTMLCanvasElement): void {
  setSuppressTileRedraw(true);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = parseInt(canvas.dataset.logicalW || String(canvas.width), 10);
  const H = parseInt(canvas.dataset.logicalH || String(canvas.height), 10);
  const cx = W / 2;
  const MARGIN = BEZEL + 34;
  const r = W / 2 - MARGIN - 2;
  const outerR = r + BEZEL;
  const cy = outerR + MARGIN + 4;

  const sun = getSunPosition();
  const dayFrac = Math.min(Math.max((sun.altitude + DAY_FRAC_OFFSET) / DAY_FRAC_RANGE, 0), 1);
  const dark = isDark();

  const centre = pubCenter();
  const zoom = TILE_ZOOM + Math.log2(state.zoomStep);
  const mpp = tileMetresPerPixel(centre.lat, zoom);
  const sat = state.satellite;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawBezel(ctx, cx, cy, r, outerR, dayFrac, dark);

  // Clip to inner circle for the map content.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  drawTiles(ctx, cx, cy, centre, zoom, sat);

  if (dayFrac < 1) {
    const alpha = (1 - dayFrac) * 0.6;
    ctx.fillStyle = `${COLORS.nightTint}${alpha.toFixed(3)})`;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  if (sat) {
    // In satellite mode: black out everything outside the garden + pub
    // building, then draw shadows clipped to the garden only.
    const pub = selectedPub();
    if (pub?.outdoor && pub.outdoor.length > 0) {
      // Black out everything outside the garden and pub building
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - r, cy - r, r * 2, r * 2);
      // Cut out the garden (evenodd leaves it visible)
      for (const ring of pub.outdoor) {
        for (let i = 0; i < ring.length; i++) {
          const point = ring[i];
          if (!point) continue;
          const p = toPixel(point[0], point[1], centre, mpp);
          if (i === 0) ctx.moveTo(cx + p.x, cy + p.y);
          else ctx.lineTo(cx + p.x, cy + p.y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = "#000";
      ctx.fill("evenodd");
      ctx.restore();

      // Draw the pub building filled + orange border (same as normal mode)
      const pubB = state.buildings[state.pubBuildingIndex];
      if (pubB) {
        const pubFillR = Math.round(180 + 37 * dayFrac);
        const pubFillG = Math.round(100 + 19 * dayFrac);
        const pubFillB = Math.round(50 - 44 * dayFrac);
        ctx.beginPath();
        for (let j = 0; j < pubB.coords.length; j++) {
          const coord = pubB.coords[j];
          if (!coord) continue;
          const p = toPixel(coord[0], coord[1], centre, mpp);
          if (j === 0) ctx.moveTo(cx + p.x, cy + p.y);
          else ctx.lineTo(cx + p.x, cy + p.y);
        }
        ctx.closePath();
        ctx.fillStyle = `rgba(${pubFillR},${pubFillG},${pubFillB},0.65)`;
        ctx.strokeStyle = lerpColor("#B45C32", "#B45309", dayFrac);
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      }

      // Draw shadows clipped to the garden area only
      if (dayFrac > 0 && state.shadowPolys.length > 0) {
        ctx.save();
        ctx.beginPath();
        for (const ring of pub.outdoor) {
          for (let i = 0; i < ring.length; i++) {
            const point = ring[i];
            if (!point) continue;
            const p = toPixel(point[0], point[1], centre, mpp);
            if (i === 0) ctx.moveTo(cx + p.x, cy + p.y);
            else ctx.lineTo(cx + p.x, cy + p.y);
          }
          ctx.closePath();
        }
        ctx.clip("evenodd");
        drawShadows(ctx, cx, cy, W, H, centre, mpp, sun.altitude, dayFrac);
        ctx.restore();
      }
    } else {
      // No outdoor area — just show shadows normally
      if (dayFrac > 0 && state.shadowPolys.length > 0) {
        drawShadows(ctx, cx, cy, W, H, centre, mpp, sun.altitude, dayFrac);
      }
    }
  } else {
    if (dayFrac > 0 && state.shadowPolys.length > 0) {
      drawShadows(ctx, cx, cy, W, H, centre, mpp, sun.altitude, dayFrac);
    }

    drawBuildings(ctx, cx, cy, centre, mpp, dayFrac);
    drawOutdoorArea(ctx, cx, cy, centre, mpp, dayFrac);
  }

  // Pub marker dot — drawn at real pub position (moves when panned).
  const origin = pubOrigin();
  const markerP = toPixel(origin.lat, origin.lng, centre, mpp);
  ctx.beginPath();
  ctx.arc(cx + markerP.x, cy + markerP.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.pubMarker;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore(); // unclip

  drawCompass(ctx, cx, cy, r, outerR, dayFrac, dark);
  drawSunIcon(ctx, cx, cy, r, sun, dayFrac);
  drawTimeText(ctx, cx, cy, outerR, sun, dayFrac, dark);
  drawSunPctMoon(ctx, cx, cy, r, dayFrac);

  updatePubSign();

  setSuppressTileRedraw(false);
}

// ── Sub-renderers ─────────────────────────────────────────────────────────

function drawBezel(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  outerR: number,
  dayFrac: number,
  dark: boolean,
): void {
  ctx.save();
  ctx.shadowColor = `rgba(0,0,0,${0.1 + 0.1 * (1 - dayFrac)})`;
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.fillStyle = dark
    ? lerpColor("#1A1A1A", "#3A3A3A", dayFrac)
    : lerpColor("#D0CCC6", "#E8E6E2", dayFrac);
  ctx.fill();
  ctx.restore();

  const grad = ctx.createRadialGradient(cx, cy - outerR * 0.3, r * 0.8, cx, cy, outerR);
  if (dark) {
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

  ctx.beginPath();
  ctx.arc(cx, cy, r + 0.5, 0, Math.PI * 2);
  const rimAlpha = 0.08 + 0.15 * dayFrac;
  ctx.strokeStyle =
    dayFrac > 0.5
      ? `rgba(245,158,11,${rimAlpha.toFixed(2)})`
      : `rgba(200,200,200,${rimAlpha.toFixed(2)})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, outerR - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawTiles(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  centre: { lat: number; lng: number },
  zoom: number,
  satellite: boolean,
): void {
  const { tx, ty, px, py } = lngLatToTile(centre.lng, centre.lat, zoom);
  // At higher zooms each tile covers fewer pixels relative to the viewport,
  // so we need more tiles. 3x3 at z18, 5x5 at z19, 7x7 at z20.
  const span = Math.ceil(1 + Math.log2(Math.max(1, zoom - TILE_ZOOM + 1)));
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      const img = loadTile(zoom, tx + dx, ty + dy, satellite);
      if (img) {
        ctx.drawImage(img, cx - px + dx * 256, cy - py + dy * 256, 256, 256);
      }
    }
  }
}

function drawShadows(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  W: number,
  H: number,
  centre: { lat: number; lng: number },
  mpp: number,
  altitude: number,
  dayFrac: number,
): void {
  const offCtx = getOffscreen(W, H);
  offCtx.clearRect(0, 0, W, H);
  offCtx.fillStyle = COLORS.shadowFill;

  // Terrain shadow: a half-plane from the ridge direction, positioned at
  // the computed shadow edge distance from the pub.
  const edgeM = state.terrainShadowEdgeM;
  if (edgeM !== null && edgeM < 300) {
    const az = state.terrainShadowAzimuth;
    const azRad = (az * Math.PI) / 180;

    // Shadow edge is perpendicular to the sun azimuth, at edgeM metres
    // from the pub in the anti-sun direction (toward the ridge).
    // Positive edgeM = shadow edge is between pub and ridge.
    // Negative edgeM = shadow extends past pub (full shade).
    const edgePx = edgeM / mpp;

    // Direction from pub toward the sun (compass → canvas, canvas y is down).
    const sunDx = Math.sin(azRad);
    const sunDy = -Math.cos(azRad);

    // Edge is sun-ward of pub by edgeM; shadow region is sun-ward of the edge
    // (between edge and ridge, which sits further sun-ward still).
    const edgeCx = cx + sunDx * edgePx;
    const edgeCy = cy + sunDy * edgePx;

    // True perpendicular (dot(perp, sun) = 0 at any azimuth).
    const perpDx = -sunDy;
    const perpDy = sunDx;
    const bigR = Math.max(W, H);

    offCtx.beginPath();
    offCtx.moveTo(edgeCx + perpDx * bigR, edgeCy + perpDy * bigR);
    offCtx.lineTo(edgeCx - perpDx * bigR, edgeCy - perpDy * bigR);
    offCtx.lineTo(edgeCx - perpDx * bigR + sunDx * bigR, edgeCy - perpDy * bigR + sunDy * bigR);
    offCtx.lineTo(edgeCx + perpDx * bigR + sunDx * bigR, edgeCy + perpDy * bigR + sunDy * bigR);
    offCtx.closePath();
    offCtx.fill();
  }

  // Building shadows.
  for (const poly of state.shadowPolys) {
    offCtx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const point = poly[i];
      if (!point) continue;
      const p = toPixel(point[0], point[1], centre, mpp);
      if (i === 0) offCtx.moveTo(cx + p.x, cy + p.y);
      else offCtx.lineTo(cx + p.x, cy + p.y);
    }
    offCtx.closePath();
    offCtx.fill();
  }

  const alpha = dayFrac * Math.min(altitude / 8, 0.5);
  ctx.globalAlpha = alpha;
  if (offscreenCanvas) ctx.drawImage(offscreenCanvas, 0, 0);
  ctx.globalAlpha = 1;
}

function drawBuildings(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  centre: { lat: number; lng: number },
  mpp: number,
  dayFrac: number,
): void {
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
    if (!b) continue;
    const isPub = i === state.pubBuildingIndex;

    ctx.beginPath();
    for (let j = 0; j < b.coords.length; j++) {
      const coord = b.coords[j];
      if (!coord) continue;
      const p = toPixel(coord[0], coord[1], centre, mpp);
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
  cx: number,
  cy: number,
  centre: { lat: number; lng: number },
  mpp: number,
  dayFrac: number,
): void {
  const pub = selectedPub();
  if (!pub?.outdoor || pub.outdoor.length === 0) return;

  ctx.beginPath();
  for (const ring of pub.outdoor) {
    for (let i = 0; i < ring.length; i++) {
      const point = ring[i];
      if (!point) continue;
      const p = toPixel(point[0], point[1], centre, mpp);
      if (i === 0) ctx.moveTo(cx + p.x, cy + p.y);
      else ctx.lineTo(cx + p.x, cy + p.y);
    }
    ctx.closePath();
  }

  const greenAlpha = 0.12 + 0.12 * dayFrac;
  ctx.fillStyle = `rgba(39,174,96,${greenAlpha.toFixed(2)})`;
  ctx.fill("evenodd");
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#27AE60";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawCompass(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  outerR: number,
  dayFrac: number,
  dark: boolean,
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

  ctx.font = "bold 15px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const labelR = outerR + 14;

  for (let i = 0; i < 4; i++) {
    const angle = (i * 90 - 90) * (Math.PI / 180);
    const x = cx + Math.cos(angle) * labelR;
    const y = cy + Math.sin(angle) * labelR;
    const labelColor = dark
      ? lerpColor("#D4D0CC", "#F0ECE8", dayFrac)
      : lerpColor("#2A2825", "#1A1815", dayFrac);
    ctx.fillStyle = i === 0 ? COLORS.northTick : labelColor;
    const label = labels[i];
    if (label) ctx.fillText(label, x, y);
  }
}

function drawSunIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  sun: SunPosition,
  dayFrac: number,
): void {
  const angle = (sun.azimuth - 90) * (Math.PI / 180);
  const iconR = r + BEZEL * 0.5;
  const x = cx + Math.cos(angle) * iconR;
  const y = cy + Math.sin(angle) * iconR;
  const iconSize = 10;

  if (dayFrac < TWILIGHT_NIGHT) {
    drawMoonCanvas(ctx, x, y, iconSize);
  } else if (dayFrac > TWILIGHT_DAY) {
    drawSunCanvas(ctx, x, y, iconSize);
  } else {
    const t = (dayFrac - TWILIGHT_NIGHT) / (TWILIGHT_DAY - TWILIGHT_NIGHT);
    drawMoonCanvas(ctx, x, y, iconSize, 1 - t);
    drawSunCanvas(ctx, x, y, iconSize, t);
  }
}

function drawTimeText(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  sun: SunPosition,
  dayFrac: number,
  dark: boolean,
): void {
  const total = Math.round(state.timeMins);
  const hours = Math.floor(total / 60) % 24;
  const mins = total % 60;
  const text = `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;

  const sunAngle = (sun.azimuth - 90) * (Math.PI / 180);
  const baseTextR = outerR + 16;
  const bumpR = 10;
  const charSpacing = 8 / baseTextR;
  const cardinalAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

  function bumpForAngle(angle: number): number {
    let minDist = Math.PI;
    for (const c of cardinalAngles) {
      let d = angle - c;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) < minDist) minDist = Math.abs(d);
    }
    const t = Math.max(0, 1 - minDist / 0.5);
    return t * t * (3 - 2 * t) * bumpR;
  }

  const textR = baseTextR + bumpForAngle(sunAngle);

  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.fillStyle = dark
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
    const ch = text[i];
    if (ch) ctx.fillText(ch, 0, 0);
    ctx.restore();
  }
}

function drawSunPctMoon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  dayFrac: number,
): void {
  if (dayFrac < TWILIGHT_NIGHT) {
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.moon;
    ctx.globalAlpha = 1 - dayFrac / TWILIGHT_NIGHT;
    ctx.fillText("\u263D", cx, cy - r + 22);
    ctx.globalAlpha = 1;
  }
}

// ── Pub sign ──────────────────────────────────────────────────────────────

let signCanvas: HTMLCanvasElement | null = null;
let lastSignKey: string | null = null;

function updatePubSign(): void {
  const pub = selectedPub();
  if (!pub) return;

  // Cache key includes theme so dark/light toggle redraws.
  const themeKey = isDark() ? "d" : "l";
  const cacheKey = `${pub.id}-${themeKey}`;
  if (cacheKey === lastSignKey) return;
  lastSignKey = cacheKey;

  if (!signCanvas) {
    signCanvas = document.createElement("canvas");
    signCanvas.id = "pub-sign";
    const viz = document.getElementById("viz");
    if (viz) {
      viz.style.position = "relative";
      viz.appendChild(signCanvas);
    }
  }

  const dpr = window.devicePixelRatio || 1;
  const viz = document.getElementById("viz");
  const circleWrap = document.getElementById("circle-wrap");
  if (!viz || !circleWrap) return;
  const vizRect = viz.getBoundingClientRect();
  const circleRect = circleWrap.getBoundingClientRect();
  const signEndX = circleRect.left - vizRect.left + circleRect.width * 0.15;
  const maxW = Math.max(140, Math.round(signEndX));

  const layout: SignLayout = measureSignLayout(pub.name, maxW);

  const w = maxW;
  const h = layout.canvasH;
  signCanvas.width = w * dpr;
  signCanvas.height = h * dpr;
  signCanvas.style.width = `${w}px`;
  signCanvas.style.height = `${h}px`;
  signCanvas.style.position = "absolute";
  signCanvas.style.top = "0";
  signCanvas.style.left = "0";
  signCanvas.style.pointerEvents = "none";
  signCanvas.style.zIndex = "10";

  const ctx = signCanvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  drawPubSign(ctx, w, h, pub.name, layout);
}

// ── Canvas sizing ─────────────────────────────────────────────────────────

/** Size the porthole canvas to fit its container, with DPR scaling. */
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
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  canvas.dataset.logicalW = String(w);
  canvas.dataset.logicalH = String(h);
}

/** Init the porthole canvas — call once on startup. */
export function initCircle(): void {
  const canvas = document.getElementById("circle-canvas") as HTMLCanvasElement;
  const wrap = document.getElementById("circle-wrap");
  if (!canvas || !wrap) return;

  const resize = (): void => {
    sizeCanvas(canvas, wrap);
    lastSignKey = null;
    renderCircle(canvas);
  };

  setTileRedrawCallback(() => renderCircle(canvas));
  window.addEventListener("resize", resize);
  resize();

  // ── Pan / drag ──────────────────────────────────────────────────
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function getMpp(): number {
    const zoom = TILE_ZOOM + Math.log2(state.zoomStep);
    return tileMetresPerPixel(pubCenter().lat, zoom);
  }

  function onDragStart(px: number, py: number): void {
    dragging = true;
    lastX = px;
    lastY = py;
  }

  /** Max pan distance in metres — bounded by outdoor area + building extent,
   *  or PORTHOLE_RADIUS_M if no outdoor area. */
  function panLimit(): number {
    const pub = selectedPub();
    if (!pub) return 0;
    const origin = pubOrigin();
    let maxDist = 0;
    const mPerDegLng = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);

    // Check outdoor area coords
    if (pub.outdoor) {
      for (const ring of pub.outdoor) {
        for (const point of ring) {
          if (!point) continue;
          const dx = (point[1] - origin.lng) * mPerDegLng;
          const dy = (point[0] - origin.lat) * M_PER_DEG_LAT;
          maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy));
        }
      }
    }

    // Check pub building coords
    const pubB = state.buildings[state.pubBuildingIndex];
    if (pubB) {
      for (const coord of pubB.coords) {
        if (!coord) continue;
        const dx = (coord[1] - origin.lng) * mPerDegLng;
        const dy = (coord[0] - origin.lat) * M_PER_DEG_LAT;
        maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy));
      }
    }

    // Allow panning up to the extent of the garden/building, scaled by zoom,
    // but at least enough to see the whole porthole radius at current zoom
    const viewRadius = PORTHOLE_RADIUS_M / state.zoomStep;
    return Math.max(maxDist, viewRadius);
  }

  function clampPan(): void {
    const limit = panLimit();
    const dist = Math.sqrt(state.panX ** 2 + state.panY ** 2);
    if (dist > limit) {
      const scale = limit / dist;
      state.panX *= scale;
      state.panY *= scale;
    }
  }

  function onDragMove(px: number, py: number): void {
    if (!dragging) return;
    const mpp = getMpp();
    const dx = px - lastX;
    const dy = py - lastY;
    state.panX -= dx * mpp;
    state.panY += dy * mpp;
    clampPan();
    lastX = px;
    lastY = py;
    renderCircle(canvas);
  }

  function onDragEnd(): void {
    if (dragging) {
      dragging = false;
      panChangeCallback?.();
    }
  }

  /** Check if a point (in canvas pixel coords) is inside the porthole circle. */
  function insidePorthole(px: number, py: number): boolean {
    const w = canvas.clientWidth;
    // Circle centre: horizontally centred, vertically offset by the sign area (32px).
    const cx = w / 2;
    const cy = 32 + w / 2;
    const r = w / 2;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!insidePorthole(e.offsetX, e.offsetY)) return;
    onDragStart(e.offsetX, e.offsetY);
    e.preventDefault();
  });
  canvas.addEventListener("mousemove", (e) => onDragMove(e.offsetX, e.offsetY));
  canvas.addEventListener("mouseup", onDragEnd);
  canvas.addEventListener("mouseleave", onDragEnd);

  canvas.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const rect = canvas.getBoundingClientRect();
      const px = t.clientX - rect.left;
      const py = t.clientY - rect.top;
      if (!insidePorthole(px, py)) return;
      onDragStart(px, py);
      e.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return; // only prevent scroll if we started a drag inside
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const rect = canvas.getBoundingClientRect();
      onDragMove(t.clientX - rect.left, t.clientY - rect.top);
      e.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener("touchend", onDragEnd);
  canvas.addEventListener("touchcancel", onDragEnd);

  // ── Mouse wheel zoom ────────────────────────────────────────────
  const ZOOM_STEPS: (1 | 2 | 4)[] = [1, 2, 4];

  function stepZoom(direction: 1 | -1): void {
    const idx = ZOOM_STEPS.indexOf(state.zoomStep);
    const next = idx + direction;
    if (next < 0 || next >= ZOOM_STEPS.length) return;
    state.zoomStep = ZOOM_STEPS[next]!;
    if (state.zoomStep === 1) {
      state.panX = 0;
      state.panY = 0;
    }
    renderCircle(canvas);
    viewChangeCallback?.();
  }

  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!insidePorthole(e.offsetX, e.offsetY)) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  // ── Pinch zoom ──────────────────────────────────────────────────
  let pinchStartDist = 0;
  let pinchBaseZoom: 1 | 2 | 4 = 1;

  function touchDist(e: TouchEvent): number {
    const a = e.touches[0]!;
    const b = e.touches[1]!;
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  canvas.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        // Check midpoint of the two fingers is inside porthole.
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        const rect = canvas.getBoundingClientRect();
        const mx = (a.clientX + b.clientX) / 2 - rect.left;
        const my = (a.clientY + b.clientY) / 2 - rect.top;
        if (!insidePorthole(mx, my)) return;
        pinchStartDist = touchDist(e);
        pinchBaseZoom = state.zoomStep;
        e.preventDefault();
      }
    },
    { passive: false },
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2) {
        const dist = touchDist(e);
        const ratio = dist / pinchStartDist;
        let target: 1 | 2 | 4;
        if (ratio > 1.5) {
          target = Math.min(4, pinchBaseZoom * 2) as 1 | 2 | 4;
        } else if (ratio < 0.67) {
          target = Math.max(1, pinchBaseZoom / 2) as 1 | 2 | 4;
        } else {
          target = pinchBaseZoom;
        }
        if (target !== state.zoomStep) {
          state.zoomStep = target;
          if (state.zoomStep === 1) {
            state.panX = 0;
            state.panY = 0;
          }
          renderCircle(canvas);
          viewChangeCallback?.();
          // Reset pinch baseline so continued pinching can step again
          pinchStartDist = dist;
          pinchBaseZoom = target;
        }
        e.preventDefault();
      }
    },
    { passive: false },
  );
}
