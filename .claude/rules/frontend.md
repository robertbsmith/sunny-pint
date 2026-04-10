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
- `state.ts` — app state, pub selection, time
- `circle.ts` — porthole canvas renderer (tiles, buildings, shadows, bezel, sign)
- `shadow.ts` — geometric shadow projection from buildings
- `sunarc.ts` — sun arc time picker canvas widget
- `sunbadge.ts` — sunny rating badge display
- `buildings.ts` — vector tile loader, spatial filtering, building types
- `tiles.ts` — Stadia Maps raster tile loading for porthole background
- `sign.ts` — pub sign with procedural heraldic device
- `heraldry.ts` — deterministic heraldic shield renderer (tinctures, divisions, charges)
- `publist.ts` — pub list with search and distance sorting
- `location.ts` — GPS + Nominatim geocoding
- `weather.ts` — Open-Meteo cloud cover
- `share.ts` — image capture + Web Share API
- `url.ts` — deep linking via URL params
- `hours.ts` — opening hours parsing and display
- `welcome.ts` — first-visit welcome modal
- `theme.ts` — light/dark/system theme switching
- `storage.ts` — localStorage helpers (location, preferences)
- `geo.ts` — geographic utilities
- `config.ts` — app constants
- `icons.ts` — Lucide DOM icons
- `canvas-icons.ts` — canvas-rendered icon helpers
- `types.ts` — shared type definitions

## Conventions
- No `any` types
- No default exports — use named exports
- Pure functions where possible
- Canvas rendering functions take explicit parameters, no global state access
- Keep render functions fast — no allocations in the draw loop
- Reuse offscreen canvases, don't create per frame
- Outdoor area polygons use `[exterior, ...holes]` ring format with evenodd fill
