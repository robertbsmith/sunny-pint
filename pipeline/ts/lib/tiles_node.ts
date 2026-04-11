/**
 * Node-side building tile loader.
 *
 * Mirrors the runtime browser loader in src/buildings.ts but reads tiles
 * from disk via fs instead of fetch. Used by both scripts/precompute_sun.ts
 * and the OG image renderer so they share one source of truth for what
 * "buildings near a pub" means.
 */

import { existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PMTiles, type RangeResponse } from "pmtiles";
import { decodeTile } from "../../../src/buildings";
import { BUILDING_TILE_ZOOM, LOAD_RADIUS_M, M_PER_DEG_LAT } from "../../../src/config";
import { lngLatToTileXY, mPerDegLng, polygonCentroid } from "../../../src/geo";
import type { Building, Pub } from "../../../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const TILES_DIR = join(ROOT, "public", "data", "tiles");
const PMTILES_PATH = join(ROOT, "public", "data", "buildings.pmtiles");

const tileCache = new Map<string, Building[]>();

/** File-based PMTiles source for Node.js (synchronous reads). */
class FileSource {
  private fd: number;

  constructor(path: string) {
    this.fd = openSync(path, "r");
  }

  getKey(): string {
    return PMTILES_PATH;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buf = Buffer.alloc(length);
    readSync(this.fd, buf, 0, length, offset);
    return {
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    };
  }
}

let pmtiles: PMTiles | null = null;
const usePMTiles = existsSync(PMTILES_PATH);

function loadTile(tx: number, ty: number): Building[] {
  const key = `${tx}-${ty}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  if (usePMTiles) {
    // PMTiles path — getZxy is async but we call loadBuildingsForPub
    // synchronously. Cache miss returns empty; the caller should use
    // the async loadBuildingsForPubAsync if available. For the sync
    // precompute_sun pipeline, we pre-warm the cache via warmTile().
    tileCache.set(key, []);
    return [];
  }

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

/** Async tile load from PMTiles — use before calling loadBuildingsForPub. */
async function warmTile(tx: number, ty: number): Promise<void> {
  const key = `${tx}-${ty}`;
  if (tileCache.has(key)) return;
  if (!usePMTiles) {
    loadTile(tx, ty);
    return;
  }
  if (!pmtiles) {
    pmtiles = new PMTiles(new FileSource(PMTILES_PATH));
  }
  try {
    const resp = await pmtiles.getZxy(BUILDING_TILE_ZOOM, tx, ty);
    if (resp?.data) {
      const buildings = decodeTile(resp.data, tx, ty, BUILDING_TILE_ZOOM);
      tileCache.set(key, buildings);
    } else {
      tileCache.set(key, []);
    }
  } catch {
    tileCache.set(key, []);
  }
}

/**
 * Load + dedupe buildings within the load radius of a pub. Mirrors the
 * runtime loader logic in src/buildings.ts:loadBuildingsForPub but operates
 * on local files (individual .pbf) or a local PMTiles archive.
 *
 * When using PMTiles, tiles are loaded asynchronously on first access via
 * warmTile(). Call this function normally — it will work on cached tiles.
 */
export async function loadBuildingsForPub(pub: Pub): Promise<Building[]> {
  const dlat = LOAD_RADIUS_M / M_PER_DEG_LAT;
  const dlng = LOAD_RADIUS_M / mPerDegLng(pub.lat);

  const [minTx, minTy] = lngLatToTileXY(pub.lng - dlng, pub.lat + dlat, BUILDING_TILE_ZOOM);
  const [maxTx, maxTy] = lngLatToTileXY(pub.lng + dlng, pub.lat - dlat, BUILDING_TILE_ZOOM);

  // Warm tiles from PMTiles if needed.
  if (usePMTiles) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      for (let ty = minTy; ty <= maxTy; ty++) {
        await warmTile(tx, ty);
      }
    }
  }

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
