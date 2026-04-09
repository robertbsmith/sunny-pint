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

# Generate static SEO landing pages from public/data/pubs.json into dist/.
# Must run AFTER `build` because it templates off the Vite-hashed dist/index.html.
# Imports from functions/_lib/render.ts so static city pages and the runtime
# per-pub Pages Function share one renderer source.
generate-pages:
    pnpm tsx scripts/generate_pages.ts

# Full release: build the SPA, then generate the SEO landing pages on top.
release: build generate-pages

# Local Cloudflare Pages dev — serves dist/ AND the per-pub Pages Function on
# http://localhost:8788, identical to production. Use this instead of
# `pnpm preview` when testing landing pages or per-pub URLs.
#
# `--ip 127.0.0.1` and `--compatibility-date` are required to avoid a
# wrangler 4.81 startup race where the HTTP layer never wires up if the
# defaults are used. Don't drop them.
dev-cf: release
    pnpm wrangler pages dev dist/ --port 8788 --ip 127.0.0.1 --compatibility-date=2026-04-09

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

# Run full pipeline: pubs → inspire → buildings → heights → horizons → plots → tiles → sunny ratings
pipeline: merge-pubs download-inspire build-inspire-gpkg build-gpkg measure-heights match-plots compute-horizons generate-tiles precompute-sun

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

# Compute Sunny Rating per pub by simulating the sun's path on the spring
# equinox and intersecting building shadows with each pub's outdoor polygon.
# Reads pubs.json + tiles, writes back the `sun` field per pub. Uses
# src/shadow.ts directly via tsx so the offline rating uses the exact same
# math as the live in-browser porthole.
precompute-sun:
    pnpm tsx scripts/precompute_sun.ts

# Download EA LiDAR DSM + DTM tiles for Norwich area
download-lidar:
    uv run --project scripts python scripts/download_lidar.py

# ── Utilities ─────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    rm -rf dist node_modules/.vite
