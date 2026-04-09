/**
 * Weather — fetch cloud cover from Open-Meteo (free, no API key).
 *
 * Cached for 10 minutes per location, with a small distance tolerance so
 * scrolling between nearby pubs doesn't trigger duplicate fetches.
 */

import { OPEN_METEO_URL, WEATHER_CACHE_TOLERANCE_DEG, WEATHER_TTL_MS } from "./config";
import type { WeatherState } from "./types";

interface WeatherCache {
  lat: number;
  lng: number;
  state: WeatherState;
  fetchedAt: number;
}

let cache: WeatherCache | null = null;

/** Get the current weather state for a location. */
export async function getWeather(lat: number, lng: number): Promise<WeatherState> {
  if (cache && Date.now() - cache.fetchedAt < WEATHER_TTL_MS) {
    const dlat = Math.abs(lat - cache.lat);
    const dlng = Math.abs(lng - cache.lng);
    if (dlat < WEATHER_CACHE_TOLERANCE_DEG && dlng < WEATHER_CACHE_TOLERANCE_DEG) {
      return cache.state;
    }
  }

  try {
    const url = `${OPEN_METEO_URL}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=cloud_cover&timezone=auto`;
    const resp = await fetch(url);
    const data = (await resp.json()) as { current?: { cloud_cover?: number } };
    const cloudCover = data.current?.cloud_cover ?? 50;

    let state: WeatherState;
    if (cloudCover <= 25) state = "sunny";
    else if (cloudCover <= 70) state = "partly-cloudy";
    else state = "overcast";

    cache = { lat, lng, state, fetchedAt: Date.now() };
    return state;
  } catch {
    return "unknown";
  }
}

/** Get a human-readable label for a weather state. */
export function weatherLabel(ws: WeatherState): string {
  switch (ws) {
    case "sunny":
      return "Sunny";
    case "partly-cloudy":
      return "Partly cloudy";
    case "overcast":
      return "Overcast";
    default:
      return "";
  }
}

/** Get an emoji glyph for a weather state. */
export function weatherEmoji(ws: WeatherState): string {
  switch (ws) {
    case "sunny":
      return "\u2600\uFE0F";
    case "partly-cloudy":
      return "\u26C5";
    case "overcast":
      return "\u2601\uFE0F";
    default:
      return "";
  }
}
