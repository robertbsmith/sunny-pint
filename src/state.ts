/**
 * App state — simple module-level variables.
 * No framework, no store, just shared mutable state.
 */

import type { AppState } from "./types";

export const state: AppState = {
  pubs: [],
  selectedPubId: null,
  buildings: [],
  roads: [],
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
export function selectedPub() {
  return state.pubs.find((p) => p.id === state.selectedPubId) ?? null;
}

/** Get the pub centre, falling back to Norwich. */
export function pubCenter(): { lat: number; lng: number } {
  const pub = selectedPub();
  return pub ? { lat: pub.lat, lng: pub.lng } : { lat: 52.6309, lng: 1.2974 };
}
