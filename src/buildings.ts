/**
 * Building data loader — static vector tiles edition.
 *
 * Loads buildings on demand from individual z14 .pbf tile files.
 * Each pub's 300m radius spans at most 4 z14 tiles.
 */

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { state } from "./state";
import type { Building, Pub } from "./types";

// Porthole radius (~74 m) + shadow cap (200 m).
const LOAD_RADIUS_M = 274;
const M_PER_DEG_LAT = 111320;

// Tile zoom level — must match generate_tiles.py TILE_ZOOM.
const TILE_ZOOM = 14;

// Cache fetched tiles by key.
const tileCache = new Map<string, Building[]>();

/** Convert lng/lat to a tile x,y at a given zoom. */
function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return [Math.min(x, n - 1), Math.min(y, n - 1)];
}

/** Decode a vector tile buffer into Building objects. */
function decodeTile(data: ArrayBuffer, tx: number, ty: number, tz: number): Building[] {
  const tile = new VectorTile(new Pbf(data));
  const layer = tile.layers["buildings"];
  if (!layer) return [];

  const buildings: Building[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const geojson = feature.toGeoJSON(tx, ty, tz);
    const h = (feature.properties["h"] as number) || 8;

    const geomCoords = geojson.geometry.type === "Polygon"
      ? [geojson.geometry.coordinates]
      : geojson.geometry.type === "MultiPolygon"
        ? geojson.geometry.coordinates
        : [];

    for (const poly of geomCoords) {
      const ring = poly[0];
      if (!ring) continue;
      const coords: [number, number][] = ring.map(
        (c) => [c[1], c[0]] as [number, number],
      );
      buildings.push({ coords, height: h });
    }
  }
  return buildings;
}

/** Fetch a single tile, with caching. */
async function fetchTile(tx: number, ty: number): Promise<Building[]> {
  const key = `${tx}-${ty}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  try {
    const resp = await fetch(`/data/tiles/${key}.pbf`);
    if (!resp.ok) {
      // 404 = no buildings in this tile, that's fine.
      tileCache.set(key, []);
      return [];
    }
    const data = await resp.arrayBuffer();
    const buildings = decodeTile(data, tx, ty, TILE_ZOOM);
    tileCache.set(key, buildings);
    return buildings;
  } catch {
    return [];
  }
}

/** Load buildings near a pub from static tiles and update state. */
export async function loadBuildingsForPub(pub: Pub): Promise<void> {
  // Use OSM polygon centroid for matching if available.
  let matchLat = pub.lat;
  let matchLng = pub.lng;
  if (pub.polygon && pub.polygon.length > 0) {
    const c = buildingCentroid(pub.polygon);
    matchLat = c[0];
    matchLng = c[1];
  }

  // Determine which z14 tiles cover the load radius.
  const dlat = LOAD_RADIUS_M / M_PER_DEG_LAT;
  const dlng = LOAD_RADIUS_M / (M_PER_DEG_LAT * Math.cos((pub.lat * Math.PI) / 180));

  const [minTx, minTy] = lngLatToTile(pub.lng - dlng, pub.lat + dlat, TILE_ZOOM);
  const [maxTx, maxTy] = lngLatToTile(pub.lng + dlng, pub.lat - dlat, TILE_ZOOM);

  // Fetch all z14 tiles in the bounding box (at most 4 tiles).
  const tilePromises: Promise<Building[]>[] = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      tilePromises.push(fetchTile(tx, ty));
    }
  }

  const tileResults = await Promise.all(tilePromises);
  const allBuildings = tileResults.flat();

  // Deduplicate and bbox filter.
  const seen = new Set<string>();
  const nearby: Building[] = [];
  let pubIdx = -1;
  let nearestDist = Infinity;
  let nearestIdx = -1;

  const south = pub.lat - dlat;
  const north = pub.lat + dlat;
  const west = pub.lng - dlng;
  const east = pub.lng + dlng;

  for (const b of allBuildings) {
    const c = buildingCentroid(b.coords);
    const dedupKey = `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    let inBbox = false;
    for (const [lat, lng] of b.coords) {
      if (lat >= south && lat <= north && lng >= west && lng <= east) {
        inBbox = true;
        break;
      }
    }
    if (!inBbox) continue;

    const idx = nearby.length;
    nearby.push(b);

    if (pointInPoly(matchLat, matchLng, b.coords)) {
      pubIdx = idx;
    }

    const d = (c[0] - matchLat) ** 2 + (c[1] - matchLng) ** 2;
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = idx;
    }
  }

  if (pubIdx === -1 && nearestIdx !== -1) {
    const distM = Math.sqrt(nearestDist) * M_PER_DEG_LAT;
    if (distM < 20) pubIdx = nearestIdx;
  }

  state.buildings = nearby;
  state.pubBuildingIndex = pubIdx;
  console.log(`Loaded ${nearby.length} buildings near ${pub.name}`);
}

function buildingCentroid(coords: [number, number][]): [number, number] {
  let latSum = 0;
  let lngSum = 0;
  const n = coords.length;
  for (const [lat, lng] of coords) {
    latSum += lat;
    lngSum += lng;
  }
  return [latSum / n, lngSum / n];
}

function pointInPoly(lat: number, lng: number, coords: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [yi, xi] = coords[i]!;
    const [yj, xj] = coords[j]!;
    if ((xi > lng) !== (xj > lng) && lat < ((yj - yi) * (lng - xi)) / (xj - xi) + yi) {
      inside = !inside;
    }
  }
  return inside;
}
