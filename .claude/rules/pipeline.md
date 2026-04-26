# Data Pipeline Rules

Applies to: `pipeline/**`, `scripts/**`

## Stack
- Python 3.11+ with uv for package management
- GeoPackage (SQLite + spatial index) as intermediate format
- PMTiles archive for building vector tiles (served from R2 via range requests)
- rasterio + fiona + shapely for GIS operations
- boto3 for R2 uploads (S3 API with ThreadPoolExecutor)

## Pipeline v2 (pipeline/)

Five-stage pipeline with manifest-based change detection:

```
EXTRACT  → pubs_merged.json + buildings.gpkg
INDEX    → inspire.gpkg + scotland_parcels.gpkg
ENRICH   → pubs_enriched.json (heights, horizons, outdoor areas, LA)
PACKAGE  → pubs.json + pubs-index.json + per-pub files + buildings.pmtiles
SCORE    → sun scores → regenerates index + per-pub files
```

Run via: `uv run python pipeline/run.py --area uk`

### Key files
- `pipeline/run.py` — orchestrator CLI (--area, --stage, --force, --dry-run)
- `pipeline/manifest.py` — input hashing, change detection (keyed by stage:area)
- `pipeline/stages/horizon.py` — independent horizon recompute (OS Terrain 50, 3km range)
- `pipeline/utils/terrain50.py` — OS Terrain 50 loader (50m DTM, auto-downloaded)
- `pipeline/utils/download.py` — auto-download OSM extracts + OS Terrain 50
- `pipeline/utils/bundles.py` — Defra LiDAR bundle download/decode

### Data flow
- `pubs_merged.json` — raw OSM extract (EXTRACT output)
- `pubs_enriched.json` — enriched with heights, horizons, outdoor, LA (ENRICH output)
- `pubs.json` — final with slugs, towns, sun scores (PACKAGE + SCORE output)
- `pubs-index.json` — slim browser index, ~12.6 MB (SCORE output). Just the fields the SPA needs at startup for list, search, sort, filter.
- `pub/{slug}.json` — full per-pub record + 10-nearest array, ~3 KB each, 38k files (SCORE output). Single source of truth for pub data; fetched by the `/pub/[slug]` Pages Function and the SPA on pub selection.

## Legacy v1 Scripts (scripts/)

Kept for reference. Not used by the v2 pipeline:
1. `merge_pubs.py` — OSM .pbf → `data/pubs_merged.json`
2. `download_inspire.py` — HM Land Registry → `data/inspire/*.gml`
3. `build_inspire_gpkg.py` — INSPIRE GMLs → `data/inspire.gpkg`
4. `build_gpkg.py` — OSM .pbf → `data/buildings.gpkg`
5. `measure_heights.py` — LiDAR DSM/DTM → building heights
6. `match_plots.py` — INSPIRE plots + buildings → outdoor areas
7. `compute_horizons.py` — terrain horizon profiles
8. `generate_tiles.py` — GeoPackage → PMTiles archive
9. `precompute_sun.ts` — sun scoring (still called by SCORE stage)

## Conventions
- Stream large datasets to disk — never accumulate millions of items in memory
- Always write to temp files then move (don't clobber live data)
- Use `uv run` to execute scripts
- Print progress with counts and ETA for long operations
- Auto-download data sources on first run (OSM, OS Terrain 50, LiDAR, INSPIRE)
- Building heights: 90th percentile of LiDAR (DSM - DTM) within footprint
- Min height filter: 6m default (filters hedges, walls, cars)
- Height-dependent building radius: short buildings excluded if too far to shadow the pub
- Outdoor areas subtract ALL buildings from parcel, not just the pub's own building
- Horizon profiles: 1m DTM for 0-500m, OS Terrain 50 for 500-3000m, max angle wins
- Horizon distances encoded as uint8 at 12m resolution (max 3060m)
- Shadow projection uses actual building height only — no elevation difference inflation
