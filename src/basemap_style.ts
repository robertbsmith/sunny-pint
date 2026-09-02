/**
 * Basemap style — the single palette shared by the live canvas porthole
 * (circle.ts) and the SVG porthole used for OG cards (porthole_svg.ts).
 *
 * Widths are in METRES so roads scale correctly with porthole zoom; the
 * renderers divide by metres-per-pixel. Casing is in pixels so road edges
 * stay crisp at every zoom.
 *
 * Kinds/classes must match pipeline/stages/basemap.py.
 */

export type RoadClass = "mw" | "pri" | "sec" | "ter" | "res" | "svc" | "ped" | "path";
export type LandKind = "green" | "wood" | "farm" | "parking" | "ped" | "sand";
export type WaterwayKind = "river" | "canal" | "stream";
export type LineKind = "hedge" | "trees" | "wall";

/** Ground colour under everything (matches the warm off-white of the UI). */
export const GROUND_FILL = "#F1EEE8";

export const LAND_FILL: Record<LandKind, string> = {
  green: "#CBE5BE",
  wood: "#B4D2A4",
  farm: "#EEEAD8",
  parking: "#E2DFD8",
  ped: "#E9E6DF",
  sand: "#F4EAC8",
};

/** Parking bays get a faint outline so they read as a surface, not a gap. */
export const PARKING_STROKE = "#CEC9C1";

export const WATER_FILL = "#9CC6E6";

/** Waterway line widths in metres. */
export const WATERWAY_WIDTH_M: Record<WaterwayKind, number> = {
  river: 8,
  canal: 6,
  stream: 2,
};

export interface RoadStyle {
  /** Carriageway width in metres. */
  widthM: number;
  fill: string;
  /** Casing colour; empty string = no casing (paths). */
  casing: string;
}

export const ROAD_STYLE: Record<RoadClass, RoadStyle> = {
  mw: { widthM: 14, fill: "#F5B95B", casing: "#D89A3A" },
  pri: { widthM: 10, fill: "#FBE29B", casing: "#D9BD6A" },
  sec: { widthM: 9, fill: "#FDF0C4", casing: "#D9CB92" },
  ter: { widthM: 7.5, fill: "#FFFFFF", casing: "#C9C3BA" },
  res: { widthM: 6, fill: "#FFFFFF", casing: "#C9C3BA" },
  svc: { widthM: 3.5, fill: "#FFFFFF", casing: "#D3CEC6" },
  ped: { widthM: 4, fill: "#EDEAE3", casing: "#D3CEC6" },
  path: { widthM: 0.9, fill: "#B8A48E", casing: "" },
};

/** Draw order, least important first, so major roads sit on top. */
export const ROAD_ORDER: RoadClass[] = ["svc", "ped", "res", "ter", "sec", "pri", "mw"];

/** Extra casing on each side, in pixels. */
export const ROAD_CASING_PX = 1.5;

/** Footpath dash pattern in metres [on, off]. */
export const PATH_DASH_M: [number, number] = [2.5, 2];

export const RAIL_STYLE = {
  widthM: 2.4,
  color: "#9C9C9C",
  dash: "#FFFFFF",
  dashM: [6, 6] as [number, number],
};

export interface LineStyle {
  widthM: number;
  color: string;
}

export const LINE_STYLE: Record<LineKind, LineStyle> = {
  hedge: { widthM: 1.2, color: "#7FAE6F" },
  trees: { widthM: 4, color: "rgba(98,150,84,0.55)" },
  wall: { widthM: 0.8, color: "#A39C92" },
};

/** Individual trees: canopy radius in metres. */
export const TREE_STYLE = {
  radiusM: 2.5,
  fill: "rgba(96,152,86,0.6)",
  stroke: "rgba(66,112,58,0.7)",
};
