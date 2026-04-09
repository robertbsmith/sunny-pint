"""Generate individual vector tile files from buildings GeoPackage.

Filters buildings to those near pubs, runs tippecanoe to create a temporary
PMTiles archive, then extracts individual z14 .pbf tiles as static files
for serving from any CDN (no range request support needed).

Usage:
    uv run python scripts/generate_tiles.py --area norwich
"""

import json
import math
import shutil
import sqlite3
import struct
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
TILES_DIR = OUTPUT_DIR / "tiles"
PUBS_PATH = OUTPUT_DIR / "pubs.json"

# ── Constants ──────────────────────────────────────────────────────────────

# Porthole viewport radius in metres (~74m at z18 UK latitudes).
PORTHOLE_RADIUS_M = 74

# Frontend shadow length cap (matches shadow.ts maxShadowLen).
SHADOW_CAP_M = 200

# Minimum sun altitude (degrees) worth considering for shadows.
# At 3° the dayFrac is ~0.5, shadows are clearly visible.
MIN_SUN_ALT_DEG = 3

# Max possible radius: porthole + shadow cap.
MAX_RADIUS_M = PORTHOLE_RADIUS_M + SHADOW_CAP_M  # 274m

TILE_ZOOM = 14  # zoom level for individual tile files

# ── Helpers ────────────────────────────────────────────────────────────────


def gpkg_header_len(blob: bytes) -> int:
    if len(blob) < 8:
        return 0
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_type, 0)


def shadow_reach_m(height_m: float) -> float:
    """Max distance a building of given height can cast a shadow into the porthole.

    shadow_length = height / tan(sun_altitude)
    reach = porthole_radius + min(shadow_length, shadow_cap)
    """
    import math
    shadow_len = height_m / math.tan(math.radians(MIN_SUN_ALT_DEG))
    shadow_len = min(shadow_len, SHADOW_CAP_M)
    return PORTHOLE_RADIUS_M + shadow_len


def resolve_height(osm_height, levels, lidar_height) -> float:
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


# ── PMTiles extraction ────────────────────────────────────────────────────

