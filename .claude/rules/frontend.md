# Frontend Rules

Applies to: `src/**`

## Stack
- Vite 8 + TypeScript 6 + Biome + Tailwind 4
- Canvas 2D for the porthole circle view (no map library — custom tile rendering)
- Individual .pbf vector tiles for building data (fetched as static files)
- SunCalc for sun position
- vite-plugin-pwa for offline/installable

## Architecture
- All shadow computation is client-side (geometric projection)
- Building data loaded from individual z14 .pbf tile files (1-4 per pub)
- No backend at runtime — everything is static
- State is simple module-level variables, no framework

## Module Structure
- `main.ts` — entry point, wires everything together
- `shadow.ts` — geometric shadow projection from buildings
- `circle.ts` — porthole canvas renderer (tiles, buildings, shadows, bezel, sign)
- `sunarc.ts` — sun arc time picker canvas widget
- `buildings.ts` — vector tile loader, spatial filtering, building types
- `weather.ts` — Open-Meteo cloud cover
- `share.ts` — image capture + Web Share API
- `state.ts` — app state, pub selection, time
- `types.ts` — shared type definitions
- `publist.ts` — pub list with search and distance sorting
- `location.ts` — GPS + Nominatim geocoding
- `url.ts` — deep linking via URL params
- `icons.ts` — Lucide DOM icons

## Conventions
- No `any` types
- No default exports — use named exports
- Pure functions where possible
- Canvas rendering functions take explicit parameters, no global state access
- Keep render functions fast — no allocations in the draw loop
- Reuse offscreen canvases, don't create per frame
- Outdoor area polygons use `[exterior, ...holes]` ring format with evenodd fill
