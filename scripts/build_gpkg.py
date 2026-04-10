"""Extract buildings from .osm.pbf into a GeoPackage with spatial index.

GeoPackage (GPKG) is SQLite + spatial index. Bbox queries are instant.

Usage:
    uv run python scripts/build_gpkg.py --area norwich
"""

import shutil
import time
from pathlib import Path

import fiona
from fiona.crs import CRS
import osmium

from areas import parse_area

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PBF_PATHS = sorted(DATA_DIR.glob("*-latest.osm.pbf"))
OUT = DATA_DIR / "buildings.gpkg"

SCHEMA = {
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


class BuildingExtractor(osmium.SimpleHandler):
    """Extract buildings from .pbf and stream directly to GeoPackage."""

    def __init__(self, bbox, dst):
        super().__init__()
        self.bbox = bbox
        self.dst = dst
        self.count = 0

    def _write_building(self, tags, nodes, osm_id):
        """Write a building polygon to the GeoPackage."""
        s, w_, n_, e = self.bbox
        if len(nodes) < 3:
            return
        if not any(s <= lat <= n_ and w_ <= lon <= e for lon, lat in nodes):
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
        self.count += 1
        if self.count % 50000 == 0:
            print(f"  {self.count} buildings...", flush=True)

    def way(self, w):
        tags = dict(w.tags)
        if "building" not in tags:
            return
        nodes = []
        for n in w.nodes:
            if not n.location.valid():
                return
            nodes.append((n.lon, n.lat))
        self._write_building(tags, nodes, w.id)

    def area(self, a):
        """Handle multipolygon relations (churches, large buildings, etc.)."""
        tags = dict(a.tags)
        if "building" not in tags:
            return
        # osmium area IDs: ways get id*2, relations get id*2+1
        osm_id = a.orig_id()
        try:
            for outer in a.outer_rings():
                nodes = [(n.lon, n.lat) for n in outer]
                self._write_building(tags, nodes, osm_id)
        except Exception:
            pass


def main():
    area = parse_area()
    bbox = area.bbox

    # bbox=None means no filter (process everything in the .pbf).
    if bbox is None:
        bbox = (-90, -180, 90, 180)  # world bbox — effectively no filter

    if not PBF_PATHS:
        print(f"ERROR: no *-latest.osm.pbf files found in {DATA_DIR}")
        print("Download from: https://download.geofabrik.de/europe/great-britain/")
        return

    print(f"Extracting buildings for {area.name}")
    print(f"  PBF files: {', '.join(p.name for p in PBF_PATHS)}")
    print(f"  Bbox: {'all' if area.bbox is None else area.bbox}")

    # If the gpkg already exists and we're adding new PBF files, append to it
    # instead of rebuilding from scratch (preserves existing heights).
    if OUT.exists() and len(PBF_PATHS) > 1:
        # Check which PBFs have already been ingested by looking at a marker.
        marker_file = OUT.with_suffix(".gpkg.ingested")
        ingested = set()
        if marker_file.exists():
            ingested = set(marker_file.read_text().strip().splitlines())

        new_pbfs = [p for p in PBF_PATHS if p.name not in ingested]
        if not new_pbfs:
            print("  All PBF files already ingested — nothing to do.")
            return
        print(f"  Appending {len(new_pbfs)} new PBF file(s) to existing gpkg")

        t0 = time.time()
        total = 0
        for pbf in new_pbfs:
            print(f"  Processing {pbf.name}...", flush=True)
            with fiona.open(
                str(OUT), "a",
                driver="GPKG",
                schema=SCHEMA,
                crs=CRS.from_epsg(4326),
                layer="buildings",
            ) as dst:
                handler = BuildingExtractor(bbox, dst)
                handler.apply_file(str(pbf), locations=True)
            total += handler.count
            print(f"    {handler.count} buildings from {pbf.name}")
            ingested.add(pbf.name)

        marker_file.write_text("\n".join(sorted(ingested)) + "\n")
        elapsed = time.time() - t0
        size_mb = OUT.stat().st_size / 1e6
        print(f"  Appended {total} buildings in {elapsed:.1f}s (gpkg now {size_mb:.1f} MB)")
        return

    # Fresh build — write all PBFs to a new gpkg.
    TMP = OUT.with_suffix(".gpkg.tmp")
    print(f"  Streaming to {TMP}...")
    t0 = time.time()
    total = 0
    for i, pbf in enumerate(PBF_PATHS):
        mode = "w" if i == 0 else "a"
        print(f"  Processing {pbf.name}...", flush=True)
        with fiona.open(
            str(TMP), mode,
            driver="GPKG",
            schema=SCHEMA,
            crs=CRS.from_epsg(4326),
            layer="buildings",
        ) as dst:
            handler = BuildingExtractor(bbox, dst)
            handler.apply_file(str(pbf), locations=True)
        total += handler.count
        print(f"    {handler.count} buildings from {pbf.name}")

    elapsed = time.time() - t0
    print(f"  {total} buildings in {elapsed:.0f}s")
    shutil.move(str(TMP), str(OUT))
    # Write ingested marker.
    marker = OUT.with_suffix(".gpkg.ingested")
    marker.write_text("\n".join(p.name for p in PBF_PATHS) + "\n")
    size_mb = OUT.stat().st_size / 1e6
    print(f"  Wrote {total} buildings in {elapsed:.1f}s ({size_mb:.1f} MB)")
    print(f"  Saved to {OUT}")


if __name__ == "__main__":
    main()
