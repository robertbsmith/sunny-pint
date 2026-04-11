/**
 * App state — simple module-level variables.
 * No framework, no store, just shared mutable state.
 */

import { DEFAULT_LAT, DEFAULT_LNG, M_PER_DEG_LAT } from "./config";
import type { AppState, Pub } from "./types";

export const state: AppState = {
  pubs: [],
  selectedPubId: null,
  buildings: [],
  pubBuildingIndex: -1,
  shadowPolys: [],
  terrainShadowEdgeM: null as number | null,
  terrainShadowAzimuth: 0,
  timeMins: 720, // noon
  date: new Date(),
  playing: false,
  weatherState: "unknown",
  userLat: null,
  userLng: null,
  satellite: false,
  zoomStep: 1,
  panX: 0,
  panY: 0,
};

/** Get the selected pub object, or null. */
export function selectedPub(): Pub | null {
  return state.pubs.find((p) => p.id === state.selectedPubId) ?? null;
}

/** Get the pub centre (no pan offset). */
export function pubOrigin(): { lat: number; lng: number } {
  const pub = selectedPub();
  if (!pub) return { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
  if (pub.clat != null && pub.clng != null) {
    return { lat: pub.clat, lng: pub.clng };
  }
  return { lat: pub.lat, lng: pub.lng };
}

/** Get the view centre, with pan offset applied. */
export function pubCenter(): { lat: number; lng: number } {
  const origin = pubOrigin();
  if (state.panX === 0 && state.panY === 0) return origin;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: origin.lat + state.panY / M_PER_DEG_LAT,
    lng: origin.lng + state.panX / mPerDegLng,
  };
}
