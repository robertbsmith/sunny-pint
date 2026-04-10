/**
 * Map tile loader for the porthole basemap.
 *
 * Fetches and caches Stadia Maps raster tiles for use as a Canvas 2D
 * background. Tile loads schedule a single deferred re-render via
 * requestAnimationFrame to avoid render storms when many tiles arrive.
 */

import { TILE_CACHE_MAX, TILE_URL } from "./config";

const tileCache = new Map<string, HTMLImageElement>();

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

/**
 * Get a map tile image, kicking off a fetch if not cached.
 *
 * @returns The image element if it's loaded and ready to draw, or `null` if
 *          still loading. The caller should retry on next render.
 */
export function loadTile(z: number, x: number, y: number): HTMLImageElement | null {
  const key = `${z}_${x}_${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (suppressRedraw) return;
    if (pendingRedraw != null) cancelAnimationFrame(pendingRedraw);
    pendingRedraw = requestAnimationFrame(() => {
      pendingRedraw = null;
      redrawCallback?.();
    });
  };
  img.onerror = () => {
    tileCache.delete(key);
  };
  img.src = TILE_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

  // Bound the cache to prevent memory leaks during long sessions.
  if (tileCache.size >= TILE_CACHE_MAX) {
    const firstKey = tileCache.keys().next().value;
    if (firstKey) tileCache.delete(firstKey);
  }
  tileCache.set(key, img);
  return null;
}
