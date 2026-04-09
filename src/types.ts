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
  outdoor?: [number, number][][];
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
  timeMins: number; // minutes from midnight
  date: Date;
  playing: boolean;
  weatherState: WeatherState;
  userLat: number | null;
  userLng: number | null;
}
