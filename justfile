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

# Run full pipeline: pubs → inspire → buildings → heights → plots → tiles
pipeline: merge-pubs download-inspire build-gpkg measure-heights match-plots generate-tiles

# Extract pubs from OSM
merge-pubs:
    uv run python scripts/merge_pubs.py --area {{area}}

# Download all INSPIRE Land Registry plot data (England & Wales)
download-inspire:
    uv run python scripts/download_inspire.py

# Match pubs to Land Registry plots, compute outdoor areas → public/data/pubs.json
match-plots:
    uv run python scripts/match_plots.py --area {{area}}

# Fetch pub data from OSM Overpass API (Norwich only, legacy)
fetch-pubs:
    uv run python scripts/fetch_pubs.py

# Extract buildings + roads from England .osm.pbf → GeoPackage
build-gpkg:
    uv run python scripts/build_gpkg.py --area {{area}}

# Sample building heights from LiDAR DSM/DTM
measure-heights:
    uv run python scripts/measure_heights.py --area {{area}}

# Generate individual vector tile files from buildings with heights
generate-tiles:
    uv run python scripts/generate_tiles.py --area {{area}}

# Download EA LiDAR DSM + DTM tiles for Norwich area
download-lidar:
    uv run python scripts/download_lidar.py

# ── Utilities ─────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    rm -rf dist node_modules/.vite
