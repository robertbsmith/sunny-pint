# Architecture & Key Decisions

Decisions made during development, with the reasoning. Read this before changing anything.

## Shadow Computation: Geometric Projection

**Decision**: Project shadow polygons geometrically from building footprints + heights + sun angle. No raster shadow computation at runtime.

**Why**: We tried three approaches:
1. **Raster ray-tracing on LiDAR DSM** — sweep-line horizon algorithm. Works but output is a 1m-resolution raster. Vectorizing it produces stair-stepped edges. Gaussian blur + marching squares smooths them but shifts edges ~2m. Simplification makes them blocky. None looked good.
2. **GPU ray marching** (like ShadeMap/leaflet-shadow-simulator) — great quality but massive engineering effort, and the existing library is proprietary (requires API key).
3. **Geometric projection** — for each building wall segment, project a shadow quadrilateral. Pure vector output, mathematically exact edges, fast enough for 60fps client-side. Norwich is flat enough that terrain occlusion doesn't matter.

**Result**: Geometric projection gives the cleanest output with the least code. Building edges are pixel-perfect because the shadow polygons are derived from the same OSM building polygons drawn on the map.

**Limitation**: Ignores terrain occlusion. A hill between a building and the garden could block a shadow that geometric projection shows. Acceptable for flat cities (Norwich, most of UK). For hilly areas, would need to add terrain checking.

## Shadow Rendering: Offscreen Canvas Compositing

**Decision**: Draw all shadow quads to an opaque offscreen canvas, then composite onto the main canvas with a single `globalAlpha` draw.

**Why**: Drawing overlapping semi-transparent polygons causes opacity stacking (darker where quads overlap). An offscreen canvas renders them opaque, then a single alpha-blended blit gives uniform shadow darkness. Also, Leaflet's multi-polygon uses even-odd fill rule which cancels overlapping regions.

## Building Data: Pre-computed Heights in PMTiles

**Decision**: Sample building heights from LiDAR once at build time, store with the building polygons in PMTiles.

**Why**: LiDAR is only needed to measure heights. At runtime, we just need the polygon + a number. Pre-computing means:
- No LiDAR serving at runtime (~400MB for Norwich alone)
- No server-side computation
- Entire app can be static

**Height measurement**: 90th percentile of LiDAR DSM values within the building footprint. This captures the ridge height of pitched roofs while ignoring chimney outliers. Buildings shorter than 6m above local ground (hedges, walls, garden sheds) are filtered out.

## OSGB ↔ WGS84: The 2.6° Convergence Angle

**Discovery**: OSGB National Grid north is rotated ~2.6° clockwise from true north at Norwich. Any raster computed in OSGB and overlaid on a WGS84 map (Leaflet/MapLibre) will be misaligned — up to 9 pixels at 200m from center.

**Fix**: Reproject raster outputs from EPSG:27700 to EPSG:4326 using `rasterio.warp.reproject` before sending to the frontend. Or (better) avoid raster output entirely and use vector geometry.

**This is why we moved to geometric projection** — it avoids the raster reprojection problem entirely. Shadow polygons are computed in WGS84 lat/lng space.

## Building Source: Local GeoPackage from OSM .pbf

**Decision**: Extract all England buildings from Geofabrik's .osm.pbf into a GeoPackage (SQLite + R-tree spatial index). Query by bbox at runtime.

**Why**: 
- Overpass API is unreliable (rate limits, timeouts for dense areas)
- Local GeoPackage gives 1ms bbox queries
- GeoPackage is a single file, easy to manage
- R-tree spatial index is built by fiona on write

**Current data**: 98k buildings + 42k roads for greater Norwich area (33MB .gpkg). For UK-wide, this becomes PMTiles.

## Map: MapLibre GL JS (replacing Leaflet)

**Decision**: Use MapLibre GL JS instead of Leaflet for the new stack.

**Why**: Native vector tile support, WebGL rendering, built-in PMTiles protocol. Leaflet requires plugins for vector tiles and uses SVG/DOM which is slow for hundreds of polygons.

**Note**: The porthole/circle view stays as Canvas 2D. MapLibre is for the map behind it.

## Circle View: Map Tiles as Background

**Decision**: Load actual map tiles (CartoDB Voyager labels-under) into the canvas circle instead of hand-drawing roads.

**Why**: We tried drawing roads from OSM data with stroke widths by type. It looked crude compared to real map tiles. Loading 9 tile images (3x3 grid) and drawing them as the canvas background gives full map detail (roads, parks, water, labels) with zero effort.

**Tile provider**: `cartodb-basemaps-a.global.ssl.fastly.net/rastertiles/voyager_labels_under/{z}/{x}/{y}.png`. Clean style, subtle labels, coloured roads/parks. CORS-compatible.

## LiDAR-to-OSM Alignment

**Discovery**: LiDAR building footprints are offset from OSM by ~2m (GPS drift between LiDAR survey aircraft and aerial imagery used for OSM tracing).

**Approach tried**: Cross-correlation of rasterized building masks to find best (dx, dy, rotation) alignment. Found consistent ~2m translation, no significant rotation. The OSGB convergence angle (2.6°) was the bigger issue — once we fixed the projection, the residual offset became much less noticeable.

**Current approach**: Geometric projection doesn't need alignment — it uses OSM polygons directly for both the shadow source and the rendered building shape. Heights come from LiDAR (sampled within the OSM footprint, with tolerance for the ~2m offset).

## Data Sources

| Source | What | License | Size | How to obtain |
|--------|------|---------|------|---------------|
| OSM England .pbf | Buildings, roads, pubs, trees | ODbL | 1.6GB | `download.geofabrik.de/europe/united-kingdom/england-latest.osm.pbf` |
| EA LiDAR DSM 1m | Building/tree heights | OGL v3 | ~4MB per 1km tile | WCS: `environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-last-return-dsm-1m/wcs` |
| Land Registry INSPIRE | Property plot boundaries | OGL v3 | ~7MB per authority | `use-land-property-data.service.gov.uk/datasets/inspire/download/Norwich.zip` |
| CartoDB tiles | Map background for circle view | CC BY 3.0 | On-demand | CDN tiles |
| Met Office DataPoint | Weather forecasts | Free tier | On-demand | API |

## Animation Performance

**Target**: 60fps smooth shadow animation during play.

**Key optimisations**:
1. Shadow computation is client-side JS — no network round-trips during animation
2. Buildings + heights loaded once per pub selection, cached in state
3. Shadow geometry only recomputed when time changes by ≥0.3 minutes (not every frame)
4. Only the visible canvas (small or big) is drawn per frame, not both
5. Offscreen canvas for shadow compositing is reused, not created per frame
6. Map shadows (Leaflet/MapLibre polygons) skip updates during play — only the canvas circle updates at 60fps. Map updates on play stop or slider release.
