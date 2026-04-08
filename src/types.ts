/** A pub from the pub list */
export interface Pub {
  id: string;
  name: string;
  lat: number;
  lng: number;
  beer_garden: boolean;
  outdoor_seating: boolean;
  polygon: [number, number][] | null; // building footprint [[lat,lng],...]
  outdoor: [number, number][] | null; // outdoor area [[lat,lng],...]
  plot: [number, number][] | null; // land registry plot
}

/** A building with height data */
export interface Building {
  coords: [number, number][]; // [[lat,lng],...]
  height: number; // metres above ground
}

/** A road segment */
export interface Road {
  coords: [number, number][]; // [[lat,lng],...]
  type: string; // highway tag value
}

/** Shadow quad — four corners of a shadow polygon */
export type ShadowPoly = [number, number][];

/** Sun position */
export interface SunPosition {
  azimuth: number; // compass bearing, degrees
  altitude: number; // degrees above horizon
}

/** Weather state for a location */
export type WeatherState = "sunny" | "partly-cloudy" | "overcast" | "unknown";

/** App state */
export interface AppState {
  pubs: Pub[];
  selectedPubId: string | null;
  buildings: Building[];
  roads: Road[];
  pubBuildingIndex: number; // which building is the selected pub
  shadowPolys: ShadowPoly[];
  timeMins: number; // minutes from midnight
  date: Date;
  playing: boolean;
  weatherState: WeatherState;
  userLat: number | null;
  userLng: number | null;
}
