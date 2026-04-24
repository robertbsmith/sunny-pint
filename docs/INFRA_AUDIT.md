# Infrastructure Audit & Action Plan

Snapshot as of April 2026. Tracks findings from a full Cloudflare / Pages / R2
audit and the corresponding action items. Check back here before making infra
changes — some items are sequenced (e.g. HSTS must come after `always_use_https`
has been stable for a week).

## Headline findings

- **Googlebot 503 storm.** ~2,000 × 503 responses per day on `/pub/*`, all
  from Googlebot during peak evening crawl windows. Cause: Pages Function
  cold starts can't handle parsing a 9 MB R2 index + building a 38k-entry map
  fast enough when thousands of unique URLs are probed simultaneously.
- **R2 `pubs-index.json` served uncached.** ~5,700 fetches per day of the
  9 MB index = roughly 12 GB/day of bandwidth from a single file. R2 put
  objects had no `Cache-Control` header, so every fetch bypassed the Cloudflare
  edge cache.
- **52 soft 404s in Google Search Console.** All Scottish/Welsh city pages
  that fall below the 8-qualifying-pub threshold. Root cause is a data gap:
  Scotland has sun scores on 0.6% of pubs, Wales 10%, England 84%. Missing
  outdoor-area polygons (from cadastral parcel data) prevent sun scoring.
- **Cache hit rate ≈ 0% at audit start.** `_headers` only covered PMTiles;
  JS/CSS/images were served with Cloudflare Pages' default short TTL.
- **Request volume is ~94% bots.** 93.7% of daily HTTP requests are HTTP/1.1,
  which modern browsers no longer use — all that traffic is scrapers,
  crawlers, and SEO tools. Real-user traffic is closer to 65 RUM visits/week,
  mostly UK mobile, split between direct (bookmarks, shared links) and
  Google search.
- **Search presence is growing slowly but correctly.** Brand terms rank
  position 1–3; 29k pages sit in Google's "discovered — currently not indexed"
  queue and will be crawled over weeks. Crawl budget is being wasted on
  duplicated JSON fetches of `pubs-index.json` from `data.sunny-pint.co.uk`.

## Real user performance (7 days, ~65 visits)

| Metric | P50 | P75 | P95 |
|---|---|---|---|
| First Contentful Paint | 517 ms | 844 ms | 4.8 s |
| Page render | 356 ms | 576 ms | — |
| Page load (total) | 949 ms | 1.5 s | 4.4 s |
| Response time (origin) | 2 s | 7.6 s | 41 s |

P50 numbers are fine. P95 is dragged out by the Function timeout cases; fixing
the 503 cause also fixes the P95 tail.

---

## Action plan

### Completed

- [x] **Static asset `Cache-Control` headers** — `public/_headers` now covers
      Vite hashed assets (`immutable`, 1 year), icons, manifest, and PMTiles.
- [x] **R2 upload `CacheControl` parameter** — `pipeline/deploy_data.py` sets
      per-file cache headers (JSON: 1h browser / 24h edge; PMTiles: 7d;
      OG images: 1d / 7d).
- [x] **Pages Function HEAD handler** — `functions/pub/[slug].ts` and
      `functions/og/pub/[slug].ts` now accept HEAD, and the cache key is
      normalised to GET so HEAD probes reuse the GET cache entry.
- [x] **Devcontainer port-forwarding for Wrangler OAuth** — port 8976 added.
- [x] **Removed duplicate Web Analytics beacon** — Cloudflare Pages already
      auto-injects it.
- [x] **`always_use_https` on** — zone setting.
- [x] **Minimum TLS 1.2** — zone + R2 custom domain.
- [x] **`www.sunny-pint.co.uk` CNAME + redirect rule** — 301 to apex,
      preserving path + query.
- [x] **DMARC record** — `v=DMARC1; p=none` with reports forwarded via
      existing `hello@` alias.
- [x] **`robots.txt` on data subdomain.** Uploaded `Disallow: /` to the R2
      bucket root so `data.sunny-pint.co.uk/robots.txt` tells crawlers to
      ignore the raw JSON/PMTiles. `pipeline/deploy_data.py` re-uploads it
      on every deploy.
- [x] **Cloudflare Observatory (Beta) enabled.** Real-browser Lighthouse runs
      scheduled from Cloudflare's edge; lab performance trends now tracked
      over time in the dashboard.
- [x] **Re-uploaded 31k R2 objects with Cache-Control headers.** Full
      idempotent re-put of every data file via `pipeline/deploy_data.py`.
      ~7 minutes at 70 files/s (16-worker ThreadPoolExecutor, per-thread
      boto3 connection pooling). `pubs-index.json` now serves with
      `cache-control: public, max-age=3600, s-maxage=86400` — edge-caching
      confirmed. Expected ~10 GB/day bandwidth drop as edge caches warm.
- [x] **Submitted the 6 child sitemaps to GSC.** All show Success with
      correct URL counts. Per-segment indexing stats will populate over
      the next 2–7 days as Google re-checks each child.

