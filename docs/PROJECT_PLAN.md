# Sunny Pint — Project Plan

## Vision
A mobile-first PWA that helps you find a sunny beer garden right now. Open it, see which nearby pub gardens have sun, tap one to see a shadow animation showing when the sun hits and leaves.

## Current State

### Complete
- [x] Geometric shadow projection from building polygons (60fps)
- [x] Building data from OSM via GeoPackage with spatial index
- [x] Building heights from EA LiDAR DSM/DTM
- [x] Porthole circle view with map tile background
- [x] Sun arc time picker with play animation
- [x] Night/day transitions with smooth twilight
- [x] Pub list from OSM with search and distance sorting
- [x] Pub building highlighted, outdoor area with dashed outline
- [x] Outdoor area computation (Land Registry plot minus all buildings, with holes)
- [x] Height-dependent building filter (30% data reduction)
- [x] Individual .pbf vector tiles for static CDN serving
- [x] PWA (installable, offline via service worker)
- [x] Geolocation + Nominatim geocoding
- [x] Share as image via Web Share API
- [x] Weather from Open-Meteo (cloud cover indicator)
- [x] Deep linking via URL params
- [x] Date picker for future dates
- [x] Pub sign with coat of arms (Armoria), adaptive sizing
- [x] Theme selector (light/dark/system)
- [x] Ko-fi support button
- [x] Full attribution page with required legal wording
- [x] Cloudflare Pages deployment
- [x] Pipeline supports `--area` flag for any UK region

- [x] UK-wide data pipeline (33k pubs, 13.4M buildings)
- [x] Full INSPIRE plot data (318 local authorities)
- [x] Precomputed Sunny Ratings (equinox sun simulation per pub)
- [x] Per-pub pages via Cloudflare Pages Functions
- [x] OG image generation per pub
- [x] SEO landing pages (city, theme) with sitemap.xml
- [x] Structured data (JSON-LD) on landing pages
- [x] Privacy page
- [x] Terrain horizon computation

### Future
- [ ] Tree shadows (OSM natural=tree + LiDAR canopy height)
- [ ] User-reported pub closures / corrections
- [ ] Opening hours filtering
