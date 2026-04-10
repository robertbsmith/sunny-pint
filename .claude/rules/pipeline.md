# Data Pipeline Rules

Applies to: `scripts/**`

## Stack
- Python 3.11+ with uv for package management
- GeoPackage (SQLite + spatial index) as intermediate format
- PMTiles archive for building vector tiles (served from R2 via range requests)
- rasterio + fiona + shapely for GIS operations

## Data Flow
1. `merge_pubs.py` — OSM .pbf → `data/pubs_merged.json`
2. `download_inspire.py` — HM Land Registry → `data/inspire/*.gml`
3. `build_inspire_gpkg.py` — INSPIRE GMLs → `data/inspire.gpkg` (indexed spatial DB)
4. `build_gpkg.py` — OSM .pbf → `data/buildings.gpkg` (streamed, not in-memory)
5. `measure_heights.py` — LiDAR DSM/DTM + buildings.gpkg → heights per building
6. `match_plots.py` — pubs + INSPIRE + buildings → `public/data/pubs.json` (with outdoor areas)
7. `compute_horizons.py` — DTM + pubs → terrain horizon profiles per pub
8. `generate_tiles.py` — buildings near pubs → `public/data/buildings.pmtiles`
9. `precompute_sun.ts` — simulate equinox sun path → Sunny Rating per pub in pubs.json

## Conventions
- Stream large datasets to disk — never accumulate millions of items in memory
- Always write to temp files then move (don't clobber live data)
- Use `uv run` to execute scripts
- Print progress with counts and ETA for long operations
- Cache intermediate results where possible (INSPIRE downloads, LiDAR tiles)
- Building heights: 90th percentile of LiDAR (DSM - DTM) within footprint
- Min height filter: 6m default (filters hedges, walls, cars)
- Height-dependent building radius: short buildings excluded if too far to shadow the pub
- Outdoor areas subtract ALL buildings from parcel, not just the pub's own building
