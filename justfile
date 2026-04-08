# SunPub task runner

set dotenv-load

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
pipeline: fetch-pubs build-gpkg measure-heights generate-pmtiles

# Fetch pub data from OSM Overpass API
fetch-pubs:
    uv run python scripts/fetch_pubs.py

# Extract buildings + roads from England .osm.pbf → GeoPackage
build-gpkg:
    uv run python scripts/build_gpkg.py

# Sample building heights from LiDAR DSM
measure-heights:
    uv run python scripts/measure_heights.py

# Generate PMTiles from buildings with heights
generate-pmtiles:
    uv run python scripts/generate_pmtiles.py

# Download EA LiDAR DSM tiles for Norwich area
download-lidar:
    uv run python scripts/download_lidar.py

# ── Utilities ─────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    rm -rf dist node_modules/.vite
