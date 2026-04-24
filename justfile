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

# Full release: build the SPA, generate SEO landing pages, strip data
# files that are served from R2 (pubs.json, detail chunks, tiles).
# pubs-index.json STAYS in dist/ (slim, ~5 MB, loaded by the SPA + Functions).
release: build generate-pages
    rm -rf dist/data/
    @echo "Stripped all data from dist/ (served from R2)"

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

# Upload pipeline data to R2 via S3 API (boto3, connection-pooled).
# Requires: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY env vars.
deploy-data:
    uv run --project pipeline python pipeline/deploy_data.py

# Full deploy: build SPA + upload data to R2.
# Code deploys via GitHub push → Cloudflare Pages auto-build.
deploy: release deploy-data
    @echo "dist/ ready for Pages deploy. Push to GitHub to trigger build."

# ── Data Pipeline (v2) ────────────────────────────────────────────────

# Run full v2 pipeline. Auto-downloads OSM extracts + OS Terrain 50.
pipeline:
    uv run --project pipeline python pipeline/run.py --area {{area}}

# Recompute terrain horizons with extended 3km range (OS Terrain 50).
# No LiDAR re-download needed — runs in ~50s for 38k pubs.
horizon:
    uv run --project pipeline python pipeline/stages/horizon.py --area {{area}}

# ── Legacy v1 Scripts (archived, not used by v2) ─────────────────────

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
    pnpm tsx pipeline/ts/precompute_sun.ts

# Pre-render OG card images for all qualifying pubs → public/data/og/*.jpg
# Map tiles come from Mapbox (token embedded in src/config.ts). Idempotent
# (skips existing).
render-og:
    pnpm tsx scripts/render_og_cards.ts

# Download Scottish INSPIRE cadastral parcels from Registers of Scotland
download-inspire-scotland:
    uv run --project scripts python scripts/download_inspire_scotland.py

# Download EA LiDAR DSM + DTM tiles for Norwich area
download-lidar:
    uv run --project scripts python scripts/download_lidar.py

# ── Utilities ─────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    rm -rf dist node_modules/.vite
