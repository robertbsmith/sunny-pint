/**
 * Geographic helper functions.
 *
 * Web Mercator projection, distance calculation, and lat/lng ↔ tile/pixel
 * conversions used by the porthole renderer and building loader.
 */

import { EARTH_RADIUS_M, M_PER_DEG_LAT, WEB_MERCATOR_C } from "./config";

/** Convert degrees to radians. */
export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Convert radians to degrees. */
export function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Metres per degree of longitude at the given latitude. */
export function mPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos(toRad(lat));
}

/** Great-circle distance in metres between two WGS84 points. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Web Mercator metres-per-pixel at the given latitude and zoom. */
export function tileMetresPerPixel(lat: number, zoom: number): number {
  return (WEB_MERCATOR_C * Math.cos(toRad(lat))) / 2 ** zoom;
}

/**
 * Convert lat/lng to a Web Mercator tile coordinate at the given zoom.
 *
 * Returns integer tile x, y plus the pixel offset within the tile.
 */
export function lngLatToTile(
  lng: number,
  lat: number,
  zoom: number,
): { tx: number; ty: number; px: number; py: number } {
  const n = 2 ** zoom;
  const tx = ((lng + 180) / 360) * n;
  const latRad = toRad(lat);
  const ty = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return {
    tx: Math.floor(tx),
    ty: Math.floor(ty),
    px: (tx - Math.floor(tx)) * 256,
    py: (ty - Math.floor(ty)) * 256,
  };
}

/** Floor lat/lng to integer tile x,y at the given zoom. */
export function lngLatToTileXY(lng: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = toRad(lat);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return [Math.min(x, n - 1), Math.min(y, n - 1)];
}

/** Convert lat/lng to pixel offset relative to a centre point. */
export function toPixel(
  lat: number,
  lng: number,
  centre: { lat: number; lng: number },
  metersPerPixel: number,
): { x: number; y: number } {
  const dx = (lng - centre.lng) * mPerDegLng(centre.lat);
  const dy = (lat - centre.lat) * M_PER_DEG_LAT;
  return { x: dx / metersPerPixel, y: -dy / metersPerPixel }; // y inverted for canvas
}

/** Centroid (arithmetic mean) of a polygon ring. */
export function polygonCentroid(coords: [number, number][]): [number, number] {
  let latSum = 0;
  let lngSum = 0;
  const n = coords.length;
  for (const [lat, lng] of coords) {
    latSum += lat;
    lngSum += lng;
  }
  return [latSum / n, lngSum / n];
}
