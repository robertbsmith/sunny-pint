# SunPub

Find sunny beer garden seats. Shows real-time shadow maps for pub gardens using LiDAR elevation data, OSM building outlines, and geometric sun projection.

## Status: Migrating to New Stack

The app works as a prototype in `app/static/index.html` (Python FastAPI + single HTML file). We're migrating to a static site architecture:

- **Old stack** (in `app/`): FastAPI backend, single HTML file with inline JS, Leaflet, raster shadows → geometric shadows. This WORKS — the shadow engine, building data pipeline, and circle view are all functional.
- **New stack** (in `src/`): Vite 8 + TypeScript 6 + MapLibre GL + PMTiles. Module stubs exist, migration in progress.

Read `docs/PROJECT_PLAN.md` for the feature roadmap, `docs/ARCHITECTURE.md` for key technical decisions (with reasoning), and `docs/DATA_PIPELINE.md` for how data flows from raw sources to the app.

## Critical Context for New Sessions

If you're picking this up in a new Claude session, read the docs/ directory first. Key things that aren't obvious:
- OSGB grid north is rotated 2.6° from true north at Norwich — this breaks any raster overlay that isn't reprojected. Geometric shadow projection sidesteps this.
- Building heights are 90th percentile of LiDAR within the OSM footprint. Not max (grabs chimneys), not median (underestimates pitched roofs).
- Shadow quads from overlapping buildings cause opacity stacking — must use offscreen canvas compositing.
- The shadow max length is capped at 200m to avoid infinite geometry near sunrise/sunset. Shadow opacity fades with sun altitude for smooth transitions.
- Overpass API is unreliable for bulk queries — use the local GeoPackage (from .pbf extract) instead.
- CartoDB tile style `rastertiles/voyager_labels_under` works well for the circle background. Needs `rastertiles/` prefix for voyager styles.

## Quick Start

This project runs in a devcontainer. Open in VS Code with the Dev Containers extension, or use `devcontainer up`.

```bash
just dev          # Start Vite dev server
just build        # Production build → dist/
just pipeline     # Run full data pipeline (fetch pubs, buildings, heights, PMTiles)
```

## Architecture

**Static site** — no backend at runtime. All data is pre-computed and served as static files.

### Frontend (`src/`)
- **Vite 8** + TypeScript 6 + Biome + Tailwind 4
- **MapLibre GL JS** for the map (vector tiles, WebGL)
- **Canvas 2D** for the porthole/circle detail view
- **PMTiles** for building data (spatial index, HTTP range requests)
- **SunCalc** for sun position calculation
- **Geometric shadow projection** — client-side, per-frame, no server

### Data Pipeline (`scripts/`)
- Python scripts that process raw data into static assets
- Sources: OSM (.pbf), EA LiDAR DSM (GeoTIFF), Met Office API
- Output: `pubs.json` + `buildings.pmtiles` in `public/data/`

### Deployment
- **Cloudflare Pages** for the app (free)
- **Cloudflare R2** for the PMTiles file if too large for Pages (25MB limit)
- Or just serve everything from `dist/` on any static host

## Data Sources
- **Buildings**: OpenStreetMap (ODbL) — footprints + metadata
- **Heights**: EA LiDAR Composite DSM 1m (OGL) — sampled per building
- **Pubs**: OpenStreetMap (ODbL) — amenity=pub with beer_garden/outdoor_seating tags
- **Outdoor areas**: HM Land Registry INSPIRE Index Polygons (OGL) — plot boundaries
- **Weather**: Met Office DataPoint API (free tier)
- **Map tiles**: CartoDB Voyager (CC BY 3.0) for circle view, MapLibre vector tiles for map
- **Sun position**: SunCalc library (BSD)

## Key Decisions
- **Geometric shadow projection** over raster ray-tracing: gives mathematically precise vector edges, fast enough for 60fps client-side animation
- **PMTiles** over server-side spatial queries: entire UK building dataset in one static file, client fetches only the tiles it needs
- **MapLibre** over Leaflet: native vector tile support, WebGL rendering, better performance for data-heavy maps
- **No framework** (React/Svelte): rendering is Canvas-based, minimal DOM interaction, framework would add overhead without benefit
- **Pre-computed heights**: LiDAR sampling runs once in the build pipeline, not at runtime. 90th percentile within building footprint captures ridge height

## Features
1. Geolocation → nearby pub list with current sun status
2. Map view with pub markers (sunny/shaded/overcast)
3. Porthole detail view with animated shadow projection
4. Sun arc time scrubber with play/pause
5. Share as image/gif via Web Share API
6. Date picker for planning ahead
7. Weather overlay (Met Office) — sunny / partly cloudy / overcast states
8. Opening hours from OSM
9. Tree shadows (LiDAR + OSM natural=tree)
10. PWA — installable, offline cached, works on mobile

## Attribution
All data sources require attribution. See the app's credits section.
- OpenStreetMap: "Data (c) OpenStreetMap contributors, ODbL"
- EA LiDAR: "Contains Environment Agency information (c) Crown copyright, OGL v3"
- Land Registry: "Contains HM Land Registry data (c) Crown copyright, OGL v3"
- CartoDB: "(c) CartoDB, CC BY 3.0"
