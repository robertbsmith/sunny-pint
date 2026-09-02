/**
 * Node-side tile loader.
 *
 * Mirrors the runtime browser loader in src/buildings.ts but reads the
 * PMTiles archive from disk. Used by the OG image renderer so it shares
 * one source of truth with the live app for what "buildings near a pub"
 * and "basemap near a pub" mean.
 */

import { openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PMTiles, type RangeResponse } from "pmtiles";
import { appendBasemapWithin, type Basemap, decodeBasemap, emptyBasemap } from "../../src/basemap";
import { decodeTile } from "../../src/buildings";
import { BUILDING_TILE_ZOOM, LOAD_RADIUS_M, M_PER_DEG_LAT } from "../../src/config";
import { lngLatToTileXY, mPerDegLng, polygonCentroid } from "../../src/geo";
import type { Building, Pub } from "../../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const PMTILES_PATH = join(ROOT, "public", "data", "buildings.pmtiles");

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

/** Raw tile bytes, cached per tile; null = tile absent from the archive. */
const rawCache = new Map<string, ArrayBuffer | null>();

async function loadRaw(tx: number, ty: number): Promise<ArrayBuffer | null> {
  const key = `${tx}-${ty}`;
  const cached = rawCache.get(key);
  if (cached !== undefined) return cached;
  if (!pmtiles) pmtiles = new PMTiles(new FileSource(PMTILES_PATH));
  let data: ArrayBuffer | null = null;
  try {
    const resp = await pmtiles.getZxy(BUILDING_TILE_ZOOM, tx, ty);
    data = resp?.data ?? null;
  } catch {
    data = null;
  }
  rawCache.set(key, data);
  return data;
}

interface LoadBox {
  south: number;
  north: number;
  west: number;
  east: number;
  tiles: [number, number][];
}

function loadBox(pub: Pub): LoadBox {
  const dlat = LOAD_RADIUS_M / M_PER_DEG_LAT;
  const dlng = LOAD_RADIUS_M / mPerDegLng(pub.lat);
  const [minTx, minTy] = lngLatToTileXY(pub.lng - dlng, pub.lat + dlat, BUILDING_TILE_ZOOM);
  const [maxTx, maxTy] = lngLatToTileXY(pub.lng + dlng, pub.lat - dlat, BUILDING_TILE_ZOOM);
  const tiles: [number, number][] = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) tiles.push([tx, ty]);
  }
  return {
    south: pub.lat - dlat,
    north: pub.lat + dlat,
    west: pub.lng - dlng,
    east: pub.lng + dlng,
    tiles,
  };
}

/**
 * Load + dedupe buildings within the load radius of a pub. Mirrors the
 * runtime loader logic in src/buildings.ts:loadBuildingsForPub.
 */
export async function loadBuildingsForPub(pub: Pub): Promise<Building[]> {
  const box = loadBox(pub);
  const all: Building[] = [];
  for (const [tx, ty] of box.tiles) {
    const data = await loadRaw(tx, ty);
    if (data) all.push(...decodeTile(data, tx, ty, BUILDING_TILE_ZOOM));
  }

  // Bbox filter + centroid dedupe.
  const seen = new Set<string>();
  const out: Building[] = [];
  for (const b of all) {
    const c = polygonCentroid(b.coords);
    const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let inBbox = false;
    for (const [lat, lng] of b.coords) {
      if (lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east) {
        inBbox = true;
        break;
      }
    }
    if (inBbox) out.push(b);
  }
  return out;
}

/** Load basemap features (roads, water, green space…) near a pub. */
export async function loadBasemapForPub(pub: Pub): Promise<Basemap> {
  const box = loadBox(pub);
  const out = emptyBasemap();
  for (const [tx, ty] of box.tiles) {
    const data = await loadRaw(tx, ty);
    if (!data) continue;
    appendBasemapWithin(out, decodeBasemap(data, tx, ty, BUILDING_TILE_ZOOM), [
      box.south,
      box.west,
      box.north,
      box.east,
    ]);
  }
  return out;
}
