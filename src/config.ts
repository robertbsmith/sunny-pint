/**
 * Application configuration.
 *
 * Single source of truth for constants, defaults, and external service URLs.
 * Several values must stay in sync with the Python data pipeline — those are
 * marked with a `// pipeline:` comment indicating the matching Python constant.
 */

// ── Geographic constants ─────────────────────────────────────────────

/** Metres per degree of latitude. Constant globally to within 0.5%. */
export const M_PER_DEG_LAT = 111_320;

/** Web Mercator metres-per-pixel constant at the equator at zoom 0. */
export const WEB_MERCATOR_C = 156_543.03;

/** Earth radius in metres (mean). */
export const EARTH_RADIUS_M = 6_371_000;

// ── Default location ─────────────────────────────────────────────────

/** Default centre of map when no GPS or URL parameters provided (Norwich). */
export const DEFAULT_LAT = 52.6309;
export const DEFAULT_LNG = 1.2974;
export const DEFAULT_LOCATION_NAME = "Norwich";

// ── Building & shadow tuning ─────────────────────────────────────────

/** Porthole viewport radius in metres at zoom 18 UK latitudes. */
export const PORTHOLE_RADIUS_M = 74; // pipeline: PORTHOLE_RADIUS_M

/** Maximum shadow length cap to prevent infinite geometry near sunset. */
export const SHADOW_CAP_M = 200; // pipeline: SHADOW_CAP_M

/** Total radius for which we load buildings (porthole + shadow reach). */
export const LOAD_RADIUS_M = PORTHOLE_RADIUS_M + SHADOW_CAP_M; // 274

/** Web Mercator zoom level used for the porthole map tiles. */
export const TILE_ZOOM = 18;

/** Vector tile zoom level for building data files. Must match generate_tiles.py. */
export const BUILDING_TILE_ZOOM = 14;

// ── Day/night transitions ────────────────────────────────────────────

/** Sun altitude offset for the dayFrac formula: dayFrac = (alt + DAY_FRAC_OFFSET) / DAY_FRAC_RANGE. */
export const DAY_FRAC_OFFSET = 2;
export const DAY_FRAC_RANGE = 10;

/** Twilight crossfade thresholds for moon ↔ sun icon swap. */
export const TWILIGHT_NIGHT = 0.3;
export const TWILIGHT_DAY = 0.7;

// ── External services ────────────────────────────────────────────────

/** Mapbox raster tile URLs. 200k Static Tile requests/month free.
 *  Token is public (restricted via URL allowlisting in Mapbox dashboard). */
const MAPBOX_TOKEN =
  "pk.eyJ1Ijoicm9iZXJ0YnNtaXRoIiwiYSI6ImNtbnQyemVnbzBoNmYycHIyaHJvb3RremEifQ.zJRELIw_QaWTW0NRQc6-8g";
export const TILE_URL = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`;
export const SATELLITE_TILE_URL = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`;

/** Open-Meteo current weather API. */
export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

/** Nominatim search & reverse geocoding API. */
export const NOMINATIM_URL = "https://nominatim.openstreetmap.org";

/** Google Maps search URL template (for directions). */
export function googleMapsUrl(name: string, lat: number, lng: number): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${lat},${lng},17z`;
}

/** User-Agent header for outbound API requests. */
export const USER_AGENT = "SunnyPint/0.1 (https://sunny-pint.co.uk; hello@sunny-pint.co.uk)";

// ── Caching ──────────────────────────────────────────────────────────

/** Weather cache TTL (10 minutes). */
export const WEATHER_TTL_MS = 10 * 60 * 1000;

/** Maximum coordinate distance for weather cache hit (degrees). */
export const WEATHER_CACHE_TOLERANCE_DEG = 0.1;

/** Maximum entries in the porthole map tile cache. */
export const TILE_CACHE_MAX = 200;

// ── UI tuning ────────────────────────────────────────────────────────

/** Pub list rendering limit (DOM perf). */
export const PUB_LIST_MAX = 100;

/** Sun arc animation playback rate (minutes per real-time second). */
export const PLAY_SPEED = 120;

/** Search input debounce delay (ms). */
export const SEARCH_DEBOUNCE_MS = 300;

/** GPS request timeout (ms). */
export const GPS_TIMEOUT_MS = 8000;

/** GPS cache freshness (ms). */
export const GPS_MAX_AGE_MS = 60_000;