- [x] **Deployed commits `8a28c1f` + `fe2b33a`.** Cloudflare Pages build
      triggered automatically. New static asset cache headers, sitemap
      index + 6 children, Function HEAD handler, BarOrPub schema,
      detail-chunk 404 fix, and Ko-fi UTM all ship in this deploy.

- [x] **Fixed detail-chunk 404 bug.** `src/main.ts` and `functions/og/pub/[slug].ts`
      were constructing cell keys via JS number-to-string coercion, which
      drops trailing zeros (`-3.0` → `"-3"`). The pipeline writes filenames
      with Python's float formatting that preserves `.0`, so every pub in
      a whole-degree cell (≈19% of pubs) silently failed to load detail
      data (outdoor polygon, horizon, elevation). Fixed with `.toFixed(1)`.
      Was the source of all 191 daily 404s on `data.sunny-pint.co.uk`, not
      "empty cells" as originally assumed.

- [x] **UTM-tagged Ko-fi link.** `utm_source=sunny-pint&utm_medium=web&utm_campaign=site-button`
      appended to the Ko-fi href in `index.html` so Ko-fi's referral report
      attributes tips to the site. No cookies, no banner implications —
      UTMs are plain URL parameters processed by the destination.

- [x] **PageSpeed Insights baseline captured.** Ran against homepage + pub
      page URLs to get lab Core Web Vitals and specific optimisation
      suggestions not surfaced by RUM.

- [x] **BarOrPub schema.org structured data.** Pub pages now emit a
      JSON-LD `BarOrPub` block with `name`, `url`, `geo`, `address` (full
      postal with street, locality, region, postcode, country), `telephone`,
      `image` (OG card), `brand`, and `openingHours` (OSM → schema.org
      converter in `functions/_lib/render.ts`). City pages' embedded
      `ItemList` pubs get the same rich data. `additionalProperty` carries
      the Sunny Rating (custom metric) — deliberately NOT in
      `aggregateRating` because Google reserves that for user-submitted
      reviews and penalises misuse. Needed `phone`, `addr_street`,
      `addr_housenumber`, `addr_postcode`, `website`, `brand`, `brewery`
      added to the slim `pubs-index.json` so the Pages Function has this
      data without a second R2 fetch; index grew 1.6 MB gzipped → 2.9 MB
      gzipped (edge-cached, minor bandwidth impact).

- [x] **Sitemap index + 6 child sitemaps.** `scripts/generate_pages.ts` now
      emits a sitemap index at `/sitemap.xml` pointing to `sitemap-core.xml`
      (~60 URLs), `sitemap-cities.xml` (~2k), `sitemap-pubs-en-a-m.xml`
      (~16k), `sitemap-pubs-en-n-z.xml` (~13k), `sitemap-pubs-scotland.xml`,
      `sitemap-pubs-wales.xml`. Each child's `<lastmod>` is the max lastmod
      of URLs inside it. All children stay under the 30k practitioner sweet
      spot. After deploy, submit the 6 child sitemaps individually in GSC
      (Search Console → Sitemaps) for per-segment indexing visibility — the
      existing `sitemap.xml` submission keeps working (Google auto-detects
      the index).

### Outstanding — important

- [x] **Fix Scotland/Wales outdoor-area coverage (pipeline).** Shipped.
      Root cause was a `NameError` on `gpkg_path` (Phase 1 param) vs
      `GPKG_PATH` (module constant) in `pipeline/stages/enrich.py` line 984,
      which had silently broken Phase 2 outdoor polygons for every pub
      without a Defra LiDAR bundle (i.e. all of Scotland + most of Wales).
      Fix + Phase 2 routing widening + skip-LiDAR optimisation brought
      scored pubs from 28,762 → 32,158. Scotland 97.1% scored (1,587
      pubs), Wales 87.6% (2,041). 1,635 city pages now index (up from
      599), sitemap 35,672 URLs (up from 31,048).
- [ ] **Enable HSTS.** Stable-deploy window passed. Max-age 6 months,
      `includeSubDomains`, no preload. Preload decision deferred 3–6 months.

### Deep review — April 2026

Multi-agent Opus audit (src/ + pipeline/ + functions/ + infra). Landed as
code fixes; HSTS still deferred per user call.

- [x] **Terrain shadow half-plane geometry** — sign + perpendicular bug in
      `src/circle.ts:343-359` drew the half-plane on the wrong side of the
      edge and degenerated the quad at all non-cardinal sun angles. Fixed.
- [x] **Timezone consumer chain** — `ukTimeMins` set `state.timeMins`
      correctly but every consumer then did `d.setHours(0); d.setMinutes()`
      using local time, so non-UK visitors saw the sun in the wrong place.
      New `src/time.ts` with `ukDateAt()` used everywhere.
- [x] **OG Function cache invalidation** — `functions/og/pub/[slug].ts`
      never SHA-keyed `cachedIndex` or the edge cache, so new scores took
      ≤7 days to appear in social cards per POP. Mirrored the pub function
      pattern with `CF_PAGES_COMMIT_SHA` on both caches.
