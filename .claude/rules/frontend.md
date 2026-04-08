# Frontend Rules

Applies to: `src/**`

## Stack
- Vite 8 + TypeScript 6 + Biome + Tailwind 4
- MapLibre GL JS for the map (not Leaflet)
- Canvas 2D for the porthole circle view
- PMTiles for building data (static spatial index)
- SunCalc for sun position
- vite-plugin-pwa for offline/installable

## Architecture
- All shadow computation is client-side (geometric projection)
- Building data loaded from PMTiles via HTTP range requests
- No backend at runtime — everything is static
- State is simple module-level variables, no framework

## Module Structure
- `main.ts` — entry point, wires everything together
- `map.ts` — MapLibre setup, layers, markers
- `shadow.ts` — geometric shadow projection from buildings
- `circle.ts` — porthole canvas renderer
- `sunarc.ts` — sun arc time picker canvas widget
- `buildings.ts` — PMTiles loader, building data types
- `weather.ts` — Met Office API integration
- `share.ts` — image/gif capture + Web Share API
- `state.ts` — app state, pub selection, time
- `types.ts` — shared type definitions

## Conventions
- No `any` types
- No default exports — use named exports
- Pure functions where possible
- Canvas rendering functions take explicit parameters, no global state access
- Keep render functions fast — no allocations in the draw loop
- Reuse offscreen canvases, don't create per frame
