/**
 * Node-side building tile loader.
 *
 * Mirrors the runtime browser loader in src/buildings.ts but reads tiles
 * from disk via fs instead of fetch. Used by both scripts/precompute_sun.ts
 * and the OG image renderer so they share one source of truth for what
 * "buildings near a pub" means.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeTile } from "../../src/buildings";
import { BUILDING_TILE_ZOOM, LOAD_RADIUS_M, M_PER_DEG_LAT } from "../../src/config";
import { lngLatToTileXY, mPerDegLng, polygonCentroid } from "../../src/geo";
import type { Building, Pub } from "../../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const TILES_DIR = join(ROOT, "public", "data", "tiles");

const tileCache = new Map<string, Building[]>();

function loadTile(tx: number, ty: number): Building[] {
  const key = `${tx}-${ty}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  try {
    const buf = readFileSync(join(TILES_DIR, `${key}.pbf`));
    const buildings = decodeTile(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      tx,
      ty,
      BUILDING_TILE_ZOOM,
    );
    tileCache.set(key, buildings);
    return buildings;
  } catch {
    tileCache.set(key, []);
    return [];
  }
}

/**
 * Load + dedupe buildings within the load radius of a pub. Mirrors the
 * runtime loader logic in src/buildings.ts:loadBuildingsForPub but operates
 * on local files.
 */
export function loadBuildingsForPub(pub: Pub): Building[] {
  const dlat = LOAD_RADIUS_M / M_PER_DEG_LAT;
  const dlng = LOAD_RADIUS_M / mPerDegLng(pub.lat);

  const [minTx, minTy] = lngLatToTileXY(pub.lng - dlng, pub.lat + dlat, BUILDING_TILE_ZOOM);
  const [maxTx, maxTy] = lngLatToTileXY(pub.lng + dlng, pub.lat - dlat, BUILDING_TILE_ZOOM);

  const all: Building[] = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      all.push(...loadTile(tx, ty));
    }
  }

  // Bbox filter + centroid dedupe.
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
