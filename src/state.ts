/**
 * App state — simple module-level variables.
 * No framework, no store, just shared mutable state.
 */

import type { AppState, Pub } from "./types";

export const state: AppState = {
  pubs: [],
  selectedPubId: null,
  buildings: [],
  pubBuildingIndex: -1,
  shadowPolys: [],
  timeMins: 720, // noon
  date: new Date(),
  playing: false,
  weatherState: "unknown",
  userLat: null,
  userLng: null,
};

/** Get the selected pub object, or null. */
export function selectedPub(): Pub | null {
  return state.pubs.find((p) => p.id === state.selectedPubId) ?? null;
}

/** Get the pub centre, preferring OSM polygon centroid over FSA geocode. */
export function pubCenter(): { lat: number; lng: number } {
  const pub = selectedPub();
  if (!pub) return { lat: 52.6309, lng: 1.2974 };

  if (pub.clat != null && pub.clng != null) {
    return { lat: pub.clat, lng: pub.clng };
  }

  return { lat: pub.lat, lng: pub.lng };
}
