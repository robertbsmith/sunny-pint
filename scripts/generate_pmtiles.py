"""Convert buildings GeoPackage (with heights) to PMTiles for static serving.

Exports buildings to GeoJSON, filters to buildings near pubs, then uses
tippecanoe to produce vector tiles in PMTiles format — split into z8 grid
files so each stays under 25 MB for Cloudflare Pages.

Usage:
    uv run python scripts/generate_pmtiles.py --area norwich
"""

import json
import math
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path

from shapely import wkb
from shapely.strtree import STRtree
from shapely.geometry import Point as ShapelyPoint

from areas import parse_area, in_bbox, Area

# ── Paths ──────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GPKG_PATH = DATA_DIR / "buildings.gpkg"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
PUBS_PATH = OUTPUT_DIR / "pubs.json"

# ── Constants ──────────────────────────────────────────────────────────────

# Max distance a building can be from a pub and still cast a shadow into the
# porthole view.  Porthole radius (~74 m at z18) + shadow cap (200 m) + margin.
BUILDING_RADIUS_M = 300

# Z8 tile grid for splitting output files.
SPLIT_ZOOM = 8

# ── Helpers ────────────────────────────────────────────────────────────────


def gpkg_header_len(blob: bytes) -> int:
    if len(blob) < 8:
        return 0
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_type, 0)


