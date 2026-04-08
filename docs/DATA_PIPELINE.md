# Data Pipeline

How to obtain, process, and serve the data SunPub needs.

## Overview

```
OSM .pbf ──→ GeoPackage ──→ Heights ──→ PMTiles ──→ public/data/
   ↑              ↑            ↑
Geofabrik    build_gpkg.py  measure_heights.py + LiDAR DSM
```

## Step 1: Download OSM Data

```bash
# England extract from Geofabrik (~1.6GB)
curl -L -o data/england-latest.osm.pbf \
  https://download.geofabrik.de/europe/united-kingdom/england-latest.osm.pbf
```

Updated weekly. Contains all OSM features for England.

## Step 2: Extract Buildings + Roads → GeoPackage

```bash
just build-gpkg
# or: uv run python scripts/build_gpkg.py
```

Scans the .pbf, extracts `building=*` ways and `highway=*` ways within a bbox. Writes to `data/buildings.gpkg` with R-tree spatial index.

**Current bbox**: Greater Norwich `(52.55, 1.15, 52.70, 1.40)`. Change `BBOX` in the script to expand.

**Output**: ~98k buildings, ~42k roads, 33MB GeoPackage.

**Note**: Writes to a `.tmp` file then moves into place to avoid clobbering the live database.

## Step 3: Download LiDAR DSM

```bash
just download-lidar
# or: uv run python scripts/download_lidar.py
```

Downloads EA LiDAR Composite DSM 1m tiles via WCS (Web Coverage Service). Each tile is a 1km×1km GeoTIFF at 1m resolution (~4MB each).

**WCS endpoint**: `environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-last-return-dsm-1m/wcs`

**Coverage ID**: `9ba4d5ac-d596-445a-9056-dae3ddec0178__Lidar_Composite_Elevation_LZ_DSM_1m`

**CRS**: EPSG:27700 (OSGB National Grid)

**Current area**: 10km×10km around Norwich (100 tiles, ~400MB total).

The tiles are in OSGB projection. Building heights are sampled from these tiles in the next step.

## Step 4: Measure Building Heights

```bash
just measure-heights
# or: uv run python scripts/measure_heights.py
```

For each building in the GeoPackage:
1. Find the LiDAR tile(s) covering it
2. Rasterize the building footprint onto the DSM grid
3. Compute local ground level (local minimum filter, radius=11m)
4. Take the 90th percentile of DSM values within the footprint
5. Height = 90th percentile − ground level
6. Filter: buildings shorter than 6m are marked as such (hedges, sheds)

Writes height values back into the GeoPackage as a new column.

**Why 90th percentile**: Captures the ridge height of pitched roofs while ignoring chimney/antenna outliers. More accurate than max (which grabs chimneys) or median (which underestimates on peaked roofs).

## Step 5: Generate PMTiles

```bash
just generate-pmtiles
# or: uv run python scripts/generate_pmtiles.py
```

Converts the GeoPackage (with heights) into a PMTiles file for static serving.

**PMTiles**: A single file containing vector tiles with a built-in spatial index. The client makes HTTP range requests to fetch just the tiles it needs — no tile server required.

**Output**: `public/data/buildings.pmtiles`

## Step 6: Fetch Pub Data

```bash
just fetch-pubs
# or: uv run python scripts/fetch_pubs.py
```

Queries Overpass API for `amenity=pub` in Norwich. Enriches with:
- Building polygon (from OSM way geometry)
- Beer garden / outdoor seating tags
- Outdoor area (from Land Registry INSPIRE: plot minus building)

**Output**: `public/data/pubs.json`

## Land Registry INSPIRE Data

Property plot boundaries. Used to compute outdoor areas (plot minus building = garden).

```bash
# Download Norwich plots (requires session cookie)
curl -s -c cookies.txt -b cookies.txt \
  "https://use-land-property-data.service.gov.uk/datasets/inspire" -o /dev/null
curl -s -L -c cookies.txt -b cookies.txt \
  -o data/inspire/norwich.zip \
  "https://use-land-property-data.service.gov.uk/datasets/inspire/download/Norwich.zip"
```

Format: GML (EPSG:27700). The `match_plots.py` script matches pubs to their plots and computes outdoor areas.

## Coordinate Systems

- **OSM data**: WGS84 (EPSG:4326) — lat/lng
- **LiDAR DSM**: OSGB National Grid (EPSG:27700) — eastings/northings in metres
- **Land Registry**: OSGB (EPSG:27700)
- **App runtime**: Everything in WGS84

**Important**: OSGB grid north is rotated ~2.6° from true north at Norwich. Any raster computed in OSGB must be reprojected to WGS84 before overlaying on a map. Geometric shadow projection avoids this by working in WGS84 directly.
