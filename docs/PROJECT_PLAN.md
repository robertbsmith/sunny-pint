# SunPub — Project Plan

## Vision
A mobile-first PWA that helps you find a sunny beer garden right now. Open it, see which nearby pub gardens have sun, tap one to see a shadow animation showing when the sun hits and leaves.

## User Flow

### 1. Open the App
- Requests location permission
- Shows a list of nearby pubs sorted by distance
- Each pub shows: name, distance, and a sun indicator (sunny / partly cloudy / overcast)
- Pubs without outdoor areas are filtered out

### 2. Browse
- Scroll the list or look at the map
- Map markers: gold = sunny garden, grey = shaded, muted = overcast
- Tapping a pub (list or map) opens the detail view

### 3. Detail View (The Porthole)
- A circular "porthole" view showing the pub and surroundings
- Map tiles as background (CartoDB Voyager labels-under)
- Buildings rendered as vector polygons (grey, pub building in orange)
- Shadows projected geometrically from building heights + sun position
- Sun icon on the bezel showing current sun bearing
- Compass ticks (N/S/E/W) on the porthole frame
- Sun % and time displayed inside the circle
- Pub name above, outdoor area outlined in green dashes
- Roads visible from the map tile background

### 4. Time Scrubbing
- Sun arc widget: a curve showing the sun's altitude path for the day
- Drag the sun along the arc to scrub time
- Hit play: smooth 60fps animation (requestAnimationFrame), sunrise to sunset
- Play stops at sunset, next play restarts from sunrise
- Shadow polygons update client-side — no server calls during animation

### 5. Night Mode
- Below horizon: dark blue background, crescent moon on bezel, muted buildings
- Smooth transition: background fades from dark to warm yellow as sun rises
- Shadow opacity fades in with altitude

### 6. Sharing
- Tap share → generates an image (canvas snapshot) or animated GIF
- Uses Web Share API for native share sheet (WhatsApp, iMessage, etc.)
- "Heading to The Stanley, sunny til 6 — come?"

### 7. Planning Ahead
- Date picker to check any future date
- "Saturday looks good at The Fat Cat"

### 8. Weather
- Met Office DataPoint API (free, UK-wide)
- Three states: sunny (full shadows), partly cloudy (light shadows + note), overcast (no shadows, greyed out)
- Weather badge on each pub in the list

## Features (Priority Order)

### MVP (Current)
- [x] Geometric shadow projection from building polygons
- [x] Client-side shadow computation (60fps capable)
- [x] Building data from OSM via GeoPackage with spatial index
- [x] Building heights sampled from EA LiDAR DSM
- [x] Porthole circle view with map tile background
- [x] Sun arc time picker
- [x] Play animation with smooth rendering
- [x] Night/day transitions
- [x] Pub list from OSM (111 Norwich pubs)
- [x] Pub building highlighted in orange
- [x] Roads from map tiles
- [x] Outdoor area outline (Land Registry INSPIRE)

### Next (Migrating to new stack)
- [ ] Vite 8 + TypeScript 6 + MapLibre GL JS
- [ ] PMTiles for UK-wide building data
- [ ] PWA (installable, offline, service worker)
- [ ] Geolocation + distance sorting
- [ ] Mobile-first responsive layout
- [ ] Share as image/GIF via Web Share API

### Later
- [ ] Weather overlay (Met Office DataPoint)
- [ ] Opening hours from OSM
- [ ] Tree shadows (OSM natural=tree + LiDAR canopy height)
- [ ] UK-wide pub data (not just Norwich)
- [ ] Cloudflare Pages + R2 deployment
- [ ] Pre-computed sun scores for list view
