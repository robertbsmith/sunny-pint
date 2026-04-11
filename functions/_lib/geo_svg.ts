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

import { Delaunay } from "d3-delaunay";

// ── Projection ─────────────────────────────────────────────────────────

/** GB bounding box (WGS84). Covers mainland GB including Scottish Highlands.
 *  Excludes Shetland/Orkney. */
const GB_BOUNDS = {
  minLng: -6.5,
  maxLng: 2.0,
  minLat: 49.8,
  maxLat: 58.8,
};

/** Latitude correction for equirectangular projection at UK mid-latitude. */
const COS_LAT = Math.cos((55 * Math.PI) / 180);

// Compute projected extent in "flat" units, then derive viewBox to fit.
const PROJ_W = (GB_BOUNDS.maxLng - GB_BOUNDS.minLng) * COS_LAT; // ~5.74°
const PROJ_H = GB_BOUNDS.maxLat - GB_BOUNDS.minLat; // 11°

// SVG viewBox: fit to projected aspect ratio with padding.
const PAD = 8;
const SVG_H = 600;
const SVG_W = Math.round((SVG_H * PROJ_W) / PROJ_H) + PAD * 2; // ~313

/** Equirectangular projection to SVG coordinates. */
function project(lng: number, lat: number): [number, number] {
  const x =
    PAD +
    ((lng - GB_BOUNDS.minLng) * COS_LAT / PROJ_W) *
      (SVG_W - PAD * 2);
  const y =
    PAD +
    (1 - (lat - GB_BOUNDS.minLat) / PROJ_H) *
      (SVG_H - PAD * 2);
  return [x, y];
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
    overlayPaths?: string;
    /** GeoJSON features to use as clip mask (e.g. country outlines). */
    clipFeatures?: GeoJSONFeature[];
  } = {},
): string {
  if (points.length < 3) return "";

  // Project all points to SVG coordinates.
  const projected = points.map((p) => project(p.lng, p.lat));

  // Use d3-delaunay for robust Voronoi computation.
  const delaunay = Delaunay.from(projected);
  const voronoi = delaunay.voronoi([0, 0, SVG_W, SVG_H]);

  // Build clipPath from coastline if provided.
  let clipDef = "";
  let clipAttr = "";
  if (options.clipFeatures && options.clipFeatures.length > 0) {
    const clipPaths = options.clipFeatures
      .map((f) => featureToPath(f))
      .filter(Boolean)
      .join(" ");
    clipDef =
      `<defs><clipPath id="gb-clip">` +
      `<path d="${clipPaths}"/>` +
      `</clipPath></defs>\n`;
    clipAttr = ' clip-path="url(#gb-clip)"';
  }

  const cellPaths: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const cell = voronoi.cellPolygon(i);
    if (!cell || cell.length < 3) continue;

    const point = points[i]!;
    const fill = scoreColor(point.score);

    const d = cell
      .map(([x, y], j) => `${j === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join("")
      .concat("Z");

    cellPaths.push(
      `<a href="${point.href}">` +
        `<path d="${d}" fill="${fill}" stroke="#fff" stroke-width="0.2" opacity="0.85">` +
        `<title>${point.label}</title>` +
        `</path></a>`,
    );
  }

  return (
    `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg" ` +
    `class="explore-map" role="img" aria-label="Sun score map">\n` +
    clipDef +
    `<g${clipAttr}>\n` +
    cellPaths.join("\n") +
    `\n</g>\n` +
    (options.overlayPaths ? `${options.overlayPaths}\n` : "") +
    "</svg>"
  );
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
