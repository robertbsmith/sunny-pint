/**
 * Geometric shadow projection.
 *
 * For each building, projects each wall segment as a shadow quadrilateral
 * based on building height and sun position. Pure geometry — no raster.
 */

import type { Building, ShadowPoly, SunPosition } from "./types";

const M_PER_DEG_LAT = 111_320;

export function computeShadows(
  buildings: Building[],
  sun: SunPosition,
  maxShadowLen = 200,
): ShadowPoly[] {
  if (sun.altitude <= 0 || buildings.length === 0) return [];

  const azRad = (sun.azimuth * Math.PI) / 180;
  const tanAlt = Math.tan((sun.altitude * Math.PI) / 180);

  // Approximate metres-per-degree-longitude at this latitude.
  const midLat = buildings[0]?.coords[0]?.[0] ?? 52.6;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);

  const quads: ShadowPoly[] = [];

  for (const { coords, height } of buildings) {
    if (height <= 0 || coords.length < 3) continue;

    const shadowLen = Math.min(height / tanAlt, maxShadowLen);
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
