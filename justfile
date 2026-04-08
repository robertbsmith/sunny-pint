# SunPub task runner

set dotenv-load

# Default area for pipeline commands (norwich, bristol, london, edinburgh, cardiff, uk)
area := "norwich"

# ── Frontend ──────────────────────────────────────────────────────────

# Start Vite dev server
dev:
    pnpm dev

# Production build
build:
    pnpm build

# Preview production build
preview:
    pnpm preview

# Lint + format check
lint:
    pnpm lint

# Auto-fix lint + format
fix:
    pnpm fix

# Type check
typecheck:
    pnpm typecheck

# All quality checks
ci: typecheck lint build

# ── Data Pipeline ─────────────────────────────────────────────────────

# Run full pipeline: pubs → buildings → heights → PMTiles
pipeline: merge-pubs build-gpkg measure-heights generate-pmtiles

# Merge pub data from FSA + VOA + OSM
merge-pubs:
    uv run python scripts/merge_pubs.py --area {{area}}

# Fetch pub data from OSM Overpass API (Norwich only, legacy)
fetch-pubs:
    uv run python scripts/fetch_pubs.py

# Extract buildings + roads from England .osm.pbf → GeoPackage
build-gpkg:
    uv run python scripts/build_gpkg.py --area {{area}}

# Sample building heights from LiDAR DSM/DTM
measure-heights:
    uv run python scripts/measure_heights.py --area {{area}}

# Generate PMTiles from buildings with heights
generate-pmtiles:
    uv run python scripts/generate_pmtiles.py --area {{area}}

# Download EA LiDAR DSM + DTM tiles for Norwich area
download-lidar:
    uv run python scripts/download_lidar.py

# ── Utilities ─────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    rm -rf dist node_modules/.vite
