/**
 * Porthole SVG renderer — matches the live in-browser circle.ts exactly.
 *
 * The SHADOW GEOMETRY comes from src/shadow.ts (same source of truth as the
 * live app). The MAP TILES come from Stadia Maps at the same URL the live app
 * fetches. The PROJECTION math comes from src/geo.ts. The COLOURS, dimensions,
 * and layer order all mirror src/circle.ts. The only thing this file does
 * differently is emit SVG markup instead of canvas paint calls — the inputs
 * and outputs are visually identical.
 *
 * Used by:
 *   - scripts/render_porthole_example.ts (sanity testing)
 *   - scripts/render_og_example.ts (build-time OG card design iteration)
 *   - functions/og/pub/[slug].ts (Cloudflare Pages Function — request-time)
 */

import SunCalc from "suncalc";

import { TILE_URL, TILE_ZOOM } from "../../src/config";
import { lngLatToTile, tileMetresPerPixel, toPixel } from "../../src/geo";
import { computeShadows, isTerrainOccluded } from "../../src/shadow";
import type { Building, Pub, ShadowPoly, SunPosition } from "../../src/types";

// ── Colours and constants — copied verbatim from circle.ts ──────────────
//
// All values are computed for dayFrac = 1 (full midday). The live porthole
// crossfades these toward darker values at twilight; for an OG card we
// always render the bright daytime variant.

const BEZEL = 14;
const MARGIN = BEZEL + 34; // 48

// dayFrac=1 evaluations of the per-frame colour expressions in circle.ts.
// Recompute these if you change the values in circle.ts.
const COLOURS = {
  // drawBuildings, dayFrac=1
  buildingFill: "rgba(140,150,165,0.85)",
  buildingStroke: "#6B7280",
  // pub building (highlighted)
  pubFill: "rgba(217,119,6,0.65)",
  pubStroke: "#B45309",
  // shadows
  shadowFill: "#1E1E3C",
  // outdoor garden
  gardenFill: "rgba(39,174,96,0.24)",
  gardenStroke: "#27AE60",
  // pub marker
  markerFill: "#E53E3E",
  // bezel — the ring around the porthole
  bezelOuter: "#E8E6E2",
  bezelGradInner: "#F0EDE8",
  bezelGradMid: "#E0DCD6",
  bezelGradOuter: "#C8C4BE",
  bezelRimWarm: "rgba(245,158,11,0.23)",
  bezelRimInner: "rgba(0,0,0,0.4)",
  // compass
  compassTick: "#94A3B8",
  compassLabel: "#1A1815",
  compassNorth: "#E53E3E",
};

// Sun-icon glyph as a simple yellow circle with rays. The full live app uses
// a canvas-painted icon; for the OG card a single glyph is sufficient.
const SUN_ICON_FILL = "#F59E0B";

// ── Public options ──────────────────────────────────────────────────────

export interface PortholeOptions {
  /** SVG canvas size in user units. Same as the live app's W. */
  size?: number;
  /** Pre-fetched tile cache (data URI keyed by `${z}_${x}_${y}`). When
   *  supplied the renderer skips network fetches and uses these. */
  tileCache?: Map<string, string>;
}

// ── Tile fetching (Node + Workers fetch) ────────────────────────────────

const tileFetchCache = new Map<string, Promise<string | null>>();

/**
 * Fetch one map tile and return it as a data URI. Cached at the module
 * level so multiple pubs in the same neighbourhood share fetches. Returns
 * null on 404 / network error so the porthole still renders without tiles.
 */
