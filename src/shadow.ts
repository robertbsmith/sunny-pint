/**
 * Geometric shadow projection with terrain awareness.
 *
 * For each building, projects each wall segment as a shadow quadrilateral
 * based on building height (adjusted for elevation difference from pub)
 * and sun position. Pure geometry — no raster.
 *
 * Terrain horizon occlusion: if the pub has a pre-computed horizon profile,
 * checks whether terrain blocks the sun at its current azimuth/altitude.
 */

import type { Building, Pub, ShadowPoly, SunPosition } from "./types";

const M_PER_DEG_LAT = 111_320;

/** Decode a base64 terrain horizon profile into elevation angles (degrees). */
function decodeHorizon(b64: string): Float32Array {
  const binary = atob(b64);
  const angles = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    angles[i] = binary.charCodeAt(i) * 0.1; // uint8 × 0.1° resolution
  }
  return angles;
}

/** Check if terrain blocks the sun at the given azimuth/altitude.
 *  Returns true if the sun is occluded by terrain. */
export function isTerrainOccluded(pub: Pub, sun: SunPosition): boolean {
  if (!pub.horizon) return false;
  const angles = decodeHorizon(pub.horizon);
  const step = 360 / angles.length;
  // Interpolate between two nearest azimuth samples.
  const idx = ((sun.azimuth % 360) + 360) % 360 / step;
  const i0 = Math.floor(idx) % angles.length;
  const i1 = (i0 + 1) % angles.length;
  const frac = idx - Math.floor(idx);
  const horizonAngle = angles[i0]! * (1 - frac) + angles[i1]! * frac;
  return sun.altitude < horizonAngle;
}

export function computeShadows(
  buildings: Building[],
  sun: SunPosition,
  pubElev = 0,
  maxShadowLen = 200,
): ShadowPoly[] {
  if (sun.altitude <= 0 || buildings.length === 0) return [];

  const azRad = (sun.azimuth * Math.PI) / 180;
  const tanAlt = Math.tan((sun.altitude * Math.PI) / 180);

  // Approximate metres-per-degree-longitude at this latitude.
  const midLat = buildings[0]?.coords[0]?.[0] ?? 52.6;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);

  const quads: ShadowPoly[] = [];

  for (const { coords, height, elev } of buildings) {
    if (height <= 0 || coords.length < 3) continue;

    // Adjust height for elevation difference: uphill building is effectively taller.
    const effectiveHeight = height + (elev - pubElev);
    if (effectiveHeight <= 0) continue;

    const shadowLen = Math.min(effectiveHeight / tanAlt, maxShadowLen);
    const dlat = (-shadowLen * Math.cos(azRad)) / M_PER_DEG_LAT;
    const dlng = (-shadowLen * Math.sin(azRad)) / mPerDegLng;

    // Each wall segment → shadow quad.
    for (let i = 0; i < coords.length - 1; i++) {
      const [y1, x1] = coords[i]!;
      const [y2, x2] = coords[i + 1]!;
      quads.push([
        [y1, x1],
        [y2, x2],
        [y2 + dlat, x2 + dlng],
        [y1 + dlat, x1 + dlng],
      ]);
    }

    // Projected footprint (roof shadow on ground).
    quads.push(coords.map(([y, x]) => [y + dlat, x + dlng]));

    // Original footprint.
    quads.push([...coords]);
  }

  return quads;
}
