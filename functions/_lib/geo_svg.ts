/**
 * GeoJSON → SVG converter + Voronoi tessellation for explore pages.
 *
 * Generates SVG maps colored by sun scores at build time. Two modes:
 *
 * 1. **County boundaries**: ONS boundary polygons rendered as SVG paths
 *    with county-level average sun scores for fill color.
 *
 * 2. **Voronoi tessellation**: Each pub/cell becomes a Voronoi region
 *    colored by its sun score. Dense city areas become tight mosaic tiles,
 *    rural areas are large single-color patches. Clipped to coastline.
 *
 * All coordinates are projected from WGS84 to a simple equirectangular
 * projection scaled to a fixed SVG viewBox. Distortion is minimal at
 * UK latitudes (50°–60°N).
 */

import Delaunator from "delaunator";

// ── Projection ─────────────────────────────────────────────────────────

/** GB bounding box (WGS84). */
const GB_BOUNDS = {
  minLng: -8.2,
  maxLng: 1.8,
  minLat: 49.9,
  maxLat: 60.9,
};

/** SVG viewBox dimensions. */
const SVG_W = 400;
const SVG_H = 600;

/** Equirectangular projection with latitude correction. */
function project(lng: number, lat: number): [number, number] {
  // Correct for longitude compression at UK latitude (~55°).
  const cosLat = Math.cos((55 * Math.PI) / 180);
  const x =
    ((lng - GB_BOUNDS.minLng) / (GB_BOUNDS.maxLng - GB_BOUNDS.minLng)) *
    cosLat *
    SVG_W;
  // SVG Y is top-down, lat is bottom-up.
  const y =
    (1 - (lat - GB_BOUNDS.minLat) / (GB_BOUNDS.maxLat - GB_BOUNDS.minLat)) *
    SVG_H;
  // Center horizontally (GB is narrower than the viewBox after cos correction).
  const xOffset = (SVG_W - SVG_W * cosLat) / 2;
  return [x + xOffset, y];
}

// ── Color ──────────────────────────────────────────────────────────────

/** Sun score (0–100) → fill color. Cool slate → warm amber. */
export function scoreColor(score: number | null): string {
  if (score === null || score === undefined) return "hsl(210, 10%, 85%)";
  // Clamp 0–100.
  const s = Math.max(0, Math.min(100, score));
  // Interpolate hue: 210 (cool blue-grey) → 38 (warm amber).
  const hue = 210 - (s / 100) * 172;
  // Interpolate saturation: 15% → 85%.
  const sat = 15 + (s / 100) * 70;
  // Interpolate lightness: 75% → 55%.
  const lit = 75 - (s / 100) * 20;
  return `hsl(${Math.round(hue)}, ${Math.round(sat)}%, ${Math.round(lit)}%)`;
}

// ── GeoJSON → SVG paths ──────────────────────────────────────────────

type GeoJSONFeature = {
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: number[][][] | number[][][][];
  };
};

