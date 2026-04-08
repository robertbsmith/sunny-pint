# Data Pipeline Rules

Applies to: `scripts/**`

## Stack
- Python 3.11+ with uv for package management
- GeoPackage (SQLite + spatial index) as intermediate format
- PMTiles as output format for static serving
- rasterio + fiona + shapely for GIS operations

## Data Flow
1. `fetch_pubs.py` — Overpass API → `data/pubs.json`
2. `build_gpkg.py` — England .osm.pbf → `data/buildings.gpkg` (buildings + roads)
3. `measure_heights.py` — LiDAR DSM + buildings.gpkg → heights per building
4. `generate_pmtiles.py` — buildings with heights → `public/data/buildings.pmtiles`

## Conventions
- Always write to temp files then move (don't clobber live data)
- Use `uv run` to execute scripts
- Print progress for long operations
- Cache intermediate results where possible
- Building heights: 90th percentile of LiDAR DSM within footprint
- Min height filter: 6m default (filters hedges, walls, cars)
