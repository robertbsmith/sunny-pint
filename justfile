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

# Run full pipeline: pubs → inspire → buildings → heights → horizons → plots → tiles
pipeline: merge-pubs download-inspire build-inspire-gpkg build-gpkg measure-heights match-plots compute-horizons generate-tiles

# Extract pubs from OSM
merge-pubs:
    uv run --project scripts python scripts/merge_pubs.py --area {{area}}

# Download all INSPIRE Land Registry plot data (England & Wales)
download-inspire:
    uv run --project scripts python scripts/download_inspire.py

# Convert downloaded INSPIRE GML files into one indexed GeoPackage
build-inspire-gpkg:
    uv run --project scripts python scripts/build_inspire_gpkg.py

# Compute terrain horizon profiles for pubs (needs DTM from measure-heights)
compute-horizons:
    uv run --project scripts python scripts/compute_horizons.py --area {{area}}

# Match pubs to Land Registry plots, compute outdoor areas → public/data/pubs.json
match-plots:
    uv run --project scripts python scripts/match_plots.py --area {{area}}

# Extract buildings + roads from England .osm.pbf → GeoPackage
build-gpkg:
    uv run --project scripts python scripts/build_gpkg.py --area {{area}}

# Sample building heights from LiDAR DSM/DTM
measure-heights:
    uv run --project scripts python scripts/measure_heights.py --area {{area}}

# Generate individual vector tile files from buildings with heights
generate-tiles:
    uv run --project scripts python scripts/generate_tiles.py --area {{area}}

# Download EA LiDAR DSM + DTM tiles for Norwich area
download-lidar:
    uv run --project scripts python scripts/download_lidar.py

# ── Utilities ─────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    rm -rf dist node_modules/.vite
