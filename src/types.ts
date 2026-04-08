/** A pub from the merged pub list (FSA + VOA + OSM) */
export interface Pub {
  id: string;
  name: string;
  lat: number;
  lng: number;
  postcode: string;
  in_fsa: boolean;
  in_osm: boolean;
  in_voa: boolean;
  osm_id?: string;
  polygon?: [number, number][]; // building footprint [[lat,lng],...]
  outdoor?: [number, number][]; // outdoor area [[lat,lng],...]
  beer_garden?: string;
  outdoor_seating?: string;
  opening_hours?: string;
  rateable_value?: number;
  distance?: number; // computed client-side, metres
}

/** A building with height data */
export interface Building {
  coords: [number, number][]; // [[lat,lng],...]
  height: number; // metres above ground
}

/** Shadow quad — four corners of a shadow polygon */
export type ShadowPoly = [number, number][];

/** Sun position */
export interface SunPosition {
  azimuth: number; // compass bearing, degrees
  altitude: number; // degrees above horizon
}

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
  userLat: number | null;
  userLng: number | null;
}