- [x] **OG Function cachedIndex mutation** — in-place `Object.assign`
      poisoned the warm index across requests. Replaced with spread-copy.
- [x] **OG Function WASM init race** — `initWasm` isn't idempotent;
      promise-guarded.
- [x] **Mapbox URL corruption** — dead `STADIA_API_KEY` code path appended
      `?api_key=` to a URL that already had `?access_token=`, producing an
      invalid double-query. Removed the Stadia branch + all legacy refs.
- [x] **Schema.org `sameAs` for pub website** — one-line add in render.ts;
      biggest E-E-A-T signal Google uses to merge us with the pub's
      Knowledge Graph entry.
- [x] **`_outdoor_hash` skip stamp honoured** — TS worker now receives only
      pubs that actually need rescoring, stamps the hash onto emitted
      metrics, so identical geometry produces identical scores and no
      false lastmod churn. Shared `SunMetrics` type from `src/types.ts`.
- [x] **Horizon DTM nodata silently sea-level** — `enrich.py:342` rewrote
      nodata to 0, and horizon rays saw fake flat terrain through nodata
      patches. Now NaN-masked.
- [x] **Longitude-metre at Scottish latitudes** — `tiles.py` used the
      equator constant for lng bbox; at 57°N that's 40% too narrow.
      Cosine-corrected.
- [x] **Non-atomic writes across PACKAGE/SCORE** — crashes mid-write
      could truncate `pubs.json` / `pubs-index.json` or empty `detail/`.
      All writes now tmp+rename; detail/ staged then swapped.
- [x] **`slug_lock.json` corruption silent reset** — swallowed
      `JSONDecodeError` would re-slug every pub and break every indexed
      URL. Now raises.
- [x] **v2 EXTRACT id shape + missing tags** — emitted `osm_id` only (none
      of `id`, `brand`, `brewery`, `real_ale`, `food`, `wheelchair`,
      `dog`, `wifi`). Would destroy PACKAGE dedup + empty all those
      columns on a fresh run. Fixed to emit both `id` (`{type}_{osm_id}`)
      and the full v1 tag list.
- [x] **Manifest outputs-exist check** — `stage_needs_run` now verifies
      primary output files exist before skipping, so an accidental `rm`
      doesn't silently leave a "done" manifest with no outputs on disk.
- [x] **`--dry-run` area-scoped manifest lookup** — previously always
      reported "never run"; now matches a real run.
- [x] **Pipeline report saved on failure** — try/finally around the
      stages loop; a crashed multi-hour ENRICH now writes its partial
      report to `data/pipeline_runs/`.
- [x] **Python CI lint** — added ruff to CI. Catches the class of bug
      that broke Scotland/Wales for weeks (undefined name).
- [x] **`pipeline/ts` + `email-worker` typecheck in CI** — `tsconfig.json`
      now includes `pipeline/ts`; email-worker deploy runs `tsc --noEmit`.
- [x] **Node / `@types/node` alignment** — Node 24 in all three CIs and
      devcontainer; `@types/node@^24` matches the runtime.
- [x] **Deleted duplicate legacy scripts** — `scripts/precompute_sun*.ts`
      and `scripts/deploy_data.py` were byte-dupes of the
      pipeline-canonical copies. Justfile repointed.
- [x] **Doc drift** — README / DATA_PIPELINE / PROJECT_PLAN pub count
      33k → 38k.

### Outstanding — nice to have

- [x] **Validate the BarOrPub structured data.** Passed Rich Results
      Tester on all four URLs below. Only warnings were `priceRange`
      and `servesCuisine` — both "recommended, not required" fields
      with no reliable OSM source; accepted as omitted. Spot-checked via:
      - `https://sunny-pint.co.uk/pub/cardiff-bay-tavern-cardiff/` — full
        coverage (tel + hours + brand + address) + Welsh locality.
      - `https://sunny-pint.co.uk/pub/the-mayflower-london/` — tel +
        hours + brand + address, London chain pub.
      - `https://sunny-pint.co.uk/pub/the-osnaburg-forfar/` — Scottish
        pub with tel + hours + address (no brand).
      - `https://sunny-pint.co.uk/pub/the-eagle-cambridge/` — famous
        pub with hours + brand + address (no phone).
      Confirm Google parses `BarOrPub` (address, telephone, geo,
      openingHours, image). The OSM → schema.org opening-hours converter
      drops rules it can't reliably express; spot-check that rejected
      rules are only the complex cases (PH, conditionals) and not common
      patterns.

---

## Expected impact after the urgent items ship

| Metric | Before | After |
|---|---|---|
| Daily bandwidth | ~10 GB | ~1 GB |
| 5xx error rate | ~8% | <1% |
| Cache hit rate | ~0% | 80%+ |
| R2 reads on `pubs-index.json` | ~5,700/day | ~100/day |
| Pub-page P95 response time | 41 s | ~2 s |