def lng_lat_to_z8(lng: float, lat: float) -> tuple[int, int]:
    """Convert lng/lat to z8 tile x,y."""
    n = 2 ** SPLIT_ZOOM
    x = int((lng + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return (min(x, n - 1), min(y, n - 1))


def resolve_height(osm_height, levels, lidar_height) -> float:
    """Pick best available height for a building."""
    h = lidar_height
    if h is None or h <= 0:
        if osm_height:
            try:
                h = float(osm_height.replace("m", "").strip())
            except ValueError:
                h = None
    if h is None or h <= 0:
        if levels:
            try:
                h = int(levels) * 3.0
            except ValueError:
                h = None
    if h is None or h <= 0:
        h = 8.0
    return h


# ── Main ──────────────────────────────────────────────────────────────────


def load_pub_points() -> list[ShapelyPoint]:
    """Load pub locations and return as Shapely points."""
    with open(PUBS_PATH) as f:
        pubs = json.load(f)
    points = []
    for p in pubs:
        points.append(ShapelyPoint(p["lng"], p["lat"]))
    print(f"  {len(points)} pubs loaded")
    return points


def export_geojson_near_pubs(area: Area, output_dir: Path) -> dict[str, Path]:
    """Export buildings near pubs, split into per-z8-tile GeoJSON files.

    Returns dict of z8 key -> geojson path.
    """
    # Build spatial index of pub locations.
    pub_points = load_pub_points()
    pub_tree = STRtree(pub_points)

    # Buffer distance in degrees (approximate).
    buf_deg = BUILDING_RADIUS_M / 111320.0

    conn = sqlite3.connect(str(GPKG_PATH))
    rows = conn.execute(
        "SELECT fid, geom, osm_id, building, name, height, levels, lidar_height "
        "FROM buildings"
    ).fetchall()

    # Collect features per z8 tile.
    tile_features: dict[str, list] = {}
    kept = 0
    skipped = 0

    for fid, blob, osm_id, building_type, name, osm_height, levels, lidar_height in rows:
        try:
            hl = gpkg_header_len(blob)
            geom = wkb.loads(blob[hl:])
            if geom.is_empty or not geom.is_valid:
                continue

            centroid = geom.centroid
            if not in_bbox(centroid.y, centroid.x, area.bbox):
                continue

            # Check if any pub is within BUILDING_RADIUS_M of this building.
            # Use buffered centroid query on the spatial index.
            nearby_idxs = pub_tree.query(centroid.buffer(buf_deg))
            if len(nearby_idxs) == 0:
                skipped += 1
                continue

            h = resolve_height(osm_height, levels, lidar_height)

            coords = [list(geom.exterior.coords)]
            for ring in geom.interiors:
                coords.append(list(ring.coords))

            feature = {
                "type": "Feature",
                "properties": {"h": round(h, 1)},
                "geometry": {"type": "Polygon", "coordinates": coords},
            }
            if name:
                feature["properties"]["name"] = name
            if building_type and building_type != "yes":
                feature["properties"]["type"] = building_type

            # Assign to z8 tile based on centroid.
            tx, ty = lng_lat_to_z8(centroid.x, centroid.y)
            key = f"{tx}-{ty}"
            if key not in tile_features:
                tile_features[key] = []
            tile_features[key].append(feature)
            kept += 1

        except Exception:
            continue

    conn.close()
    print(f"  {kept} buildings near pubs, {skipped} filtered out")
    print(f"  Split across {len(tile_features)} z8 tiles")

    # Write per-tile GeoJSON files.
    geojson_paths: dict[str, Path] = {}
    for key, features in tile_features.items():
        geojson = {"type": "FeatureCollection", "features": features}
        path = output_dir / f"buildings-{key}.geojson"
        with open(path, "w") as f:
            json.dump(geojson, f)
        geojson_paths[key] = path

    return geojson_paths


def run_tippecanoe(geojson_path: Path, output_path: Path) -> bool:
    """Run tippecanoe to convert GeoJSON to PMTiles."""
    tippecanoe = shutil.which("tippecanoe")
    if tippecanoe is None:
        print("ERROR: tippecanoe not found. Install it or add to PATH.")
        return False

    cmd = [
        tippecanoe,
        "-o", str(output_path),
        "-z", "16",       # max zoom (porthole uses z18 mpp but tiles at z16 are fine)
        "-Z", "14",       # min zoom (only need high zoom for nearby building detail)
        "-l", "buildings",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--force",
        str(geojson_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  tippecanoe failed: {result.stderr}")
        return False
    return True


def main():
    area = parse_area()
    print(f"Generating PMTiles for {area.name}")
    print(f"  GeoPackage: {GPKG_PATH}")
    print()

    if not GPKG_PATH.exists():
        print("ERROR: buildings.gpkg not found. Run build_gpkg.py first.")
        return

    if not PUBS_PATH.exists():
        print("ERROR: pubs.json not found. Run match_plots.py first.")
        return

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Clean old buildings files.
    for old in OUTPUT_DIR.glob("buildings*.pmtiles"):
        old.unlink()
    for old in OUTPUT_DIR.glob("buildings*.geojson"):
        old.unlink()

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        print("Exporting buildings near pubs to GeoJSON...", flush=True)
        geojson_paths = export_geojson_near_pubs(area, tmp)
        print()

        if not geojson_paths:
            print("No buildings found near pubs.")
            return

        # Convert each z8 tile to PMTiles.
        print("Converting to PMTiles...", flush=True)
        total_size = 0
        max_size = 0
        success_count = 0

        for key, geojson_path in sorted(geojson_paths.items()):
            output_path = OUTPUT_DIR / f"buildings-{key}.pmtiles"
            gj_size = geojson_path.stat().st_size / 1e6
            feat_count = len(json.load(open(geojson_path))["features"])
            print(f"  {key}: {feat_count} buildings ({gj_size:.1f} MB GeoJSON)", end="", flush=True)

            if run_tippecanoe(geojson_path, output_path):
                size = output_path.stat().st_size
                size_mb = size / 1e6
                total_size += size
                max_size = max(max_size, size)
                success_count += 1
                print(f" → {size_mb:.2f} MB")
            else:
                print(" → FAILED")

        print()
        print(f"Done! {success_count} PMTiles files")
        print(f"  Total: {total_size / 1e6:.1f} MB")
        print(f"  Largest: {max_size / 1e6:.2f} MB")
        if max_size > 25e6:
            print(f"  WARNING: largest file exceeds 25 MB Cloudflare Pages limit!")


if __name__ == "__main__":
    main()