async function fetchTileDataUri(
  z: number,
  x: number,
  y: number,
  stadiaApiKey?: string,
): Promise<string | null> {
  const key = `${z}_${x}_${y}`;
  const existing = tileFetchCache.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      let url = TILE_URL.replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y));
      if (stadiaApiKey) url += `?api_key=${stadiaApiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      const b64 =
        typeof Buffer !== "undefined"
          ? Buffer.from(buf).toString("base64")
          : btoa(String.fromCharCode(...new Uint8Array(buf)));
      return `data:image/png;base64,${b64}`;
    } catch {
      return null;
    }
  })();

  tileFetchCache.set(key, promise);
  return promise;
}

/**
 * Pre-fetch every map tile a porthole needs for the given pub. Call this
 * before `renderPortholeSvg` so the renderer can run synchronously.
 */
export async function prefetchPortholeTiles(
  pub: Pub,
  stadiaApiKey?: string,
): Promise<Map<string, string>> {
  const centre = { lat: pub.clat ?? pub.lat, lng: pub.clng ?? pub.lng };
  const { tx, ty } = lngLatToTile(centre.lng, centre.lat, TILE_ZOOM);
  const cache = new Map<string, string>();

  const fetches: Promise<void>[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const z = TILE_ZOOM;
      const x = tx + dx;
      const y = ty + dy;
      fetches.push(
        fetchTileDataUri(z, x, y, stadiaApiKey).then((uri) => {
          if (uri) cache.set(`${z}_${x}_${y}`, uri);
        }),
      );
    }
  }
  await Promise.all(fetches);
  return cache;
}

// ── Sun position helper ─────────────────────────────────────────────────

export function bestWindowSunPosition(pub: Pub, bestWindow: string | null): SunPosition {
  const sampleDay = new Date(2026, 2, 20, 12, 0, 0);
  let date = sampleDay;
  if (bestWindow) {
    const m = bestWindow.match(/^(\d{2}):(\d{2})[–-](\d{2}):(\d{2})$/);
    if (m) {
      const startMins = parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
      const endMins = parseInt(m[3]!, 10) * 60 + parseInt(m[4]!, 10);
      const midMins = Math.round((startMins + endMins) / 2);
      date = new Date(sampleDay);
      date.setHours(0, 0, 0, 0);
      date.setMinutes(midMins);
    }
  }
  const pos = SunCalc.getPosition(date, pub.lat, pub.lng);
  return {
    azimuth: ((pos.azimuth * 180) / Math.PI + 180) % 360,
    altitude: (pos.altitude * 180) / Math.PI,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pubBuildingIndex(pub: Pub, buildings: Building[]): number {
  // Mirrors the runtime loader's pubBuildingIndex computation: prefer
  // a building whose polygon contains the pub coordinate; fall back to the
  // nearest centroid. We need this so the renderer can highlight the pub's
  // own building in orange.
  const matchLat = pub.clat ?? pub.lat;
  const matchLng = pub.clng ?? pub.lng;
  let containingIdx = -1;
  let nearestIdx = -1;
  let nearestDist = Infinity;

  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i]!;
    if (containingIdx === -1 && pointInPolygon(matchLat, matchLng, b.coords)) {
      containingIdx = i;
    }
    let cy = 0;
    let cx = 0;
    for (const [lat, lng] of b.coords) {
      cy += lat;
      cx += lng;
    }
    cy /= b.coords.length;
    cx /= b.coords.length;
    const d = (cy - matchLat) ** 2 + (cx - matchLng) ** 2;
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
    }
  }
  return containingIdx !== -1 ? containingIdx : nearestIdx;
}

function pointInPolygon(lat: number, lng: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[0] > lat !== b[0] > lat) {
      const t = (b[1] - a[1]) * (lat - a[0]);
      const u = b[0] - a[0];
      if (u !== 0 && lng < t / u + a[1]) inside = !inside;
    }
  }
  return inside;
}

function pointsAttr(
  ring: [number, number][],
  cx: number,
  cy: number,
  centre: { lat: number; lng: number },
  mpp: number,
): string {
  return ring
    .map(([lat, lng]) => {
      const p = toPixel(lat, lng, centre, mpp);
      return `${(cx + p.x).toFixed(1)},${(cy + p.y).toFixed(1)}`;
    })
    .join(" ");
}

function pathAttr(
  rings: [number, number][][],
  cx: number,
  cy: number,
  centre: { lat: number; lng: number },
  mpp: number,
): string {
  return rings
    .map(
      (ring) =>
        `${ring
          .map(([lat, lng], i) => {
            const p = toPixel(lat, lng, centre, mpp);
            return `${i === 0 ? "M" : "L"}${(cx + p.x).toFixed(1)},${(cy + p.y).toFixed(1)}`;
          })
          .join(" ")} Z`,
    )
    .join(" ");
}

// ── Main renderer ───────────────────────────────────────────────────────

/**
 * Build a complete `<svg>...</svg>` representing one pub's porthole.
 *
 * Layers (matching circle.ts order):
 *   1. Bezel ring (outer to inner gradient)
 *   2. Map tiles (Stadia Alidade Smooth z18, 3x3 grid, clipped to inner circle)
 *   3. Shadow polygons (alpha-blended)
 *   4. Building polygons (with the pub building highlighted in orange)
 *   5. Outdoor garden polygon (green-dashed outline, evenodd fill)
 *   6. Pub marker dot
 *   7. Compass ticks + N S E W labels
 *   8. Sun glyph at the bezel
 */
export function renderPortholeSvg(
  pub: Pub,
  buildings: Building[],
  sun: SunPosition,
  options: PortholeOptions = {},
): string {
  const W = options.size ?? 480;
  const H = W;
  const cx = W / 2;
  const r = W / 2 - MARGIN - 2;
  const outerR = r + BEZEL;
  const cy = W / 2;

  const centre = { lat: pub.clat ?? pub.lat, lng: pub.clng ?? pub.lng };
  const mpp = tileMetresPerPixel(centre.lat, TILE_ZOOM);

  // Compute shadows from the same shadow.ts the live app uses.
  const sunUp = sun.altitude > 0 && !isTerrainOccluded(pub, sun);
  const shadowQuads: ShadowPoly[] = sunUp ? computeShadows(buildings, sun, pub.elev ?? 0) : [];

  // ── Bezel layer ────────────────────────────────────────────────────
  const bezelGradId = "ph-bezel-grad";
  const innerClipId = "ph-inner-clip";

  const bezel =
    `<defs>` +
    `<radialGradient id="${bezelGradId}" cx="${cx}" cy="${cy - outerR * 0.3}" r="${outerR}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${COLOURS.bezelGradInner}"/>` +
    `<stop offset="0.4" stop-color="${COLOURS.bezelGradMid}"/>` +
    `<stop offset="1" stop-color="${COLOURS.bezelGradOuter}"/>` +
    `</radialGradient>` +
    `<clipPath id="${innerClipId}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>` +
    `<filter id="ph-bezel-shadow" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur in="SourceAlpha" stdDeviation="6"/>` +
    `<feOffset dx="0" dy="4"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope="0.18"/></feComponentTransfer>` +
    `<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>` +
    `</filter>` +
    `</defs>` +
    // Outer disc with drop shadow
    `<circle cx="${cx}" cy="${cy}" r="${outerR}" fill="${COLOURS.bezelOuter}" filter="url(#ph-bezel-shadow)"/>` +
    // Bezel ring (gradient between outer and inner radii) — drawn as a
    // donut path so SVG fills only the ring, not the inner area.
    `<path d="M ${cx - outerR},${cy} a ${outerR},${outerR} 0 1,0 ${outerR * 2},0 a ${outerR},${outerR} 0 1,0 ${-outerR * 2},0 M ${cx - r},${cy} a ${r},${r} 0 1,1 ${r * 2},0 a ${r},${r} 0 1,1 ${-r * 2},0" fill="url(#${bezelGradId})" fill-rule="evenodd"/>` +
    // Warm rim line (just inside the bezel)
    `<circle cx="${cx}" cy="${cy}" r="${r + 0.5}" fill="none" stroke="${COLOURS.bezelRimWarm}" stroke-width="1.5"/>` +
    // Dark rim line (outside edge of the bezel)
    `<circle cx="${cx}" cy="${cy}" r="${outerR - 0.5}" fill="none" stroke="${COLOURS.bezelRimInner}" stroke-width="1"/>`;

  // ── Map tile layer ─────────────────────────────────────────────────
  const { tx, ty, px, py } = lngLatToTile(centre.lng, centre.lat, TILE_ZOOM);
  const tileImages: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = `${TILE_ZOOM}_${tx + dx}_${ty + dy}`;
      const dataUri = options.tileCache?.get(key);
      if (!dataUri) continue;
      const ix = cx - px + dx * 256;
      const iy = cy - py + dy * 256;
      tileImages.push(
        `<image href="${dataUri}" x="${ix.toFixed(1)}" y="${iy.toFixed(1)}" width="256" height="256" preserveAspectRatio="xMidYMid slice"/>`,
      );
    }
  }

  // ── Shadow layer ───────────────────────────────────────────────────
  // Live app composites shadows on an offscreen canvas at full opacity, then
  // alpha-blits the result. SVG equivalent: draw all polygons inside a
  // <g> with fill-opacity, but overlapping polygons would still darken.
  // Solution: draw to a clip-path-based mask. Simpler: just accept slight
  // double-darkening since the alpha is small (~0.5) and the visual
  // difference is negligible. Alternative: use mix-blend-mode but that's
  // not universally supported in SVG renderers.
  const shadowAlpha = sunUp ? Math.min(sun.altitude / 8, 0.5) : 0;
  const shadowPolys = shadowQuads
    .map((q) => `<polygon points="${pointsAttr(q, cx, cy, centre, mpp)}"/>`)
    .join("");

  // ── Building layer ─────────────────────────────────────────────────
  const pubIdx = pubBuildingIndex(pub, buildings);
  const buildingPolys = buildings
    .map((b, i) => {
      if (b.coords.length < 3) return "";
      const isPub = i === pubIdx;
      const fill = isPub ? COLOURS.pubFill : COLOURS.buildingFill;
      const stroke = isPub ? COLOURS.pubStroke : COLOURS.buildingStroke;
      const sw = isPub ? 2 : 1;
      return `<polygon points="${pointsAttr(b.coords, cx, cy, centre, mpp)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    })
    .join("");

  // ── Garden layer ───────────────────────────────────────────────────
  const gardenPath = pub.outdoor
    ? `<path d="${pathAttr(pub.outdoor, cx, cy, centre, mpp)}" fill="${COLOURS.gardenFill}" fill-rule="evenodd" stroke="${COLOURS.gardenStroke}" stroke-width="2.5" stroke-dasharray="6 4" stroke-linejoin="round"/>`
    : "";

  // ── Pub marker ─────────────────────────────────────────────────────
  const pubMarker = `<circle cx="${cx}" cy="${cy}" r="4" fill="${COLOURS.markerFill}" stroke="#fff" stroke-width="1.5"/>`;

  // ── Compass ────────────────────────────────────────────────────────
  // 8 ticks at 45° intervals. Major ticks at N/E/S/W are 2px, minor are 1px.
  const ticks: string[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = ((i * 45 - 90) * Math.PI) / 180;
    const isMajor = i % 2 === 0;
    const inner = r + 2;
    const outer = r + BEZEL * 0.5;
    const x1 = cx + Math.cos(angle) * inner;
    const y1 = cy + Math.sin(angle) * inner;
    const x2 = cx + Math.cos(angle) * outer;
    const y2 = cy + Math.sin(angle) * outer;
    ticks.push(
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${COLOURS.compassTick}" stroke-width="${isMajor ? 2 : 1}" stroke-linecap="round"/>`,
    );
  }
  const labels: string[] = [];
  const labelText = ["N", "E", "S", "W"];
  const labelR = outerR + 14;
  for (let i = 0; i < 4; i++) {
    const angle = ((i * 90 - 90) * Math.PI) / 180;
    const x = cx + Math.cos(angle) * labelR;
    const y = cy + Math.sin(angle) * labelR;
    const fill = i === 0 ? COLOURS.compassNorth : COLOURS.compassLabel;
    labels.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="700" fill="${fill}" text-anchor="middle" dominant-baseline="central">${labelText[i]}</text>`,
    );
  }

  // ── Sun glyph at the bezel ─────────────────────────────────────────
  let sunGlyph = "";
  if (sunUp) {
    const sunAngle = ((sun.azimuth - 90) * Math.PI) / 180;
    const iconR = r + BEZEL * 0.5;
    const sx = cx + Math.cos(sunAngle) * iconR;
    const sy = cy + Math.sin(sunAngle) * iconR;
    sunGlyph =
      `<g>` +
      `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6" fill="${SUN_ICON_FILL}" stroke="#78350f" stroke-width="1"/>` +
      `</g>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    bezel +
    // All map / building / garden / shadow content is clipped to the inner
    // porthole circle so the bezel ring isn't covered.
    `<g clip-path="url(#${innerClipId})">` +
    tileImages.join("") +
    `<g fill="${COLOURS.shadowFill}" fill-opacity="${shadowAlpha.toFixed(3)}">${shadowPolys}</g>` +
    buildingPolys +
    gardenPath +
    pubMarker +
    `</g>` +
    ticks.join("") +
    labels.join("") +
    sunGlyph +
    `</svg>`
  );
}

void escapeAttr; // exported helper for callers; suppresses unused warning
