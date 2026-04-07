"""Extract buildings from England .osm.pbf into a GeoPackage with spatial index.

GeoPackage (GPKG) is SQLite + spatial index. Bbox queries are instant.
"""

import time
from pathlib import Path

import fiona
from fiona.crs import CRS
import osmium

PBF = Path(__file__).resolve().parent.parent / "data" / "england-latest.osm.pbf"
OUT = Path(__file__).resolve().parent.parent / "data" / "buildings.gpkg"

# Only extract buildings in the greater Norwich area for now.
# Expand this bbox or remove the filter to go UK-wide.
BBOX = (52.55, 1.15, 52.70, 1.40)  # (south, west, north, east)

SCHEMA = {
    "geometry": "Polygon",
    "properties": {
        "osm_id": "int",
        "building": "str",
        "name": "str",
        "height": "str",
        "levels": "str",
    },
}


class BuildingExtractor(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.bbox = bbox
        self.buildings = []
        self.count = 0

    def way(self, w):
        if "building" not in w.tags:
            return

        nodes = []
        for n in w.nodes:
            if not n.location.valid():
                return
            nodes.append((n.lon, n.lat))

        if len(nodes) < 3:
            return

        # Check if any node is in bbox.
        s, w_, n_, e = self.bbox
        in_bbox = False
        for lon, lat in nodes:
            if s <= lat <= n_ and w_ <= lon <= e:
                in_bbox = True
                break
        if not in_bbox:
            return

        # Close the ring if needed.
        if nodes[0] != nodes[-1]:
            nodes.append(nodes[0])

        tags = dict(w.tags)
        self.buildings.append({
            "geometry": {"type": "Polygon", "coordinates": [nodes]},
            "properties": {
                "osm_id": w.id,
                "building": tags.get("building", "yes"),
                "name": tags.get("name", ""),
                "height": tags.get("height", tags.get("building:height", "")),
                "levels": tags.get("building:levels", ""),
            },
        })

        self.count += 1
        if self.count % 5000 == 0:
            print(f"  {self.count} buildings extracted...", flush=True)


def main():
    print(f"Reading {PBF.name} ...")
    print(f"Bbox: {BBOX}")

    t0 = time.time()
    handler = BuildingExtractor(BBOX)
    handler.apply_file(str(PBF), locations=True)
    elapsed = time.time() - t0
    print(f"  Extracted {handler.count} buildings in {elapsed:.0f}s")

    print(f"Writing {OUT} ...")
    t0 = time.time()
    with fiona.open(
        str(OUT), "w",
        driver="GPKG",
        schema=SCHEMA,
        crs=CRS.from_epsg(4326),
        layer="buildings",
    ) as dst:
        for b in handler.buildings:
            dst.write(b)

    elapsed = time.time() - t0
    size_mb = OUT.stat().st_size / 1e6
    print(f"  Wrote {handler.count} features in {elapsed:.1f}s ({size_mb:.1f} MB)")
    print(f"  Saved to {OUT}")


if __name__ == "__main__":
    main()
