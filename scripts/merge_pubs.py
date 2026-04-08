"""Extract pubs from OSM .pbf file into a unified pub list.

OSM provides amenity=pub entries with building polygons, opening hours,
and outdoor seating tags — everything the app needs.

Usage:
    uv run python scripts/merge_pubs.py --area norwich
"""

import json
from pathlib import Path

import osmium

from areas import parse_area, in_bbox, Area

# ── Paths ──────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PBF_PATH = DATA_DIR / "england-latest.osm.pbf"
OUTPUT_PATH = DATA_DIR / "pubs_merged.json"

# ── OSM pub extraction from .pbf ──────────────────────────────────────────


class PubHandler(osmium.SimpleHandler):
    """Extract amenity=pub from OSM .pbf file."""

    def __init__(self, filter_area: Area):
        super().__init__()
        self._filter_area = filter_area
        self.pubs: list[dict] = []

    def node(self, n):
        if n.tags.get("amenity") == "pub":
            lat, lng = n.location.lat, n.location.lon
            if in_bbox(lat, lng, self._filter_area.bbox):
                self.pubs.append(self._make_pub(n.tags, lat, lng, f"node_{n.id}", None))

    def way(self, w):
        if w.tags.get("amenity") == "pub":
            try:
                coords = [(n.lat, n.lon) for n in w.nodes]
                if not coords:
                    return
                lat = sum(c[0] for c in coords) / len(coords)
                lng = sum(c[1] for c in coords) / len(coords)
                if in_bbox(lat, lng, self._filter_area.bbox):
                    polygon = [[c[0], c[1]] for c in coords]
                    self.pubs.append(self._make_pub(w.tags, lat, lng, f"way_{w.id}", polygon))
            except osmium.InvalidLocationError:
                pass

    def _make_pub(self, tags, lat, lng, osm_id, polygon):
        pub = {
            "id": osm_id,
            "name": tags.get("name", "Unnamed pub"),
            "lat": lat,
            "lng": lng,
            "beer_garden": tags.get("beer_garden", ""),
            "outdoor_seating": tags.get("outdoor_seating", ""),
            "opening_hours": tags.get("opening_hours", ""),
        }
        if polygon:
            pub["polygon"] = polygon
        return pub


# ── Main ──────────────────────────────────────────────────────────────────


def main():
    area = parse_area()
    print(f"Extracting pubs for {area.name}")
    print()

    if not PBF_PATH.exists():
        print(f"ERROR: {PBF_PATH} not found.")
        print("Download from: https://download.geofabrik.de/europe/great-britain/england.html")
        return

    print(f"  Extracting pubs from {PBF_PATH.name}...", flush=True)
    handler = PubHandler(area)
    handler.apply_file(str(PBF_PATH), locations=True)
    pubs = handler.pubs

    # Sort by name.
    pubs.sort(key=lambda p: p.get("name", ""))

    # Stats.
    print(f"\n  {len(pubs)} pubs found")
    print(f"  With polygons: {sum(1 for p in pubs if 'polygon' in p)}")
    print(f"  With outdoor tags: {sum(1 for p in pubs if p.get('outdoor_seating') or p.get('beer_garden'))}")
    print(f"  With opening hours: {sum(1 for p in pubs if p.get('opening_hours'))}")

    # Save.
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(pubs, f, indent=2)

    size_mb = OUTPUT_PATH.stat().st_size / 1e6
    print(f"\n  Saved to {OUTPUT_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
