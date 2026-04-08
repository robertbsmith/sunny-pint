/**
 * Building data loader.
 *
 * Loads all buildings once, then filters by proximity to the selected pub.
 * TODO: Replace with PMTiles spatial queries for UK-wide scale.
 */

import { state } from "./state";
import type { Building, Pub } from "./types";

const LOAD_RADIUS_M = 200; // metres around pub to load buildings
const M_PER_DEG_LAT = 111320;

let allBuildings: Building[] | null = null;
let loading = false;

/** Load buildings JSON (once). */
async function ensureLoaded(): Promise<void> {
  if (allBuildings !== null || loading) return;
  loading = true;
  try {
    const resp = await fetch("/data/buildings.json");
    allBuildings = await resp.json();
    console.log(`Loaded ${allBuildings!.length} buildings`);
  } catch (err) {
    console.error("Failed to load buildings:", err);
    allBuildings = [];
  }
  loading = false;
}

/** Filter buildings near a pub and update state. */
export async function loadBuildingsForPub(pub: Pub): Promise<void> {
  await ensureLoaded();
  if (!allBuildings) return;

  // Use OSM polygon centroid for matching if available (more accurate than FSA geocode).
  let matchLat = pub.lat;
  let matchLng = pub.lng;
  if (pub.polygon && pub.polygon.length > 0) {
    const c = buildingCentroid(pub.polygon);
    matchLat = c[0];
    matchLng = c[1];
  }

  const dlat = LOAD_RADIUS_M / M_PER_DEG_LAT;
  const dlng = LOAD_RADIUS_M / (M_PER_DEG_LAT * Math.cos((pub.lat * Math.PI) / 180));
  const south = pub.lat - dlat;
  const north = pub.lat + dlat;
  const west = pub.lng - dlng;
  const east = pub.lng + dlng;

  // Fast bbox filter.
  const nearby: Building[] = [];
  let pubIdx = -1;
  let nearestDist = Infinity;
  let nearestIdx = -1;

  for (const b of allBuildings) {
    // Check if any vertex is in bbox.
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

    // Check if pub is inside this building polygon.
    if (pointInPoly(matchLat, matchLng, b.coords)) {
      pubIdx = idx;
    }

    // Also track nearest building centroid as fallback.
    const centroid = buildingCentroid(b.coords);
    const d = (centroid[0] - matchLat) ** 2 + (centroid[1] - matchLng) ** 2;
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = idx;
    }
  }

  // If point-in-poly didn't find the pub's building, use nearest.
  if (pubIdx === -1 && nearestIdx !== -1) {
    // Only use nearest if it's within ~20m.
    const distM = Math.sqrt(nearestDist) * M_PER_DEG_LAT;
    if (distM < 20) pubIdx = nearestIdx;
  }

  state.buildings = nearby;
  state.pubBuildingIndex = pubIdx;
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
    const [yi, xi] = coords[i];
    const [yj, xj] = coords[j];
    if ((xi > lng) !== (xj > lng) && lat < ((yj - yi) * (lng - xi)) / (xj - xi) + yi) {
      inside = !inside;
    }
  }
  return inside;
}
