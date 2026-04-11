/** Precomputed Sunny Rating, added by scripts/precompute_sun.ts. */
export interface SunMetrics {
  /** 0–100 — the headline number. */
  score: number;
  /** Human-readable bucket: "Sun trap" | "Very sunny" | "Sunny" | "Partly shaded" | "Shaded". */
  label: string;
  /** Longest contiguous span ≥50% sun on the equinox, e.g. "13:30–16:30", or null. */
  best_window: string | null;
  morning_sun: boolean;
  midday_sun: boolean;
  evening_sun: boolean;
  all_day_sun: boolean;
  sample_day: string;
}

/** A pub from OSM */
export interface Pub {
  id: string;
  name: string;
  lat: number;
  lng: number;
  clat?: number;
  clng?: number;
  elev?: number;
  horizon?: string;
  horizon_dist?: string;
  outdoor?: [number, number][][];
  outdoor_area_m2?: number;
  beer_garden?: string;
  outdoor_seating?: string;
  opening_hours?: string;
  real_ale?: string;
  food?: string;
  wheelchair?: string;
  dog?: string;
  wifi?: string;
  phone?: string;
  website?: string;
  brand?: string;
  brewery?: string;
  // Locality (added by match_plots.py — drives SEO landing pages and routing)
  slug?: string;
  town?: string;
  county?: string;
  country?: string;
  local_authority?: string;
  // Raw OSM address tags (used by match_plots.py for town derivation)
  addr_city?: string;
  addr_town?: string;
  addr_village?: string;
  addr_hamlet?: string;
  addr_suburb?: string;
  addr_place?: string;
  addr_postcode?: string;
  addr_street?: string;
  addr_housenumber?: string;
  // Precomputed Sunny Rating (offline, scripts/precompute_sun.ts)
  sun?: SunMetrics;
  // Computed at runtime
  distance?: number;
}

/** A building with height data */
export interface Building {
  coords: [number, number][]; // [[lat,lng],...]
  height: number; // metres above ground
  elev: number; // ground elevation (metres above sea level)
}

/** Shadow quad — four corners of a shadow polygon */
export type ShadowPoly = [number, number][];

/** Sun position */
export interface SunPosition {
  azimuth: number; // compass bearing, degrees
  altitude: number; // degrees above horizon
}

/** Weather state */
export type WeatherState = "sunny" | "partly-cloudy" | "overcast" | "unknown";

/** App state */
export interface AppState {
  pubs: Pub[];
  selectedPubId: string | null;
  buildings: Building[];
  pubBuildingIndex: number;
  shadowPolys: ShadowPoly[];
  terrainShadowEdgeM: number | null;
  terrainShadowAzimuth: number;
  timeMins: number; // minutes from midnight
  date: Date;
  playing: boolean;
  weatherState: WeatherState;
  userLat: number | null;
  userLng: number | null;
  satellite: boolean;
  zoomStep: 1 | 2 | 4;
  /** Pan offset in metres from pub centre. */
  panX: number;
  panY: number;
}
