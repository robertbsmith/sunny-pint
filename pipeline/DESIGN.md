# Pipeline v2 Design

## Overview

Five-stage pipeline with manifest-based change detection, per-pub
idempotency, and automatic run reports. Replaces the current 9 separate
scripts with a unified orchestrator.

## Stages

```
Stage 1: EXTRACT     OSM .pbfs → pubs + buildings.gpkg
Stage 2: INDEX       INSPIRE GMLs → inspire.gpkg
Stage 3: ENRICH      LiDAR + inspire + buildings → heights, horizons, outdoor areas
Stage 4: PACKAGE     buildings.gpkg → buildings.pmtiles, assemble pubs.json
Stage 5: SCORE       pubs.json + tiles → sun scores (TypeScript, stays separate)
```

## Key improvements over v1

### 1. Single LiDAR pass (Stage 3)
Currently measure_heights and compute_horizons download the same DTM
bundles independently (~6h total). Stage 3 downloads each 5km tile
once, then in one pass:
- Samples building heights (DSM - DTM)
- Computes pub ground elevation + horizon profile (DTM)
- Matches pub to INSPIRE parcel
- Computes outdoor area (parcel - buildings)

### 2. Single OSM parse (Stage 1)
Currently merge_pubs and build_gpkg parse the .pbf independently.
Stage 1 uses one osmium handler that extracts both pubs and buildings
in a single pass over each .pbf file.

### 3. Manifest-based change detection
Each stage records a manifest of its inputs (file hashes, row counts)
and outputs. On the next run, the orchestrator compares manifests and
only re-runs stages whose inputs have changed.

```
data/pipeline_manifest.json
{
  "extract": {
    "inputs": {"england.osm.pbf": "sha256:abc...", "scotland.osm.pbf": "sha256:def..."},
    "outputs": {"pubs_count": 38060, "buildings_count": 30000000},
    "completed_at": "2026-04-10T12:00:00Z"
  },
  "index": { ... },
  "enrich": { ... },
  "package": { ... },
  "score": { ... }
}
```

### 4. Per-pub incremental enrichment
Stage 3 tracks per-pub state via a hash of the pub's source data:
```python
pub_hash = hash(osm_id, lat, lng, polygon_hash)
```
If a pub's hash matches the previous run, skip it. Only new or changed
pubs get re-enriched. This makes "weekly OSM refresh" runs process
only the ~1% of pubs that changed.

### 5. Run reports
Each run produces a JSON report:
```
data/pipeline_runs/2026-04-10T12:00:00.json
{
  "started_at": "...",
  "completed_at": "...",
  "stages": {
    "extract": {"status": "skipped", "reason": "inputs unchanged"},
    "enrich": {"status": "completed", "duration_s": 3600,
               "pubs_processed": 150, "pubs_skipped": 37910,
               "buildings_heighted": 500, "bundles_downloaded": 12},
    ...
  },
  "summary": "Incremental run: 150 new pubs enriched, 37910 skipped"
}
```

## Stage details