def zxy_to_tileid(z: int, x: int, y: int) -> int:
    """Convert z/x/y to PMTiles Hilbert tile ID."""
    if z == 0:
        return 0
    acc = 0
    for i in range(z):
        acc += (1 << i) * (1 << i)
    # Hilbert curve encoding for the tile within the zoom level.
    n = 1 << z
    rx = ry = s = d = 0
    tx, ty = x, y
    s = n // 2
    d = 0
    while s > 0:
        rx = 1 if (tx & s) > 0 else 0
        ry = 1 if (ty & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        # Rotate
        if ry == 0:
            if rx == 1:
                tx = s - 1 - tx
                ty = s - 1 - ty
            tx, ty = ty, tx
        s //= 2
    return acc + d


def extract_tiles_from_pmtiles(pmtiles_path: Path, output_dir: Path, zoom: int) -> int:
    """Extract all tiles at a given zoom from a PMTiles file into individual .pbf files.

    Uses tippecanoe-decode or falls back to direct PMTiles reading.
    Returns number of tiles extracted.
    """
    # Use tile-join to extract, or read directly with Python.
    # Direct Python approach using the PMTiles spec.
    import gzip as gzip_mod

    with open(pmtiles_path, "rb") as f:
        # Read header (127 bytes).
        header_data = f.read(127)
        if header_data[:2] != b"PM":
            print(f"  ERROR: not a valid PMTiles file")
            return 0

        spec_version = header_data[7]

        root_dir_offset = int.from_bytes(header_data[8:16], "little")
        root_dir_length = int.from_bytes(header_data[16:24], "little")
        json_metadata_offset = int.from_bytes(header_data[24:32], "little")
        json_metadata_length = int.from_bytes(header_data[32:40], "little")
        leaf_dir_offset = int.from_bytes(header_data[40:48], "little")
        leaf_dir_length = int.from_bytes(header_data[48:56], "little")
        tile_data_offset = int.from_bytes(header_data[56:64], "little")
        tile_data_length = int.from_bytes(header_data[64:72], "little")
        num_addressed = int.from_bytes(header_data[72:80], "little")
        num_entries = int.from_bytes(header_data[80:88], "little")
        num_contents = int.from_bytes(header_data[88:96], "little")
        clustered = bool(header_data[96])
        internal_compression = header_data[97]
        tile_compression = header_data[98]
        tile_type = header_data[99]
        min_zoom = header_data[100]
        max_zoom = header_data[101]

        print(f"  PMTiles v{spec_version}: z{min_zoom}-{max_zoom}, {num_addressed} tiles")
        print(f"  Internal compression: {internal_compression}, Tile compression: {tile_compression}")

        def decompress(data: bytes, compression: int) -> bytes:
            if compression == 2:  # gzip
                return gzip_mod.decompress(data)
            if compression == 1:  # none
                return data
            raise ValueError(f"Unsupported compression: {compression}")

        def read_directory(offset: int, length: int) -> list:
            f.seek(offset)
            raw = f.read(length)
            data = decompress(raw, internal_compression)
            return parse_directory(data)

        def parse_directory(data: bytes) -> list:
            entries = []
            pos = 0

            def read_varint():
                nonlocal pos
                val = 0
                shift = 0
                while True:
                    b = data[pos]
                    pos += 1
                    val |= (b & 0x7F) << shift
                    if (b & 0x80) == 0:
                        break
                    shift += 7
                return val

            num_entries = read_varint()

            # Read tile IDs (delta-encoded).
            tile_ids = []
            last_id = 0
            for _ in range(num_entries):
                delta = read_varint()
                last_id += delta
                tile_ids.append(last_id)

            # Read run lengths.
            run_lengths = []
            for _ in range(num_entries):
                run_lengths.append(read_varint())

            # Read lengths.
            lengths = []
            for _ in range(num_entries):
                lengths.append(read_varint())

            # Read offsets (delta-encoded, special handling for run_length=0 leaf dirs).
            offsets = []
            last_offset = 0
            for i in range(num_entries):
                v = read_varint()
                if v == 0 and i > 0:
                    offsets.append(offsets[-1] + lengths[i - 1])
                else:
                    offsets.append(v - 1)
                last_offset = offsets[-1]

            for i in range(num_entries):
                entries.append({
                    "tile_id": tile_ids[i],
                    "offset": offsets[i],
                    "length": lengths[i],
                    "run_length": run_lengths[i],
                })

            return entries

        def tileid_to_zxy(tile_id: int) -> tuple[int, int, int]:
            """Convert Hilbert tile ID back to z/x/y."""
            if tile_id == 0:
                return (0, 0, 0)
            # Find zoom level.
            acc = 0
            z = 0
            while True:
                count = (1 << z) * (1 << z)
                if acc + count > tile_id:
                    break
                acc += count
                z += 1

            d = tile_id - acc
            n = 1 << z
            tx = ty = 0
            s = 1
            while s < n:
                rx = 1 if (d & 2) > 0 else 0
                ry = 1 if ((d & 1) ^ rx) > 0 else 0  # note: XOR
                # Rotate
                if ry == 0:
                    if rx == 1:
                        tx = s - 1 - tx
                        ty = s - 1 - ty
                    tx, ty = ty, tx
                tx += s * rx
                ty += s * ry
                d //= 4
                s *= 2

            return (z, tx, ty)

        # Read root directory.
        entries = read_directory(root_dir_offset, root_dir_length)

        # Also read leaf directories for entries with run_length=0.
        all_tile_entries = []
        for entry in entries:
            if entry["run_length"] == 0:
                # This is a leaf directory pointer.
                leaf_entries = read_directory(
                    leaf_dir_offset + entry["offset"],
                    entry["length"],
                )
                all_tile_entries.extend(leaf_entries)
            else:
                all_tile_entries.append(entry)

        # Extract tiles at target zoom.
        count = 0
        for entry in all_tile_entries:
            z, x, y = tileid_to_zxy(entry["tile_id"])
            if z != zoom:
                continue

            f.seek(tile_data_offset + entry["offset"])
            raw_tile = f.read(entry["length"])

            # Decompress tile data if needed.
            if tile_compression == 2:  # gzip
                tile_data = gzip_mod.decompress(raw_tile)
            elif tile_compression == 1:  # none
                tile_data = raw_tile
            else:
                tile_data = raw_tile  # try as-is

            # Write to file.
            tile_path = output_dir / f"{x}-{y}.pbf"
            tile_path.write_bytes(tile_data)
            count += 1

        return count


# ── Main ──────────────────────────────────────────────────────────────────


def load_pub_points() -> list[ShapelyPoint]:
    with open(PUBS_PATH) as f:
        pubs = json.load(f)
    points = [ShapelyPoint(p["lng"], p["lat"]) for p in pubs]
    print(f"  {len(points)} pubs loaded")
    return points


def export_geojson_near_pubs(area: Area, output_path: Path) -> int:
    """Export buildings near pubs to a single GeoJSON file.

    Uses height-dependent radius: short buildings are excluded if they're too
    far away to cast a shadow into the porthole at low sun angles.
    Returns feature count.
    """
    pub_points = load_pub_points()
    pub_tree = STRtree(pub_points)

    conn = sqlite3.connect(str(GPKG_PATH))

    # Use R-tree spatial index for area-restricted queries to avoid OOM.
    if area.bbox is not None:
        s, w_, n_, e_ = area.bbox
        # Add max radius buffer (in degrees, conservative — uses lat for both axes).
        buf_deg = MAX_RADIUS_M / 111320.0
        try:
            rows = conn.execute(
                "SELECT b.fid, b.geom, b.osm_id, b.building, b.name, b.height, b.levels, b.lidar_height, b.ground_elev "
                "FROM buildings b "
                "JOIN rtree_buildings_geom r ON b.fid = r.id "
                "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
                (w_ - buf_deg, e_ + buf_deg, s - buf_deg, n_ + buf_deg),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = conn.execute(
                "SELECT fid, geom, osm_id, building, name, height, levels, lidar_height, ground_elev "
                "FROM buildings"
            ).fetchall()
    else:
        # UK-wide: read all buildings (we filter by pub proximity below).
        rows = conn.execute(
            "SELECT fid, geom, osm_id, building, name, height, levels, lidar_height, ground_elev "
            "FROM buildings"
        ).fetchall()

    features = []
    skipped = 0
    skipped_by_height = 0

    for fid, blob, osm_id, building_type, name, osm_height, levels, lidar_height, ground_elev in rows:
        try:
            hl = gpkg_header_len(blob)
            geom = wkb.loads(blob[hl:])
            if geom.is_empty or not geom.is_valid:
                continue

            centroid = geom.centroid
            if not in_bbox(centroid.y, centroid.x, area.bbox):
                continue

            # Resolve height first so we can compute shadow reach.
            h = resolve_height(osm_height, levels, lidar_height)
            reach = shadow_reach_m(h)
            reach_deg = reach / 111320.0

            # Check if any pub is within this building's shadow reach.
            nearby_idxs = pub_tree.query(centroid.buffer(reach_deg))
            if len(nearby_idxs) == 0:
                # Try max radius as fallback — building might be very close but short.
                # Actually no: if reach_deg found nothing, max_buf_deg won't either
                # since reach is always >= porthole radius.
                skipped += 1
                if reach < MAX_RADIUS_M:
                    skipped_by_height += 1
                continue

            coords = [list(geom.exterior.coords)]
            for ring in geom.interiors:
                coords.append(list(ring.coords))

            feature = {
                "type": "Feature",
                "properties": {"h": round(h, 1)},
                "geometry": {"type": "Polygon", "coordinates": coords},
            }
            if ground_elev is not None:
                feature["properties"]["e"] = round(ground_elev, 1)
            features.append(feature)
        except Exception:
            continue

    conn.close()
    print(f"  {len(features)} buildings near pubs, {skipped} filtered out ({skipped_by_height} by height)")

    geojson = {"type": "FeatureCollection", "features": features}
    with open(output_path, "w") as f:
        json.dump(geojson, f)

    return len(features)


def main():
    area = parse_area()
    print(f"Generating building tiles for {area.name}")
    print(f"  GeoPackage: {GPKG_PATH}")
    print()

    if not GPKG_PATH.exists():
        print("ERROR: buildings.gpkg not found. Run build_gpkg.py first.")
        return

    if not PUBS_PATH.exists():
        print("ERROR: pubs.json not found. Run match_plots.py first.")
        return

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Clean old tile files.
    if TILES_DIR.exists():
        shutil.rmtree(TILES_DIR)
    TILES_DIR.mkdir(parents=True)
    for old in OUTPUT_DIR.glob("buildings*.pmtiles"):
        old.unlink()

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        # Step 1: Export buildings near pubs to GeoJSON.
        geojson_path = tmp / "buildings.geojson"
        print("Exporting buildings near pubs...", flush=True)
        count = export_geojson_near_pubs(area, geojson_path)
        if count == 0:
            print("No buildings found near pubs.")
            return
        gj_size = geojson_path.stat().st_size / 1e6
        print(f"  GeoJSON: {gj_size:.1f} MB")
        print()

        # Step 2: Run tippecanoe to create a temporary PMTiles.
        pmtiles_path = tmp / "buildings.pmtiles"
        tippecanoe = shutil.which("tippecanoe")
        if tippecanoe is None:
            print("ERROR: tippecanoe not found.")
            return

        print("Running tippecanoe...", flush=True)
        cmd = [
            tippecanoe,
            "-o", str(pmtiles_path),
            "-z", str(TILE_ZOOM),
            "-Z", str(TILE_ZOOM),  # single zoom level only
            "-l", "buildings",
            "--no-feature-limit",
            "--no-tile-size-limit",
            "--force",
            str(geojson_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  tippecanoe failed: {result.stderr}")
            return
        pm_size = pmtiles_path.stat().st_size / 1e6
        print(f"  PMTiles: {pm_size:.1f} MB")
        print()

        # Step 3: Extract individual z14 tiles from the PMTiles.
        print(f"Extracting z{TILE_ZOOM} tiles...", flush=True)
        tile_count = extract_tiles_from_pmtiles(pmtiles_path, TILES_DIR, TILE_ZOOM)

    # Stats.
    total_size = sum(f.stat().st_size for f in TILES_DIR.glob("*.pbf"))
    sizes = [f.stat().st_size for f in TILES_DIR.glob("*.pbf")]
    print(f"\nDone! {tile_count} tile files in {TILES_DIR}")
    print(f"  Total: {total_size / 1e6:.1f} MB")
    if sizes:
        print(f"  Average: {sum(sizes) / len(sizes) / 1024:.1f} KB")
        print(f"  Largest: {max(sizes) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
