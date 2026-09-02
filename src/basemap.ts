/**
 * Basemap data — roads, water, green space, car parks, hedges and trees
 * decoded from the same z14 PMTiles archive as the buildings.
 *
 * The pipeline (pipeline/stages/basemap.py) packs these as extra named
 * layers into buildings.pmtiles, so one range request per tile yields
 * both the shadow-casters and the ground they sit on. Nothing here
 * touches the network — see buildings.ts for the fetch.
 */

import { VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import Pbf from "pbf";
import type { LandKind, LineKind, RoadClass, WaterwayKind } from "./basemap_style";

/** [lat, lng] */
export type LatLng = [number, number];

/** [minLat, minLng, maxLat, maxLng] */
export type Bbox = [number, number, number, number];

export interface BasemapLine {
  coords: LatLng[];
  bbox: Bbox;
}
export interface BasemapRoad extends BasemapLine {
  cls: RoadClass;
}
export interface BasemapWaterway extends BasemapLine {
  kind: WaterwayKind;
}
export interface BasemapBarrier extends BasemapLine {
  kind: LineKind;
}
/** Polygon as [exterior, ...holes] — render with evenodd fill. */
export interface BasemapPoly {
  rings: LatLng[][];
  bbox: Bbox;
}
export interface BasemapLand extends BasemapPoly {
  kind: LandKind;
}

export interface Basemap {
  roads: BasemapRoad[];
  rail: BasemapLine[];
  waterways: BasemapWaterway[];
  water: BasemapPoly[];
  land: BasemapLand[];
  lines: BasemapBarrier[];
  trees: LatLng[];
}

export function emptyBasemap(): Basemap {
  return { roads: [], rail: [], waterways: [], water: [], land: [], lines: [], trees: [] };
}

const ROAD_CLASSES = new Set<string>(["mw", "pri", "sec", "ter", "res", "svc", "ped", "path"]);
const LAND_KINDS = new Set<string>(["green", "wood", "farm", "parking", "ped", "sand"]);
const WATERWAY_KINDS = new Set<string>(["river", "canal", "stream"]);
const LINE_KINDS = new Set<string>(["hedge", "trees", "wall"]);

function bboxOf(coords: LatLng[]): Bbox {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return [minLat, minLng, maxLat, maxLng];
}

function toLatLng(ring: number[][]): LatLng[] {
  return ring.map((c) => [c[1] ?? 0, c[0] ?? 0] as LatLng);
}

/** Every LineString in a feature (handles Multi*). */
function lineParts(feature: VectorTileFeature, tx: number, ty: number, tz: number): LatLng[][] {
  const g = feature.toGeoJSON(tx, ty, tz).geometry;
  if (g.type === "LineString") return [toLatLng(g.coordinates)];
  if (g.type === "MultiLineString") return g.coordinates.map(toLatLng);
  return [];
}

/** Every Polygon (as ring list) in a feature (handles Multi*). */
function polyParts(feature: VectorTileFeature, tx: number, ty: number, tz: number): LatLng[][][] {
  const g = feature.toGeoJSON(tx, ty, tz).geometry;
  if (g.type === "Polygon") return [g.coordinates.map(toLatLng)];
  if (g.type === "MultiPolygon") return g.coordinates.map((p) => p.map(toLatLng));
  return [];
}

function pointParts(feature: VectorTileFeature, tx: number, ty: number, tz: number): LatLng[] {
  const g = feature.toGeoJSON(tx, ty, tz).geometry;
  if (g.type === "Point") return [[g.coordinates[1] ?? 0, g.coordinates[0] ?? 0]];
  if (g.type === "MultiPoint") return toLatLng(g.coordinates);
  return [];
}

function polyBbox(rings: LatLng[][]): Bbox {
  return bboxOf(rings[0] ?? []);
}

/**
 * Decode the basemap layers of one vector tile. Missing layers are simply
 * empty — an archive built before the basemap existed still decodes.
 */
export function decodeBasemap(data: ArrayBuffer, tx: number, ty: number, tz: number): Basemap {
  const tile = new VectorTile(new Pbf(data));
  const out = emptyBasemap();

  const each = (name: string, fn: (f: VectorTileFeature) => void): void => {
    const layer = tile.layers[name];
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) fn(layer.feature(i));
  };

  each("roads", (f) => {
    const cls = String(f.properties.c ?? "");
    if (!ROAD_CLASSES.has(cls)) return;
    for (const coords of lineParts(f, tx, ty, tz)) {
      if (coords.length >= 2)
        out.roads.push({ coords, bbox: bboxOf(coords), cls: cls as RoadClass });
    }
  });

  each("rail", (f) => {
    for (const coords of lineParts(f, tx, ty, tz)) {
      if (coords.length >= 2) out.rail.push({ coords, bbox: bboxOf(coords) });
    }
  });

  each("waterways", (f) => {
    const kind = String(f.properties.k ?? "");
    if (!WATERWAY_KINDS.has(kind)) return;
    for (const coords of lineParts(f, tx, ty, tz)) {
      if (coords.length >= 2) {
        out.waterways.push({ coords, bbox: bboxOf(coords), kind: kind as WaterwayKind });
      }
    }
  });

  each("water", (f) => {
    for (const rings of polyParts(f, tx, ty, tz)) {
      if ((rings[0]?.length ?? 0) >= 3) out.water.push({ rings, bbox: polyBbox(rings) });
    }
  });

  each("land", (f) => {
    const kind = String(f.properties.k ?? "");
    if (!LAND_KINDS.has(kind)) return;
    for (const rings of polyParts(f, tx, ty, tz)) {
      if ((rings[0]?.length ?? 0) >= 3) {
        out.land.push({ rings, bbox: polyBbox(rings), kind: kind as LandKind });
      }
    }
  });

  each("lines", (f) => {
    const kind = String(f.properties.k ?? "");
    if (!LINE_KINDS.has(kind)) return;
    for (const coords of lineParts(f, tx, ty, tz)) {
      if (coords.length >= 2)
        out.lines.push({ coords, bbox: bboxOf(coords), kind: kind as LineKind });
    }
  });

  each("trees", (f) => {
    for (const p of pointParts(f, tx, ty, tz)) out.trees.push(p);
  });

  return out;
}

function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Append everything in `src` whose extent touches `bbox` onto `target`.
 * A bbox-overlap test (not a vertex-in-bbox test) so a park that fully
 * encloses the pub is kept even when none of its corners are nearby.
 */
export function appendBasemapWithin(target: Basemap, src: Basemap, bbox: Bbox): void {
  for (const r of src.roads) if (bboxIntersects(r.bbox, bbox)) target.roads.push(r);
  for (const r of src.rail) if (bboxIntersects(r.bbox, bbox)) target.rail.push(r);
  for (const w of src.waterways) if (bboxIntersects(w.bbox, bbox)) target.waterways.push(w);
  for (const w of src.water) if (bboxIntersects(w.bbox, bbox)) target.water.push(w);
  for (const l of src.land) if (bboxIntersects(l.bbox, bbox)) target.land.push(l);
  for (const l of src.lines) if (bboxIntersects(l.bbox, bbox)) target.lines.push(l);
  for (const t of src.trees) {
    if (t[0] >= bbox[0] && t[0] <= bbox[2] && t[1] >= bbox[1] && t[1] <= bbox[3]) {
      target.trees.push(t);
    }
  }
}
