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

/** Decode a base64 terrain horizon profile into elevation angles (degrees). */
function decodeHorizon(b64: string): Float32Array {
  const binary = atob(b64);
  const angles = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    angles[i] = binary.charCodeAt(i) * 0.1; // uint8 × 0.1°
  }
  return angles;
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
 * Compute shadow polygons cast by all given buildings at the sun position.
 *
 * Each building wall segment produces one shadow quadrilateral; the
 * projected roof footprint and the original footprint are also added so the
 * building's own area is darkened along with its cast shadow.
 *
 * @param pubElev Ground elevation of the pub in metres above sea level. Used
 *                to adjust each building's effective height by the elevation
 *                difference (uphill buildings cast longer shadows).
 */
export function computeShadows(buildings: Building[], sun: SunPosition, pubElev = 0): ShadowPoly[] {
  if (sun.altitude <= 0 || buildings.length === 0) return [];

  const azRad = toRad(sun.azimuth);
  const tanAlt = Math.tan(toRad(sun.altitude));

  const midLat = buildings[0]?.coords[0]?.[0] ?? 52.6;
  const mPerDegLngLocal = mPerDegLng(midLat);

  const quads: ShadowPoly[] = [];

  for (const { coords, height, elev } of buildings) {
    if (height <= 0 || coords.length < 3) continue;

    const effectiveHeight = height + (elev - pubElev);
    if (effectiveHeight <= 0) continue;

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