/** Convert a GeoJSON polygon ring to an SVG path `d` attribute. */
function ringToPath(ring: number[][]): string {
  return ring
    .map((coord, i) => {
      const [x, y] = project(coord[0]!, coord[1]!);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("")
    .concat("Z");
}

/** Convert a GeoJSON feature (Polygon or MultiPolygon) to SVG path d. */
function featureToPath(feature: GeoJSONFeature): string {
  const { type, coordinates } = feature.geometry;
  if (type === "Polygon") {
    return (coordinates as number[][][])
      .map((ring) => ringToPath(ring))
      .join("");
  }
  if (type === "MultiPolygon") {
    return (coordinates as number[][][][])
      .map((poly) => poly.map((ring) => ringToPath(ring)).join(""))
      .join("");
  }
  return "";
}

// ── County boundary SVG ──────────────────────────────────────────────

export interface CountyData {
  name: string;
  slug: string;
  country: string;
  pubCount: number;
  avgScore: number | null;
}

/**
 * Render county boundaries as an SVG string.
 *
 * @param features ONS county GeoJSON features
 * @param countyData Map of ONS county name → CountyData
 * @param options.highlight County slug to highlight (for county pages)
 * @param options.countryFilter Only show counties in this country
 */
export function renderCountySvg(
  features: GeoJSONFeature[],
  countyData: Map<string, CountyData>,
  options: {
    highlight?: string;
    countryFilter?: string;
    linkPrefix?: string;
  } = {},
): string {
  const paths: string[] = [];

  for (const feature of features) {
    const onsName = feature.properties.CTYUA23NM as string;
    const data = countyData.get(onsName);
    if (!data) continue;
    if (options.countryFilter && data.country !== options.countryFilter) continue;

    const d = featureToPath(feature);
    if (!d) continue;

    const fill = scoreColor(data.avgScore);
    const isHighlighted = options.highlight === data.slug;
    const stroke = isHighlighted ? "#D97706" : "#fff";
    const strokeWidth = isHighlighted ? "2" : "0.5";
    const href = `${options.linkPrefix || "/explore/"}${data.country.toLowerCase()}/${data.slug}/`;

    paths.push(
      `<a href="${href}">` +
        `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="0.9">` +
        `<title>${data.name} — ${data.pubCount} pubs${data.avgScore !== null ? `, avg ${Math.round(data.avgScore)}/100` : ""}</title>` +
        `</path></a>`,
    );
  }

  return (
    `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg" ` +
    `class="explore-map" role="img" aria-label="Map of UK counties colored by sun score">\n` +
    paths.join("\n") +
    "\n</svg>"
  );
}

// ── Voronoi tessellation ─────────────────────────────────────────────

export interface VoronoiPoint {
  lng: number;
  lat: number;
  score: number | null;
  label: string;
  href: string;
}

/**
 * Compute Voronoi tessellation and render as SVG.
 *
 * Each point becomes a Voronoi cell colored by its sun score.
 * Cells are clipped to the bounding box (coastline clipping is approximate).
 */
export function renderVoronoiSvg(
  points: VoronoiPoint[],
  options: {
    bounds?: typeof GB_BOUNDS;
    overlayPaths?: string; // Additional SVG paths (county boundaries as strokes)
  } = {},
): string {
  if (points.length < 3) return "";

  const bounds = options.bounds || GB_BOUNDS;

  // Project all points.
  const projected = points.map((p) => project(p.lng, p.lat));
  const coords = new Float64Array(projected.length * 2);
  for (let i = 0; i < projected.length; i++) {
    coords[i * 2] = projected[i]![0];
    coords[i * 2 + 1] = projected[i]![1];
  }

  // Compute Delaunay triangulation.
  const delaunay = new Delaunator(coords);

  // Compute Voronoi cells from Delaunay triangulation.
  const cells = voronoiCells(delaunay, projected, SVG_W, SVG_H);

  const paths: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell || cell.length < 3) continue;

    const point = points[i]!;
    const fill = scoreColor(point.score);

    const d = cell
      .map(([x, y], j) => `${j === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join("")
      .concat("Z");

    paths.push(
      `<a href="${point.href}">` +
        `<path d="${d}" fill="${fill}" stroke="#fff" stroke-width="0.2" opacity="0.85">` +
        `<title>${point.label}</title>` +
        `</path></a>`,
    );
  }

  return (
    `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg" ` +
    `class="explore-map" role="img" aria-label="Sun score map">\n` +
    paths.join("\n") +
    (options.overlayPaths ? `\n${options.overlayPaths}` : "") +
    "\n</svg>"
  );
}

/**
 * Compute Voronoi cells from a Delaunay triangulation.
 * Returns an array of polygons (one per input point).
 */
function voronoiCells(
  delaunay: Delaunator<ArrayLike<number>>,
  points: [number, number][],
  width: number,
  height: number,
): [number, number][][] {
  const { triangles, halfedges } = delaunay;
  const numPoints = points.length;
  const numTriangles = triangles.length / 3;

  // Compute circumcenters of all triangles.
  const circumcenters: [number, number][] = [];
  for (let t = 0; t < numTriangles; t++) {
    const i0 = triangles[t * 3]!;
    const i1 = triangles[t * 3 + 1]!;
    const i2 = triangles[t * 3 + 2]!;
    const [ax, ay] = points[i0]!;
    const [bx, by] = points[i1]!;
    const [cx, cy] = points[i2]!;

    const dx = bx - ax;
    const dy = by - ay;
    const ex = cx - ax;
    const ey = cy - ay;
    const bl = dx * dx + dy * dy;
    const cl = ex * ex + ey * ey;
    const det = 2 * (dx * ey - dy * ex);

    if (Math.abs(det) < 1e-10) {
      circumcenters.push([(ax + bx + cx) / 3, (ay + by + cy) / 3]);
    } else {
      circumcenters.push([
        ax + (ey * bl - dy * cl) / det,
        ay + (dx * cl - ex * bl) / det,
      ]);
    }
  }

  // Build adjacency: for each point, collect surrounding triangles in order.
  const pointToTriangles: number[][] = Array.from(
    { length: numPoints },
    () => [],
  );
  for (let t = 0; t < numTriangles; t++) {
    for (let j = 0; j < 3; j++) {
      pointToTriangles[triangles[t * 3 + j]!]!.push(t);
    }
  }

  // For each point, walk around its triangles to build the Voronoi cell.
  const cells: [number, number][][] = [];
  for (let i = 0; i < numPoints; i++) {
    const tris = pointToTriangles[i]!;
    if (tris.length === 0) {
      cells.push([]);
      continue;
    }

    // Order circumcenters by angle around the point.
    const [px, py] = points[i]!;
    const sorted = tris
      .map((t) => {
        const [cx, cy] = circumcenters[t]!;
        return { t, angle: Math.atan2(cy - py, cx - px) };
      })
      .sort((a, b) => a.angle - b.angle);

    const cell: [number, number][] = sorted.map((s) => circumcenters[s.t]!);

    // Clip to viewBox.
    const clipped = clipPolygon(cell, width, height);
    cells.push(clipped);
  }

  return cells;
}

/** Clip a polygon to a rectangle (0,0)-(w,h) using Sutherland-Hodgman. */
function clipPolygon(
  polygon: [number, number][],
  w: number,
  h: number,
): [number, number][] {
  type Edge = (p: [number, number]) => boolean;
  type Intersect = (
    a: [number, number],
    b: [number, number],
  ) => [number, number];

  const edges: [Edge, Intersect][] = [
    // Left
    [
      (p) => p[0] >= 0,
      (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])],
    ],
    // Right
    [
      (p) => p[0] <= w,
      (a, b) => [w, a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])],
    ],
    // Top
    [
      (p) => p[1] >= 0,
      (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0],
    ],
    // Bottom
    [
      (p) => p[1] <= h,
      (a, b) => [a[0] + ((b[0] - a[0]) * (h - a[1])) / (b[1] - a[1]), h],
    ],
  ];

  let output = polygon;
  for (const [inside, intersect] of edges) {
    if (output.length === 0) break;
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      if (inside(current)) {
        if (!inside(prev)) output.push(intersect(prev, current));
        output.push(current);
      } else if (inside(prev)) {
        output.push(intersect(prev, current));
      }
    }
  }
  return output;
}

// ── Country outline paths (for overlay) ──────────────────────────────

/**
 * Render country boundaries as thin stroke-only paths (no fill).
 * Used as an overlay on the Voronoi map for navigation reference.
 */
export function renderCountryOverlay(
  features: GeoJSONFeature[],
  filter?: string,
): string {
  return features
    .filter((f) => !filter || f.properties.CTRY23NM === filter)
    .map((f) => {
      const d = featureToPath(f);
      return d
        ? `<path d="${d}" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.6"/>`
        : "";
    })
    .filter(Boolean)
    .join("\n");
}
