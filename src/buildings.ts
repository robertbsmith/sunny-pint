/**
 * Building data loader — PMTiles edition.
 *
 * Loads buildings on demand from z8-grid PMTiles files via HTTP range requests.
 * Only fetches tiles covering the area around the selected pub.
 */

import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { state } from "./state";
import type { Building, Pub } from "./types";

// Porthole radius (~74 m) + shadow cap (200 m) + margin.
const LOAD_RADIUS_M = 300;
const M_PER_DEG_LAT = 111320;

// Z8 tile grid — must match generate_pmtiles.py SPLIT_ZOOM.
const SPLIT_ZOOM = 8;

// Cache open PMTiles instances by z8 key.
const archiveCache = new Map<string, PMTiles>();

// Tile zoom level to request from the PMTiles archive.
// z16 gives ~2.4 m/px tiles — good detail for building outlines.
const QUERY_ZOOM = 16;

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

/** Get or create a PMTiles instance for a z8 grid cell. */
function getArchive(z8x: number, z8y: number): PMTiles {
  const key = `${z8x}-${z8y}`;
  let archive = archiveCache.get(key);
  if (!archive) {
    archive = new PMTiles(`/data/buildings-${key}.pmtiles`);
    archiveCache.set(key, archive);
  }
  return archive;
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

    // toGeoJSON(0,0,0) gives [lng,lat] in degrees. Convert to [lat,lng] for our Building type.
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

/** Load buildings near a pub from PMTiles and update state. */
export async function loadBuildingsForPub(pub: Pub): Promise<void> {
  // Use OSM polygon centroid for matching if available.
  let matchLat = pub.lat;
  let matchLng = pub.lng;
  if (pub.polygon && pub.polygon.length > 0) {
    const c = buildingCentroid(pub.polygon);
    matchLat = c[0];
    matchLng = c[1];
  }

  // Determine which z8 archive this pub falls in.
  const [z8x, z8y] = lngLatToTile(pub.lng, pub.lat, SPLIT_ZOOM);

  // Determine which z16 tiles cover the load radius.
  const dlat = LOAD_RADIUS_M / M_PER_DEG_LAT;
  const dlng = LOAD_RADIUS_M / (M_PER_DEG_LAT * Math.cos((pub.lat * Math.PI) / 180));

  const [minTx, minTy] = lngLatToTile(pub.lng - dlng, pub.lat + dlat, QUERY_ZOOM);
  const [maxTx, maxTy] = lngLatToTile(pub.lng + dlng, pub.lat - dlat, QUERY_ZOOM);

  // Fetch all z16 tiles in the bounding box.
  const archive = getArchive(z8x, z8y);
  try {
    const header = await archive.getHeader();
    console.log(`PMTiles header: z${header.minZoom}-${header.maxZoom}, ${header.numAddressedTiles} tiles`);
  } catch (err) {
    console.error("PMTiles header fetch failed:", err);
  }
  console.log(`Fetching tiles z${QUERY_ZOOM} x:${minTx}-${maxTx} y:${minTy}-${maxTy}`);
  const tilePromises: Promise<Building[]>[] = [];

  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const tileX = tx, tileY = ty;
      tilePromises.push(
        archive.getZxy(QUERY_ZOOM, tileX, tileY).then((resp) => {
          if (!resp?.data) return [];
          return decodeTile(resp.data, tileX, tileY, QUERY_ZOOM);
        }).catch((err) => {
          console.error(`PMTiles tile fetch failed (z${QUERY_ZOOM}/${tileX}/${tileY}):`, err);
          return [];
        }),
      );
    }
  }

  const tileResults = await Promise.all(tilePromises);
  const allBuildings = tileResults.flat();

  // Deduplicate buildings that appear in multiple tiles (tippecanoe can clip
  // features across tile boundaries). Use centroid as a rough dedup key.
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
    // Dedup by rounded centroid.
    const c = buildingCentroid(b.coords);
    const dedupKey = `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Bbox filter (tiles may extend beyond our radius).
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
  console.log(`Loaded ${nearby.length} buildings near ${pub.name} (z8: ${z8x}-${z8y})`);
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
