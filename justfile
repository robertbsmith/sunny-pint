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

# Upload pipeline data to R2 (detail chunks + building tiles).
# Run after pipeline changes — R2 is separate from the Pages deploy.
deploy-data:
    @echo "Uploading pubs-index.json to R2..."
    pnpm wrangler r2 object put sunny-pint-data/data/pubs-index.json \
        --file public/data/pubs-index.json --content-type application/json --remote
    @echo "Uploading detail chunks to R2..."
    @for f in public/data/detail/*.json; do \
        name=$$(basename "$$f"); \
        pnpm wrangler r2 object put "sunny-pint-data/data/detail/$$name" \
            --file "$$f" --content-type application/json --remote 2>/dev/null; \
    done
    @echo "  $$(ls public/data/detail/*.json 2>/dev/null | wc -l) detail chunks uploaded"
    @test -f public/data/buildings.pmtiles && \
        pnpm wrangler r2 object put sunny-pint-data/data/buildings.pmtiles \
            --file public/data/buildings.pmtiles --content-type application/octet-stream --remote || \
        echo "No buildings.pmtiles found — skipping tiles upload"
    @if [ -d public/data/og ] && [ "$$(ls public/data/og/*.jpg 2>/dev/null | wc -l)" -gt 0 ]; then \
        echo "Uploading OG cards to R2..."; \
        python3 -c "\
import os, urllib.request, json, time; \
from concurrent.futures import ThreadPoolExecutor; \
TOKEN=os.environ['CLOUDFLARE_API_TOKEN']; \
ACCOUNT=os.environ.get('CF_ACCOUNT_ID','a1f3acf0ef2a2839f9d87d84da3ac117'); \
og_dir='public/data/og'; \
files=[f for f in os.listdir(og_dir) if f.endswith('.jpg')]; \
print(f'  {len(files)} OG cards to upload'); \
t0=time.time(); done=0; \
def upload(f): \
    global done; \
    key=f'og/{f}'; \
    url=f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets/sunny-pint-data/objects/{key}'; \
    data=open(f'{og_dir}/{f}','rb').read(); \
    req=urllib.request.Request(url,data=data,method='PUT'); \
    req.add_header('Authorization',f'Bearer {TOKEN}'); \
    req.add_header('Content-Type','image/jpeg'); \
    urllib.request.urlopen(req,timeout=30); \
    done+=1; \
    if done%500==0: print(f'  {done}/{len(files)}',flush=True); \
with ThreadPoolExecutor(max_workers=16) as ex: list(ex.map(upload,files)); \
print(f'  {done} OG cards uploaded in {time.time()-t0:.0f}s')"; \
    else echo "No OG cards found — skipping"; fi
    @echo "R2 upload complete"

# Full deploy: build SPA + upload data to R2.
# Code deploys via GitHub push → Cloudflare Pages auto-build.
deploy: release deploy-data
    @echo "dist/ ready for Pages deploy. Push to GitHub to trigger build."

# ── Data Pipeline ─────────────────────────────────────────────────────

# Run full pipeline: pubs → inspire → buildings → heights → horizons → plots → tiles → sunny ratings
pipeline: merge-pubs download-inspire build-inspire-gpkg build-gpkg measure-heights match-plots compute-horizons generate-tiles precompute-sun

# Full UK rollout: assumes the slow upstream pipeline (build-gpkg, measure-
# heights, build-inspire-gpkg, generate-tiles for area=uk) has already been
# run. Runs the FAST steps that depend on the latest source data and
# produces a deployable dist/ for the whole UK in one command.
#
# Usage:
#   just uk
#
# After it finishes:
#   git add public/data/pubs.json data/slug_lock.json data/lastmod_state.json
#   git commit -m "Refresh UK pub data"
#   git push    # Cloudflare auto-deploys
uk:
    uv run --project scripts python scripts/merge_pubs.py --area uk
    uv run --project scripts python scripts/match_plots.py --area uk
    pnpm tsx scripts/precompute_sun.ts
    just release

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

# Pre-render OG card images for all qualifying pubs → public/data/og/*.jpg
# Requires STADIA_API_KEY env var for map tiles. Idempotent (skips existing).
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
