/**
 * Geometric shadow projection with terrain awareness.
 *
 * For each building, projects each wall segment as a shadow quadrilateral
 * based on building height (adjusted for elevation difference from the pub)
 * and the sun's azimuth/altitude. Pure geometry — no raster.
 *
 * Terrain horizon occlusion: if the pub has a pre-computed horizon profile,
 * checks whether terrain blocks the sun at its current azimuth/altitude
 * before computing any shadows.
 */

import { M_PER_DEG_LAT, SHADOW_CAP_M } from "./config";
import { mPerDegLng, toRad } from "./geo";
import type { Building, Pub, ShadowPoly, SunPosition } from "./types";

/** Decode a base64 uint8 array. */
function decodeBase64(b64: string): Float32Array {
  const binary = atob(b64);
  const arr = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}

/** Decode a base64 terrain horizon profile into elevation angles (degrees). */
function decodeHorizon(b64: string): Float32Array {
  const raw = decodeBase64(b64);
  for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! * 0.1; // uint8 × 0.1°
  return raw;
}

/** Decode a base64 horizon distance profile into distances (metres). */
function decodeHorizonDist(b64: string): Float32Array {
  const raw = decodeBase64(b64);
  for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! * 12; // uint8 × 12m
  return raw;
}

/**
 * Check if terrain blocks the sun at the given azimuth/altitude.
 * Returns true if the sun is occluded.
 */
export function isTerrainOccluded(pub: Pub, sun: SunPosition): boolean {
  if (!pub.horizon) return false;
  const angles = decodeHorizon(pub.horizon);
  if (angles.length === 0) return false;

  const step = 360 / angles.length;
  const idx = (((sun.azimuth % 360) + 360) % 360) / step;
  const i0 = Math.floor(idx) % angles.length;
  const i1 = (i0 + 1) % angles.length;
  const frac = idx - Math.floor(idx);
  const a0 = angles[i0] ?? 0;
  const a1 = angles[i1] ?? 0;
  const horizonAngle = a0 * (1 - frac) + a1 * frac;
  return sun.altitude < horizonAngle;
}

/**
 * Compute terrain shadow edge distance from the pub in metres.
 *
 * Returns the distance from the pub to the terrain shadow edge,
 * measured in the direction away from the sun. Negative means
 * the pub is fully in terrain shadow. null means no terrain shadow.
 *
 * Uses the validated formula: edge = D × (1 - tan(θ) / tan(α))
 * where D = ridge distance, θ = horizon angle, α = sun altitude.
 *
 * Interpolates shadow edge position (not raw distances) between
 * adjacent azimuths for smoother results.
 */
export function terrainShadowEdge(pub: Pub, sun: SunPosition): number | null {
  if (!pub.horizon || !pub.horizon_dist) return null;

  const angles = decodeHorizon(pub.horizon);
  const dists = decodeHorizonDist(pub.horizon_dist);
  if (angles.length === 0 || dists.length === 0) return null;

  const step = 360 / angles.length;
  const sunAz = ((sun.azimuth % 360) + 360) % 360;
  const idx = sunAz / step;
  const i0 = Math.floor(idx) % angles.length;
  const i1 = (i0 + 1) % angles.length;
  const frac = idx - Math.floor(idx);

  const tanAlt = Math.tan(toRad(sun.altitude));
  if (tanAlt <= 0) return null;

  // Compute shadow edge from each adjacent azimuth independently,
  // then interpolate the edge positions (not the raw distances).
  const computeEdge = (angle: number, dist: number): number => {
    if (angle < 0.1 || dist < 1) return Infinity; // no terrain
    const tanTheta = Math.tan(toRad(angle));
    return dist * (1 - tanTheta / tanAlt);
  };

  const edge0 = computeEdge(angles[i0] ?? 0, dists[i0] ?? 0);
  const edge1 = computeEdge(angles[i1] ?? 0, dists[i1] ?? 0);

  // Lerp edge positions (handles Infinity correctly: if one side has
  // no terrain, the result smoothly transitions).
  if (!Number.isFinite(edge0) && !Number.isFinite(edge1)) return null;
  if (!Number.isFinite(edge0)) return edge1;
  if (!Number.isFinite(edge1)) return edge0;

  return edge0 * (1 - frac) + edge1 * frac;
}

/**
 * Compute shadow polygons cast by all given buildings at the sun position.
 *
 * Each building wall segment produces one shadow quadrilateral; the
 * projected roof footprint and the original footprint are also added so the
 * building's own area is darkened along with its cast shadow.
 *
 */
export function computeShadows(buildings: Building[], sun: SunPosition): ShadowPoly[] {
  if (sun.altitude <= 0 || buildings.length === 0) return [];

  const azRad = toRad(sun.azimuth);
  const tanAlt = Math.tan(toRad(sun.altitude));

  const midLat = buildings[0]?.coords[0]?.[0] ?? 52.6;
  const mPerDegLngLocal = mPerDegLng(midLat);

  const quads: ShadowPoly[] = [];

  for (const { coords, height } of buildings) {
    if (height <= 0 || coords.length < 3) continue;

    // Use the building's actual roof height. Elevation differences between
    // the building and pub are NOT added — shadows from uphill buildings
    // fall on the intervening slope, not on a flat plane at pub level.
    // Terrain occlusion from valley sides is handled by the terrain shadow
    // (horizon profile + ridge distance) instead.
    const effectiveHeight = height;

    const shadowLen = Math.min(effectiveHeight / tanAlt, SHADOW_CAP_M);
    const dlat = (-shadowLen * Math.cos(azRad)) / M_PER_DEG_LAT;
    const dlng = (-shadowLen * Math.sin(azRad)) / mPerDegLngLocal;

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      if (!a || !b) continue;
      quads.push([
        [a[0], a[1]],
        [b[0], b[1]],
        [b[0] + dlat, b[1] + dlng],
        [a[0] + dlat, a[1] + dlng],
      ]);
    }

    quads.push(coords.map(([y, x]) => [y + dlat, x + dlng]));
    quads.push([...coords]);
  }

  return quads;
}
