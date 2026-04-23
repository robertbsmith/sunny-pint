# Architecture & Key Decisions

## Static Site — No Backend

The entire app runs client-side. All data is pre-computed by the pipeline and served as static files from Cloudflare Pages. Shadow computation happens in the browser at 60fps.

## Shadow Computation: Geometric Projection

**Decision**: Project shadow polygons geometrically from building footprints + heights + sun angle.

**Why**: We tried raster ray-tracing (stair-stepped edges), GPU ray marching (too complex), and geometric projection. Geometric gives pixel-perfect edges, is fast enough for 60fps, and avoids the OSGB↔WGS84 reprojection problem that plagues raster approaches.

**Limitation**: Ignores terrain occlusion. A hill between a building and the garden could block a shadow. Acceptable for most of the UK which is relatively flat around pubs.

## Building Data: PMTiles on R2

**Decision**: Serve building data as a single `buildings.pmtiles` archive on Cloudflare R2, accessed via HTTP range requests from the frontend's `pmtiles` library.

**Why**: We went through four iterations:
1. **Single JSON** — worked for Norwich (16 MB), doesn't scale to UK (GB+).
2. **PMTiles on Cloudflare Pages** — great format but Pages' gzip rewriter stripped `Content-Length`, breaking range requests.
3. **Individual .pbf tiles on Cloudflare Pages** — worked but meant 47k individual files in the deploy, near Pages' 20k-file limit.
4. **PMTiles on R2** (current) — range requests work correctly on R2. Single 400+ MB archive vs 47k files. The frontend library (`pmtiles` npm) fetches only the bytes for needed tiles.

Each pub's 300m radius spans at most 4 z14 tiles. The frontend `pmtiles` instance range-requests 1-4 tile entries per pub selection (~10-100 KB each), with browser + Cloudflare edge caching on the R2 response.

## Height-Dependent Building Filter

**Decision**: Only include buildings that could actually cast a shadow into the porthole view, based on their height.

**Why**: A flat 300m radius includes many short buildings (sheds, walls, garages) that are too far away and too short to cast shadows reaching the pub. Using `shadow_reach = height / tan(3°)` reduces building count by ~30%.

## Shadow Rendering: Offscreen Canvas Compositing

**Decision**: Draw all shadow quads to an opaque offscreen canvas, then composite with a single `globalAlpha` blit.

**Why**: Drawing overlapping semi-transparent polygons causes opacity stacking (darker where quads overlap). An offscreen canvas renders them opaque, then a single alpha-blended blit gives uniform shadow darkness.

## Circle View: Map Tiles as Background

**Decision**: Load Stadia Maps Alidade Smooth raster tiles into the canvas porthole.

**Why**: Drawing roads from OSM data looked crude. Loading 9 tile images (3×3 grid) gives full map detail (roads, parks, water, labels) with no effort.

## Outdoor Areas: Plot Minus All Buildings

**Decision**: Compute garden areas by subtracting ALL building footprints from the Land Registry parcel, not just the pub's own building.

**Why**: Sheds, garages, and neighbouring buildings within the plot were showing as garden space. Subtracting all buildings gives an accurate outdoor area. Interior holes (fully enclosed buildings) are supported via evenodd canvas fill.

## Pub Data: OSM Only

**Decision**: Use OpenStreetMap as the sole pub data source, dropping FSA (Food Standards Agency).

**Why**: FSA lists food businesses, not pubs. A restaurant operating inside a pub gets its own FSA entry with a potentially wrong geocode (registered business address, not the pub). This caused duplicates, wrong building matches, and non-pubs (bingo halls, barber shops) appearing in the list. OSM's `amenity=pub` tag is curated by the community and gives accurate building polygons. OSM misses ~10-15% of real pubs, but the data quality tradeoff is worth it.

## Data Sources & Licensing

| Source | What | License | Attribution |
|--------|------|---------|-------------|
| OpenStreetMap | Pubs, buildings | [ODbL](https://opendatacommons.org/licenses/odbl/) | © OpenStreetMap contributors |
| EA LiDAR | Building heights | [OGL v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) | © Environment Agency |
| HM Land Registry | Plot boundaries | [OGL v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) | Crown copyright, reproduced with permission of HM Land Registry. Polygons subject to Crown copyright, Ordnance Survey AC0000851063. |
| Open-Meteo | Weather | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | open-meteo.com |
| Stadia Maps | Base map tiles | See [terms](https://stadiamaps.com/terms-of-service/) | © Stadia Maps, © OpenMapTiles |
| SunCalc | Sun position | BSD 2-Clause | © Vladimir Agafonkin |

Full attribution with required legal wording: [/attribution.html](/attribution.html)