### Stage 1: EXTRACT
Input: data/*-latest.osm.pbf
Output: data/pubs_extracted.json, data/buildings.gpkg

Single osmium pass per .pbf extracts both amenity=pub and building=*.
Buildings go directly into GPKG via streaming fiona write.
Pubs go into a JSON list with full OSM tags.

Append mode: if buildings.gpkg exists and a new .pbf is added (tracked
via .ingested marker), only parse the new .pbf.

Change detection: hash of each .pbf file. If unchanged, skip entirely.

### Stage 2: INDEX
Input: data/inspire/*.gml (downloaded by download_inspire.py)
Output: data/inspire.gpkg

Unchanged from v1. build_inspire_gpkg.py already works well.
Change detection: count of .gml files + total size. If unchanged, skip.

### Stage 3: ENRICH
Input: pubs_extracted.json, buildings.gpkg, inspire.gpkg, LiDAR API
Output: data/pubs_enriched.json (all fields except sun), buildings.gpkg (heights baked in)

The big merged step. Architecture:

1. Load pubs, compute per-pub hashes, identify which need work.
2. Load INSPIRE parcel STRtree (one-time, ~40 min for 24M parcels).
3. Discover DTM+DSM bundles from Defra catalogue API.
4. For each 5km tile (parallel, 8 workers):
   a. Download DTM + DSM bundles
   b. For each building in tile: sample height (DSM-DTM), bake into GPKG
   c. For each pub in tile:
      - Ground elevation from DTM
      - Horizon profile (36-azimuth ray cast on DTM)
      - Match to nearest INSPIRE parcel (query parcel STRtree)
      - Compute outdoor area (parcel - nearby buildings)
   d. Return all results
5. Main thread: write heights to GPKG, write pub enrichments to JSON.
6. Incremental save every 5 min.

Per-pub hash check: if a pub's hash matches the previous run AND all
its fields (elev, horizon, outdoor, local_authority) are already set,
skip it entirely. Only download bundles that contain at least one
un-enriched pub.

### Stage 4: PACKAGE
Input: pubs_enriched.json, buildings.gpkg
Output: pubs.json, pubs-index.json, detail/*.json, buildings.pmtiles

1. Derive town/country from OSM addr tags + local authority fallback.
2. Generate stable slugs (locked via data/slug_lock.json).
3. Export buildings near pubs to GeoJSON → tippecanoe → buildings.pmtiles.
4. Write full pubs.json (local pipeline use + precompute_sun input).
5. Write slim pubs-index.json (browser startup, ~1.6 MB gzip).
6. Write detail chunks (0.1° geographic grid, per-pub heavy fields).

### Stage 5: SCORE
Input: public/data/pubs.json, public/data/buildings.pmtiles
Output: public/data/pubs.json (with sun field), regenerated index + detail chunks

Stays as TypeScript (precompute_sun.ts) for shadow.ts source-of-truth.
Child process parallelism (12 workers). After scoring, regenerates
pubs-index.json and detail chunks so they include sun data.

### Independent: HORIZON
Input: pubs_enriched.json, OS Terrain 50
Output: pubs_enriched.json (horizon + horizon_dist fields updated)

Recomputes horizon profiles without re-running heights or parcels.
Uses OS Terrain 50 (50m DTM, 155 MB for all GB, auto-downloaded)
for long-range rays (500-3000m), merged with existing 1m DTM horizons
(0-500m). Takes max angle per azimuth from both sources. Also stores
ridge distance (uint8 at 12m resolution) for terrain shadow edge
rendering in the porthole.

Run independently: `uv run python pipeline/stages/horizon.py --area uk`

## Orchestrator

```
pipeline/run.py --area uk [--stage extract,enrich] [--force] [--dry-run]

Options:
  --area       Area filter (norwich, uk, etc.)
  --stage      Run only specific stages (comma-separated)
  --force      Ignore manifest, re-run everything
  --dry-run    Show what would run without running it
```

The orchestrator:
1. Loads the manifest from data/pipeline_manifest.json
2. For each stage in order, checks if inputs changed
3. Runs stages that need it, skips others
4. Updates the manifest after each stage
5. Writes a run report to data/pipeline_runs/

## File layout

```
pipeline/
  __init__.py
  run.py              Orchestrator CLI entry point
  manifest.py         Input hashing + change detection
  report.py           Run report generation
  stages/
    __init__.py
    extract.py        Stage 1: OSM → pubs + buildings
    index.py          Stage 2: INSPIRE → parcels
    enrich.py         Stage 3: LiDAR + parcels → all enrichments
    package.py        Stage 4: town/country/slug + tiles + index/chunks
    score.py          Stage 5: sun scoring + regenerate splits
    horizon.py        Independent: horizon recompute with OS Terrain 50
  utils/
    __init__.py
    bundles.py        Shared Defra bundle download/decode
    terrain50.py      OS Terrain 50 loader (50m DTM, all GB)
    download.py       Auto-download OSM extracts + OS Terrain 50
    gpkg.py           GeoPackage helpers
    grid.py           OS grid label encoding/decoding
    progress.py       Progress tracking + JSON writer
```

## Lessons learned from first UK run

### v1→v2 migration
- Seed `pubs_enriched.json` from v1's `pubs.json` before first v2 run
- Pub IDs use the `id` field (e.g. `node_12345`), NOT `osm_id`
- v1's `pubs_merged.json` lacks outdoor/slug/town — those are only in `pubs.json`
- `_enrich_hash` doesn't exist in v1 data — skip logic must handle missing hashes

### Manifest gotchas
- Manifest keys by stage:area (e.g. `enrich:UK`) — different areas don't skip each other
- A broken run that completes with 0 work still records in manifest → must clear stale entries
- Use `--force` sparingly — prefer deleting the specific manifest entry

### Skip logic
- "Pub is enriched" = has ANY enrichment field (elev, horizon, outdoor, local_authority)
- A pub written to enriched output during a killed run exists by ID but has no data — must check fields, not just ID presence
- English pubs processed by v1 should skip even without `_enrich_hash`

### LiDAR routing
- `fetch_ndsm` must route by OSGB coordinates BEFORE trying EA WCS
- Scottish coords → JNCC WCS directly (northing >540k)
- Welsh coords → NRW COG directly (easting <340k)
- EA WCS returns 500 for non-England coords — ~8s wasted per failed request

### Data dependencies
- match_plots writes pubs.json with slugs + towns (needed for SEO pages)
- precompute_sun writes sun scores back to the same pubs.json
- Split files (index + detail chunks) must be generated AFTER precompute_sun
- OG card pre-render needs both sun scores AND building tiles

## Migration

Pipeline v2 reads/writes the same data files as v1:
- data/buildings.gpkg
- data/pubs_merged.json (read by v2 as input)
- data/pubs_enriched.json (v2's output — carries forward enrichments)
- data/inspire.gpkg + data/scotland_parcels.gpkg
- public/data/pubs.json (final output with all fields)
- public/data/buildings.pmtiles

v2 is now the primary pipeline. v1 scripts remain in scripts/ for
reference but are not called by the orchestrator (except precompute_sun.ts
which SCORE shells out to, and generate_tiles.py which PACKAGE calls).

## Terrain shadow rendering

### Problem
Building shadow projection assumes a flat plane. In valleys, buildings
on hillsides appeared as 40-50m towers because elevation difference was
added to their height. In reality, their shadows fall on the slope.

### Solution
1. Building shadows use actual roof height only (no elevation inflation).
2. Terrain occlusion handled by horizon profile + ridge distance.
3. Porthole renders a terrain shadow half-plane that sweeps across as
   the sun rises/sets past the terrain horizon.

### Data
- `horizon`: 36 uint8 values (angle × 10, max 25.5°) — existing
- `horizon_dist`: 36 uint8 values (distance ÷ 12, max 3060m) — new
- Close range (0-500m): 1m Defra DTM via bundle downloads
- Long range (500-3000m): OS Terrain 50 (50m grid, all GB, 155 MB)
- Merged per azimuth: whichever source has the higher angle wins

### Shadow edge formula
```
edge_distance = D × (1 - tan(θ) / tan(α))
```
Where D = ridge distance, θ = horizon angle, α = sun altitude.
Negative = pub fully in terrain shadow. Infinity = no terrain.

Interpolation: compute edge from both adjacent azimuths independently,
then lerp the edge positions (not the raw distances).

## Estimated times (actual, measured)

| Scenario | Time |
|----------|------|
| Full UK first run (v1) | ~12h (9h heights + 3h horizons) |
| Full UK enrich (v2, England done) | ~2h (Scotland+Wales only) |
| Horizon recompute (OS Terrain 50) | ~50s (38k pubs, no LiDAR download) |
| PACKAGE (assemble outputs) | ~10s |
| precompute_sun (12 workers) | ~5 min |
| R2 deploy (31k files, boto3) | ~7 min at 75/s |
| OG card pre-render (8 workers) | ~18 min |
| Nothing changed | ~7s (manifest skip) |
