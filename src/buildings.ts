/**
 * Building data loader.
 *
 * Loads buildings on demand from individual z14 vector tile files served as
 * static assets. Each pub's load radius (porthole + max shadow) spans at most
 * 4 tiles. Tiles are cached after first fetch.
 *
 * The closest building (by centroid distance) to the pub coordinate is
 * marked as the pub building so it can be highlighted distinctly.
 */

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { BUILDING_TILE_ZOOM, LOAD_RADIUS_M, M_PER_DEG_LAT } from "./config";
import { lngLatToTileXY, mPerDegLng, polygonCentroid } from "./geo";
import { state } from "./state";
import type { Building, Pub } from "./types";

const tileCache = new Map<string, Building[]>();

/** Decode a vector tile buffer into Building objects. */
function decodeTile(data: ArrayBuffer, tx: number, ty: number, tz: number): Building[] {
  const tile = new VectorTile(new Pbf(data));
  const layer = tile.layers.buildings;
  if (!layer) return [];

  const buildings: Building[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const geojson = feature.toGeoJSON(tx, ty, tz);
    const h = (feature.properties.h as number) || 8;
    const e = (feature.properties.e as number) || 0;

    const geomCoords =
      geojson.geometry.type === "Polygon"
        ? [geojson.geometry.coordinates]
        : geojson.geometry.type === "MultiPolygon"
          ? geojson.geometry.coordinates
          : [];

    for (const poly of geomCoords) {
      const ring = poly[0];
      if (!ring) continue;
      const coords: [number, number][] = ring.map((c) => [c[1], c[0]] as [number, number]);
      buildings.push({ coords, height: h, elev: e });
    }
  }
  return buildings;
}

/** Fetch a single tile, with caching. 404s are cached as empty. */
async function fetchTile(tx: number, ty: number): Promise<Building[]> {
  const key = `${tx}-${ty}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  try {
    const resp = await fetch(`/data/tiles/${key}.pbf`);
    if (!resp.ok) {
      tileCache.set(key, []);
      return [];
    }
    const data = await resp.arrayBuffer();
    const buildings = decodeTile(data, tx, ty, BUILDING_TILE_ZOOM);
    tileCache.set(key, buildings);
    return buildings;
  } catch {
    return [];
  }
}

/** Load all buildings near a pub from static tiles and update the app state. */
export async function loadBuildingsForPub(pub: Pub): Promise<void> {
  // Use OSM building centroid for matching if available (more accurate than
  // the OSM node geocode which can be slightly off the building footprint).
  const matchLat = pub.clat ?? pub.lat;
  const matchLng = pub.clng ?? pub.lng;

  const dlat = LOAD_RADIUS_M / M_PER_DEG_LAT;
  const dlng = LOAD_RADIUS_M / mPerDegLng(pub.lat);

  const [minTx, minTy] = lngLatToTileXY(pub.lng - dlng, pub.lat + dlat, BUILDING_TILE_ZOOM);
  const [maxTx, maxTy] = lngLatToTileXY(pub.lng + dlng, pub.lat - dlat, BUILDING_TILE_ZOOM);

  // Fetch all tiles in the bounding box (at most 4 tiles).
  const tilePromises: Promise<Building[]>[] = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      tilePromises.push(fetchTile(tx, ty));
    }
  }
  const tileResults = await Promise.all(tilePromises);
  const allBuildings = tileResults.flat();

  // Deduplicate (tippecanoe can clip features across tile boundaries) and
  // bbox-filter, while finding the closest centroid to the pub coordinate.
  const seen = new Set<string>();
  const nearby: Building[] = [];
  let nearestDist = Infinity;
  let pubIdx = -1;

  const south = pub.lat - dlat;
  const north = pub.lat + dlat;
  const west = pub.lng - dlng;
  const east = pub.lng + dlng;
  const cosLat = Math.cos((matchLat * Math.PI) / 180);

  for (const b of allBuildings) {
    const c = polygonCentroid(b.coords);
    // Dedupe by ~1m precision (5 decimal places).
    const dedupKey = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
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

    // Distance² in metres (anisotropic lat/lng correction).
    const dyM = (c[0] - matchLat) * M_PER_DEG_LAT;
    const dxM = (c[1] - matchLng) * M_PER_DEG_LAT * cosLat;
    const d = dyM * dyM + dxM * dxM;
    if (d < nearestDist) {
      nearestDist = d;
      pubIdx = idx;
    }
  }

  state.buildings = nearby;
  state.pubBuildingIndex = pubIdx;
}
