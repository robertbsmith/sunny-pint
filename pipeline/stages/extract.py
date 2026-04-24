"""Stage 1: EXTRACT — parse OSM .pbfs into pubs + buildings.

Single osmium pass per .pbf extracts both amenity=pub nodes/ways and
building=* ways/relations. Buildings go into buildings.gpkg, pubs into
pubs_extracted.json.

Append-aware: if buildings.gpkg already exists with an .ingested marker,
only processes new .pbf files.
"""

import json
from pathlib import Path

import fiona
import osmium
from fiona.crs import CRS

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
PBF_PATHS = sorted(DATA_DIR.glob("*-latest.osm.pbf"))
GPKG_PATH = DATA_DIR / "buildings.gpkg"
INGESTED_PATH = GPKG_PATH.with_suffix(".gpkg.ingested")
PUBS_PATH = DATA_DIR / "pubs_extracted.json"

BUILDING_SCHEMA = {
    "geometry": "Polygon",
    "properties": {
        "osm_id": "int",
        "building": "str",
        "name": "str",
        "height": "str",
        "levels": "str",
        "lidar_height": "float",
        "ground_elev": "float",
    },
}


class DualExtractor(osmium.SimpleHandler):
    """Extract both pubs and buildings from a single .pbf pass."""

    def __init__(self, bbox, buildings_dst):
        super().__init__()
        self.bbox = bbox
        self.dst = buildings_dst
        self.pubs: list[dict] = []
        self.building_count = 0

    def _in_bbox(self, lat, lng):
        s, w, n, e = self.bbox
        return s <= lat <= n and w <= lng <= e

    def _write_building(self, tags, nodes, osm_id):
        if len(nodes) < 3:
            return
        s, w, n, e = self.bbox
        if not any(s <= lat <= n and w <= lng <= e for lng, lat in nodes):
            return
        if nodes[0] != nodes[-1]:
            nodes.append(nodes[0])
        self.dst.write({
            "geometry": {"type": "Polygon", "coordinates": [nodes]},
            "properties": {
                "osm_id": osm_id,
                "building": tags.get("building", "yes"),
                "name": tags.get("name", ""),
                "height": tags.get("height", tags.get("building:height", "")),
                "levels": tags.get("building:levels", ""),
                "lidar_height": None,
                "ground_elev": None,
            },
        })
        self.building_count += 1
        if self.building_count % 100000 == 0:
            print(f"    {self.building_count:,} buildings...", flush=True)

    def _extract_pub(self, tags, lat, lng, osm_id, osm_type, polygon=None):
        if not self._in_bbox(lat, lng):
            return
        pub = {
            # Downstream stages (package, score, backfill) key pubs by "id"
            # with the v1 `{type}_{osm_id}` shape. Numeric osm_id alone
            # collides between nodes and ways that share the same integer.
            "id": f"{osm_type}_{osm_id}",
            "osm_id": osm_id,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
        }
        # Keep this aligned with the v1 scripts/merge_pubs.py tag list —
        # INDEX_FIELDS / DETAIL_FIELDS in package.py reference brand,
        # brewery, real_ale, food, wheelchair, dog, internet_access, and
        # dropping them here silently empties those columns on a fresh run.
        for key in ("name", "opening_hours", "outdoor_seating", "beer_garden",
                     "addr:city", "addr:town", "addr:village", "addr:hamlet",
                     "addr:place", "addr:street", "addr:housenumber",
                     "addr:postcode", "phone", "website", "cuisine",
                     "brand", "brewery", "real_ale", "food", "wheelchair",
                     "dog", "internet_access"):
            val = tags.get(key)
            if val:
                pub[key.replace(":", "_")] = val
        if "internet_access" in pub:
            pub["wifi"] = pub.pop("internet_access")
        if polygon:
            pub["polygon"] = polygon
        self.pubs.append(pub)

    def node(self, n):
        tags = dict(n.tags)
        if tags.get("amenity") == "pub":
            self._extract_pub(tags, n.location.lat, n.location.lng, n.id, "node")

    def way(self, w):
        tags = dict(w.tags)
        try:
            nodes = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if tags.get("building"):
            self._write_building(tags, nodes, w.id)
        if tags.get("amenity") == "pub" and len(nodes) >= 3:
            centroid_lat = sum(lat for _, lat in nodes) / len(nodes)
            centroid_lng = sum(lng for lng, _ in nodes) / len(nodes)
            polygon = [[round(lat, 6), round(lng, 6)] for lng, lat in nodes]
            self._extract_pub(tags, centroid_lat, centroid_lng, w.id, "way", polygon)


def run(area) -> dict:
    """Run extract stage. Returns stats dict."""
    if not PBF_PATHS:
        raise FileNotFoundError(f"No *-latest.osm.pbf files in {DATA_DIR}")

    bbox = area.bbox or (-90, -180, 90, 180)

    # Determine which PBFs need processing.
    ingested = set()
    if INGESTED_PATH.exists():
        ingested = set(INGESTED_PATH.read_text().strip().splitlines())

    new_pbfs = [p for p in PBF_PATHS if p.name not in ingested]
    if not new_pbfs and GPKG_PATH.exists() and PUBS_PATH.exists():
        print("  All PBFs already ingested.")
        existing_pubs = json.loads(PUBS_PATH.read_text())
        return {"pubs": len(existing_pubs), "new_pbfs": 0}

    # Load existing pubs (for dedup across PBFs).
    existing_pubs: list[dict] = []
    seen_ids: set[int] = set()
    if PUBS_PATH.exists() and ingested:
        existing_pubs = json.loads(PUBS_PATH.read_text())
        seen_ids = {p["osm_id"] for p in existing_pubs if "osm_id" in p}

    total_buildings = 0
    all_new_pubs: list[dict] = []

    for pbf in new_pbfs:
        print(f"  Processing {pbf.name}...", flush=True)
        mode = "a" if GPKG_PATH.exists() else "w"
        with fiona.open(
            str(GPKG_PATH), mode,
            driver="GPKG",
            schema=BUILDING_SCHEMA,
            crs=CRS.from_epsg(4326),
            layer="buildings",
        ) as dst:
            handler = DualExtractor(bbox, dst)
            handler.apply_file(str(pbf), locations=True)

        # Dedup pubs.
        for p in handler.pubs:
            oid = p.get("osm_id")
            if oid and oid in seen_ids:
                continue
            if oid:
                seen_ids.add(oid)
            all_new_pubs.append(p)

        total_buildings += handler.building_count
        ingested.add(pbf.name)
        print(f"    {handler.building_count:,} buildings, {len(handler.pubs)} pubs from {pbf.name}")

    # Merge and save pubs.
    all_pubs = existing_pubs + all_new_pubs
    all_pubs.sort(key=lambda p: p.get("name", ""))
    PUBS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PUBS_PATH.write_text(json.dumps(all_pubs, indent=2))

    # Update ingested marker.
    INGESTED_PATH.write_text("\n".join(sorted(ingested)) + "\n")

    print(f"  {len(all_pubs)} total pubs, {total_buildings:,} new buildings")
    return {
        "pubs": len(all_pubs),
        "new_pubs": len(all_new_pubs),
        "new_buildings": total_buildings,
        "new_pbfs": len(new_pbfs),
    }
