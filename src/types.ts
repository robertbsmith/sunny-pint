/** A pub from OSM */
export interface Pub {
  id: string;
  name: string;
  lat: number;
  lng: number;
  clat?: number; // OSM building centroid lat (more accurate than geocode)
  clng?: number; // OSM building centroid lng
  elev?: number; // ground elevation (metres above sea level)
  horizon?: string; // base64-encoded terrain horizon profile (36 azimuths, uint8 × 0.1°)
  outdoor?: [number, number][][]; // outdoor area [exterior, ...holes] each [[lat,lng],...]
  beer_garden?: string;
  outdoor_seating?: string;
  opening_hours?: string;
  distance?: number; // computed client-side, metres
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
  timeMins: number; // minutes from midnight
  date: Date;
  playing: boolean;
  weatherState: WeatherState;
  userLat: number | null;
  userLng: number | null;
}
