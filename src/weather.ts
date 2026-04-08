/**
 * Weather — fetch cloud cover from Open-Meteo (free, no API key).
 * Updates the pub list with sunny/cloudy/overcast indicators.
 */

export type WeatherState = "sunny" | "partly-cloudy" | "overcast" | "unknown";

let cachedWeather: { lat: number; lng: number; state: WeatherState; fetchedAt: number } | null = null;

/** Get current weather state for a location. Cached for 10 minutes. */
export async function getWeather(lat: number, lng: number): Promise<WeatherState> {
  // Return cache if fresh and nearby.
  if (cachedWeather && Date.now() - cachedWeather.fetchedAt < 600000) {
    const dlat = Math.abs(lat - cachedWeather.lat);
    const dlng = Math.abs(lng - cachedWeather.lng);
    if (dlat < 0.1 && dlng < 0.1) return cachedWeather.state;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=cloud_cover&timezone=auto`;
    const resp = await fetch(url);
    const data = await resp.json();
    const cloudCover = data.current?.cloud_cover ?? 50;

    let state: WeatherState;
    if (cloudCover <= 25) state = "sunny";
    else if (cloudCover <= 70) state = "partly-cloudy";
    else state = "overcast";

    cachedWeather = { lat, lng, state, fetchedAt: Date.now() };
    return state;
  } catch {
    return "unknown";
  }
}

/** Get emoji + text for a weather state. */
export function weatherLabel(ws: WeatherState): string {
  switch (ws) {
    case "sunny": return "Sunny";
    case "partly-cloudy": return "Partly cloudy";
    case "overcast": return "Overcast";
    default: return "";
  }
}

export function weatherEmoji(ws: WeatherState): string {
  switch (ws) {
    case "sunny": return "\u2600\uFE0F";
    case "partly-cloudy": return "\u26C5";
    case "overcast": return "\u2601\uFE0F";
    default: return "";
  }
}
