# Data Pipeline

How to obtain, process, and serve the data Sunny Pint needs.

## Overview

```
OSM .pbf ──→ merge_pubs ──→ pubs_merged.json
                                  │
OSM .pbf ──→ build_gpkg ──→ buildings.gpkg ──→ measure_heights ──→ (heights added)
                                  │                                       │
INSPIRE GMLs ──→ build_inspire_gpkg ──→ inspire.gpkg                      │
                                  │                                       │
                            match_plots ──────────→ public/data/pubs.json  │
                                                          │               │
                            compute_horizons ──────────→ (horizons added) │
                                                          │               │
                            generate_tiles ←──────────────┼───────────────┘
                                  │                       │
                            tiles/*.pbf                   │
                                  │                       │
                            precompute_sun ──→ (sun ratings added to pubs.json)
```

## Quick Start (Full UK Pipeline)

```bash
# 1. Download source data
curl -L -o data/england-latest.osm.pbf \
  https://download.geofabrik.de/europe/united-kingdom/england-latest.osm.pbf

# 2. Run the full pipeline
just pipeline area=uk

# Or step by step:
just merge-pubs area=uk        # Extract pubs from OSM
just download-inspire           # Download all INSPIRE plot data (England & Wales)
just build-inspire-gpkg         # Index GML files into spatial GeoPackage
just build-gpkg area=uk         # Extract buildings from .pbf → GeoPackage
just measure-heights area=uk    # Sample LiDAR heights (auto-downloads tiles)
just match-plots area=uk        # Match pubs to plots, compute outdoor areas
just compute-horizons area=uk   # Terrain horizon profiles from DTM
just generate-tiles area=uk     # Create individual .pbf tile files
just precompute-sun             # Simulate equinox sun → Sunny Rating per pub
```

For a single area (faster for development):
```bash
just pipeline area=norwich
```

Available areas: `norwich`, `bristol`, `london`, `edinburgh`, `cardiff`, `uk`

## Step 1: Extract Pubs from OSM

**Script**: `scripts/merge_pubs.py`
**Input**: `data/england-latest.osm.pbf`
**Output**: `data/pubs_merged.json`

Extracts all `amenity=pub` nodes and ways from the .pbf file. Each pub gets:
- Name, lat/lng, building polygon (if mapped as a way)
- Beer garden, outdoor seating, opening hours tags

UK-wide: ~33k pubs.

## Step 2: Download INSPIRE Plot Data (England & Wales)

**Script**: `scripts/download_inspire.py`
**Output**: `data/inspire/*.gml` (318 files, ~28 GB)

Downloads cadastral parcel boundaries from HM Land Registry for all local authorities in England and Wales. Used to compute pub outdoor areas (plot minus buildings = garden).

Files are cached — re-running skips already downloaded authorities.

## Step 3: Build INSPIRE GeoPackage

**Script**: `scripts/build_inspire_gpkg.py`
**Input**: `data/inspire/*.gml`
**Output**: `data/inspire.gpkg`

Indexes the downloaded INSPIRE GML files into a single GeoPackage with a spatial R-tree index. This makes spatial queries fast during match_plots instead of scanning raw GML files.

## Step 4: Extract Buildings → GeoPackage

**Script**: `scripts/build_gpkg.py`
**Input**: `data/england-latest.osm.pbf`
**Output**: `data/buildings.gpkg`

Extracts all `building=*` ways from the .pbf and streams them into a GeoPackage (SQLite + R-tree spatial index). Streaming avoids OOM for large datasets.

UK-wide: ~13.4M buildings.

## Step 5: Measure Building Heights from LiDAR

**Script**: `scripts/measure_heights.py`
**Input**: `data/buildings.gpkg` + EA LiDAR tiles (auto-downloaded)
**Output**: Heights written back to `buildings.gpkg`

For each building:
1. Downloads EA LiDAR DSM + DTM tiles covering the building (cached)
2. Samples pixel values within the building footprint
3. Height = 90th percentile of (DSM - DTM) values
4. Buildings shorter than 6m are flagged (hedges, walls, sheds)

