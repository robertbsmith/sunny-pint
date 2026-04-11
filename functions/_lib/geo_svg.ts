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

/** GB bounding box (WGS84). Covers all of mainland GB + islands.
 *  Derived from actual ONS boundary extents with padding. */
const GB_BOUNDS = {
  minLng: -8.9,
  maxLng: 2.0,
  minLat: 49.7,
  maxLat: 61.1,
};

/** Latitude correction for equirectangular projection at UK mid-latitude. */
const COS_LAT = Math.cos((55 * Math.PI) / 180);

// Compute projected extent in "flat" units, then derive viewBox to fit.
const PROJ_W = (GB_BOUNDS.maxLng - GB_BOUNDS.minLng) * COS_LAT;
const PROJ_H = GB_BOUNDS.maxLat - GB_BOUNDS.minLat;

// SVG viewBox: fit to projected aspect ratio with padding.
const PAD = 12;
const SVG_H = 600;
const SVG_W = Math.round((SVG_H * PROJ_W) / PROJ_H) + PAD * 2;

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

/** Sun score (0–100) → fill color. Matches the 5-tier badge system in sunbadge.ts. */
export function scoreColor(score: number | null): string {
  if (score === null || score === undefined) return "#e0deda"; // neutral grey
  if (score >= 80) return "#fde68a"; // Sun trap — amber-200
  if (score >= 60) return "#fef3c7"; // Very sunny — amber-100
  if (score >= 40) return "#fffbeb"; // Sunny — amber-50
  if (score >= 20) return "#e0dcda"; // Partly shaded — warm grey
  return "#c4c0bb"; // Shaded — darker grey
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
 * ONS features are administrative units (boroughs, districts) which may be
 * smaller than our "counties" (ceremonial/traditional). Multiple ONS features
 * can map to one county. The onsToCounty mapping handles this aggregation.
 *
 * All ONS features are rendered (even counties without pubs) so the map
 * has no holes. Counties without data get a neutral fill.
 */
export function renderCountySvg(
  features: GeoJSONFeature[],
  countyData: Map<string, CountyData>,
  options: {
    highlight?: string;
    countryFilter?: string;
    linkPrefix?: string;
    /** ONS feature name → our county name mapping. */
    onsToCounty?: Record<string, string>;
  } = {},
): string {
  const paths: string[] = [];
  const onsMap = options.onsToCounty || {};

  for (const feature of features) {
    const onsName = feature.properties.CTYUA23NM as string;

    // Map ONS name to our county name.
    const countyName = onsMap[onsName] || onsName;
    const data = countyData.get(countyName);

    // Skip Northern Ireland.
    if (!data && !onsMap[onsName]) {
      // Render unmatched features as neutral fill (no holes).
      const d = featureToPath(feature);
      if (d) {
        paths.push(
          `<path d="${d}" fill="${scoreColor(null)}" stroke="#a8a29e" stroke-width="0.3" opacity="0.7">` +
            `<title>${onsName}</title></path>`,
        );
      }
      continue;
    }

    if (options.countryFilter && data && data.country !== options.countryFilter) continue;

    const d = featureToPath(feature);
    if (!d) continue;

    const fill = data ? scoreColor(data.avgScore) : scoreColor(null);
    const isHighlighted = data && options.highlight === data.slug;
    const stroke = isHighlighted ? "#D97706" : "#a8a29e";
    const strokeWidth = isHighlighted ? "2" : "0.5";

    if (data) {
      const href = `${options.linkPrefix || "/explore/"}${data.country.toLowerCase()}/${data.slug}/`;
      paths.push(
        `<a href="${href}">` +
          `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="0.95">` +
          `<title>${data.name} — ${data.pubCount} pubs${data.avgScore !== null ? `, avg ${Math.round(data.avgScore)}/100` : ""}</title>` +
          `</path></a>`,
      );
    } else {
      paths.push(
        `<path d="${d}" fill="${fill}" stroke="#a8a29e" stroke-width="0.3" opacity="0.7">` +
          `<title>${countyName}</title></path>`,
      );
    }
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
