/**
 * Environment-agnostic building tile loader.
 *
 * Mirrors the runtime browser loader in src/buildings.ts but takes a
 * pluggable async fetcher function so the same code runs in:
 *
 *   - Cloudflare Pages Functions (fetcher uses env.ASSETS.fetch)
 *   - Node scripts (fetcher uses node:fs.readFile)
 *   - Anywhere else with an async tile-bytes source
 *
 * The bbox-filter and centroid-dedupe logic is identical to
 * scripts/lib/tiles_node.ts and src/buildings.ts — single source of truth
 * for what "buildings near a pub" means.
 */

import { decodeTile } from "../../src/buildings";
import { BUILDING_TILE_ZOOM, LOAD_RADIUS_M, M_PER_DEG_LAT } from "../../src/config";
import { lngLatToTileXY, mPerDegLng, polygonCentroid } from "../../src/geo";
import type { Building, Pub } from "../../src/types";

/**
 * Tile fetcher contract: take a `<x>-<y>` key, return the .pbf bytes as
 * an ArrayBuffer, or null if the tile is missing (404 / network error).
 */
export type TileFetcher = (key: string) => Promise<ArrayBuffer | null>;

/**
 * Load all buildings within the load radius of a pub via the supplied
 * fetcher. Bbox-filtered, centroid-deduped — same shape as the runtime
 * loader.
 */
export async function loadBuildingsForPubAsync(
  pub: Pub,
  fetcher: TileFetcher,
): Promise<Building[]> {
  const dlat = LOAD_RADIUS_M / M_PER_DEG_LAT;
  const dlng = LOAD_RADIUS_M / mPerDegLng(pub.lat);

  const [minTx, minTy] = lngLatToTileXY(pub.lng - dlng, pub.lat + dlat, BUILDING_TILE_ZOOM);
  const [maxTx, maxTy] = lngLatToTileXY(pub.lng + dlng, pub.lat - dlat, BUILDING_TILE_ZOOM);

  // Fetch each tile in parallel.
  const fetches: Promise<Building[]>[] = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const key = `${tx}-${ty}`;
      fetches.push(
        (async () => {
          const buf = await fetcher(key);
          if (!buf) return [];
          try {
            return decodeTile(buf, tx, ty, BUILDING_TILE_ZOOM);
          } catch {
            return [];
          }
        })(),
      );
    }
  }

  const results = await Promise.all(fetches);
  const all = results.flat();

  // Bbox filter + centroid dedupe (same as src/buildings.ts).
  const seen = new Set<string>();
  const south = pub.lat - dlat;
  const north = pub.lat + dlat;
  const west = pub.lng - dlng;
  const east = pub.lng + dlng;
  const out: Building[] = [];
  for (const b of all) {
    const c = polygonCentroid(b.coords);
    const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let inBbox = false;
    for (const [lat, lng] of b.coords) {
      if (lat >= south && lat <= north && lng >= west && lng <= east) {
        inBbox = true;
        break;
      }
    }
    if (inBbox) out.push(b);
  }
  return out;
}