**Why 90th percentile**: Captures ridge height of pitched roofs while ignoring chimney/antenna outliers.

**LiDAR sources**:
- England: EA WCS (`environment.data.gov.uk`)
- Scotland: JNCC WCS
- Wales: NRW COG

## Step 6: Match Plots and Compute Outdoor Areas

**Script**: `scripts/match_plots.py`
**Input**: `data/pubs_merged.json` + `data/inspire/*.gml` + `data/buildings.gpkg`
**Output**: `public/data/pubs.json`

For each pub:
1. Loads INSPIRE parcels from individual GML files, filtered to parcels near pubs (avoids loading all 22M parcels into memory)
2. Finds the cadastral parcel containing the pub
3. Subtracts ALL building footprints from the parcel (not just the pub building)
4. The remaining polygon is the outdoor area (garden/beer garden)
5. Supports holes in the outdoor polygon (buildings fully enclosed in the plot)

## Step 7: Compute Terrain Horizons

**Script**: `scripts/compute_horizons.py`
**Input**: DTM tiles + `public/data/pubs.json`
**Output**: Horizon profiles added to pubs

For each pub, samples the surrounding DTM to compute a terrain horizon profile — the elevation angle of the terrain in each compass direction. Used to detect when hills would block the sun even without buildings present.

## Step 8: Generate Vector Tile Files

**Script**: `scripts/generate_tiles.py`
**Input**: `public/data/pubs.json` + `data/buildings.gpkg`
**Output**: `public/data/tiles/{x}-{y}.pbf`

Creates individual z14 vector tile files for static serving:
1. Filters buildings to those near pubs using **height-dependent radius** — short buildings that can't cast shadows far enough are excluded
2. Runs tippecanoe to create a temporary PMTiles archive at z14
3. Extracts individual tiles as `.pbf` files

**Height-dependent filtering**: Instead of a flat 300m radius, each building's maximum shadow reach is calculated from its height and the minimum useful sun angle (3°). A 6m shed 200m away is excluded because its shadow can't reach the pub. This reduces tile count by ~30%.

**Output stats** (Norwich): 56 tiles, 0.5 MB total, largest 111 KB.

## Step 9: Precompute Sunny Ratings

**Script**: `scripts/precompute_sun.ts`
**Input**: `public/data/pubs.json` + `public/data/tiles/*.pbf`
**Output**: `sun` field added to each pub in `public/data/pubs.json`

Simulates the sun's path on the spring equinox (equal day/night) for each pub:
1. Samples sun position at every half-hour of daylight
2. Casts geometric shadows from all nearby buildings using the same `shadow.ts` code as the live porthole
3. Computes what fraction of the outdoor area is in direct sun at each time step
4. Averages those fractions to produce a score from 0–100

The result is a `sun` field per pub containing the score, a human-readable label (e.g. "Sun trap", "Partly shaded"), and the best window of sunshine.

## Coordinate Systems

| System | CRS | Used by |
|--------|-----|---------|
| WGS84 | EPSG:4326 | OSM data, app runtime, GeoJSON |
| OSGB National Grid | EPSG:27700 | EA LiDAR, Land Registry INSPIRE |

All runtime data is in WGS84. OSGB is only used during pipeline processing.

## Data Sources

| Source | What | License | How to obtain |
|--------|------|---------|---------------|
| OpenStreetMap | Pubs, buildings, roads | ODbL | [Geofabrik .pbf](https://download.geofabrik.de/europe/united-kingdom/england.html) |
| EA LiDAR | Building heights (DSM/DTM) | OGL v3 | Auto-downloaded via WCS |
| HM Land Registry INSPIRE | Property plot boundaries | OGL v3 | `scripts/download_inspire.py` |
| Open-Meteo | Cloud cover / weather | CC BY 4.0 | API (no key needed) |
| CARTO | Base map tiles | CC BY 3.0 | CDN tiles |
