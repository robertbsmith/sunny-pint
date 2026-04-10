/**
 * Map tile loader for the porthole basemap.
 *
 * Fetches and caches Stadia Maps raster tiles for use as a Canvas 2D
 * background. Supports both normal and satellite tile sets with separate
 * caches. Tile loads schedule a single deferred re-render via
 * requestAnimationFrame to avoid render storms when many tiles arrive.
 */

import { SATELLITE_TILE_URL, TILE_CACHE_MAX, TILE_URL } from "./config";

const normalCache = new Map<string, HTMLImageElement>();
const satelliteCache = new Map<string, HTMLImageElement>();

let pendingRedraw: number | null = null;
let suppressRedraw = false;
let redrawCallback: (() => void) | null = null;

/** Set the function to call when a tile finishes loading and a redraw is needed. */
export function setTileRedrawCallback(callback: () => void): void {
  redrawCallback = callback;
}

/** Suspend deferred redraws (used while inside a render to prevent loops). */
export function setSuppressTileRedraw(suppress: boolean): void {
  suppressRedraw = suppress;
}

function scheduleRedraw(): void {
  if (suppressRedraw) return;
  if (pendingRedraw != null) cancelAnimationFrame(pendingRedraw);
  pendingRedraw = requestAnimationFrame(() => {
    pendingRedraw = null;
    redrawCallback?.();
  });
}

function fetchTile(
  cache: Map<string, HTMLImageElement>,
  urlTemplate: string,
  z: number,
  x: number,
  y: number,
): HTMLImageElement | null {
  const key = `${z}_${x}_${y}`;
  const cached = cache.get(key);
  if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = scheduleRedraw;
  img.onerror = () => cache.delete(key);
  img.src = urlTemplate
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));

  if (cache.size >= TILE_CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, img);
  return null;
}

/**
 * Get a map tile image, kicking off a fetch if not cached.
 *
 * @returns The image element if it's loaded and ready to draw, or `null` if
 *          still loading. The caller should retry on next render.
 */
export function loadTile(
  z: number,
  x: number,
  y: number,
  satellite = false,
): HTMLImageElement | null {
  return satellite
    ? fetchTile(satelliteCache, SATELLITE_TILE_URL, z, x, y)
    : fetchTile(normalCache, TILE_URL, z, x, y);
}
