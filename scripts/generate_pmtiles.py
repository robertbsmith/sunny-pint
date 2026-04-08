"""Convert buildings GeoPackage (with heights) to PMTiles for static serving.

Exports buildings to GeoJSON, then uses tippecanoe to produce vector tiles
in PMTiles format.

Usage:
    uv run python scripts/generate_pmtiles.py --area norwich
"""

import json
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path

from pyproj import Transformer
from shapely import wkb

from areas import parse_area, in_bbox, Area

# ── Paths ──────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GPKG_PATH = DATA_DIR / "buildings.gpkg"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "public" / "data"

# ── GeoPackage helpers ─────────────────────────────────────────────────────


def gpkg_header_len(blob: bytes) -> int:
    if len(blob) < 8:
        return 0
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_type, 0)


# ── Main ──────────────────────────────────────────────────────────────────


def export_geojson(area: Area, output_path: Path) -> int:
    """Export buildings from GeoPackage to GeoJSON file.

    Returns number of features exported.
    """
    conn = sqlite3.connect(str(GPKG_PATH))

    rows = conn.execute(
        "SELECT fid, geom, osm_id, building, name, height, levels, lidar_height "
        "FROM buildings"
    ).fetchall()

    features = []
    for fid, blob, osm_id, building_type, name, osm_height, levels, lidar_height in rows:
        try:
            hl = gpkg_header_len(blob)
            geom = wkb.loads(blob[hl:])
            if geom.is_empty or not geom.is_valid:
                continue

            centroid = geom.centroid
            if not in_bbox(centroid.y, centroid.x, area.bbox):
                continue

            # Use lidar_height if available, else parse OSM height, else levels * 3.
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
                h = 8.0  # default

            # GeoJSON coordinates are [lng, lat] (already in WGS84 from gpkg).
            coords = [list(geom.exterior.coords)]
            for ring in geom.interiors:
                coords.append(list(ring.coords))

            feature = {
                "type": "Feature",
                "properties": {
                    "h": round(h, 1),
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": coords,
                },
            }

            # Only include non-empty optional properties to keep file small.
            if name:
                feature["properties"]["name"] = name
            if building_type and building_type != "yes":
                feature["properties"]["type"] = building_type

            features.append(feature)
        except Exception:
            continue

    conn.close()

    geojson = {"type": "FeatureCollection", "features": features}

    with open(output_path, "w") as f:
        json.dump(geojson, f)

    return len(features)


def run_tippecanoe(geojson_path: Path, output_path: Path):
    """Run tippecanoe to convert GeoJSON to PMTiles."""
    tippecanoe = shutil.which("tippecanoe")
    if tippecanoe is None:
        print("ERROR: tippecanoe not found. Install it or add to PATH.")
        print("  Build from source: https://github.com/felt/tippecanoe")
        return False

    cmd = [
        tippecanoe,
        "-o", str(output_path),
        "-z", "16",       # max zoom
        "-Z", "10",       # min zoom
        "-l", "buildings", # layer name
        "--drop-densest-as-needed",  # reduce density at low zooms
        "--extend-zooms-if-still-dropping",
        "--force",         # overwrite output
        str(geojson_path),
    ]

    print(f"  Running: {' '.join(cmd[-4:])}")
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

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Export to temporary GeoJSON.
    with tempfile.NamedTemporaryFile(suffix=".geojson", delete=False) as tmp:
        geojson_path = Path(tmp.name)

    print("Exporting buildings to GeoJSON...", flush=True)
    count = export_geojson(area, geojson_path)
    size_mb = geojson_path.stat().st_size / 1e6
    print(f"  {count} buildings, {size_mb:.1f} MB")
    print()

    # Run tippecanoe.
    output_path = OUTPUT_DIR / "buildings.pmtiles"
    print("Converting to PMTiles...", flush=True)
    success = run_tippecanoe(geojson_path, output_path)

    # Clean up temp file.
    geojson_path.unlink(missing_ok=True)

    if success:
        size_mb = output_path.stat().st_size / 1e6
        print(f"\nDone! {output_path} ({size_mb:.1f} MB)")
    else:
        print("\nFailed to generate PMTiles.")
        # Keep the GeoJSON as fallback.
        fallback = OUTPUT_DIR / "buildings.geojson"
        print(f"Exporting GeoJSON fallback to {fallback}...")
        export_geojson(area, fallback)
        size_mb = fallback.stat().st_size / 1e6
        print(f"  {fallback} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
