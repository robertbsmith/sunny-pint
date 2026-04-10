"""Download Registers of Scotland INSPIRE cadastral parcels.

Downloads 33 county shapefiles from ros-inspire.themapcloud.com and
builds a scotland_parcels.gpkg with the same schema as inspire.gpkg
so match_plots can use it as a fallback for Scottish pubs.

Usage:
    uv run python scripts/download_inspire_scotland.py
"""

import shutil
import sqlite3
import struct
import time
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path

import fiona
from shapely.geometry import shape
from shapely import wkb

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SCOTLAND_DIR = DATA_DIR / "inspire_scotland"
OUT_PATH = DATA_DIR / "scotland_parcels.gpkg"

BASE_URL = "https://ros-inspire.themapcloud.com/maps/download/ros-cp.cadastralparcel"
REFERER = "https://ros-inspire.themapcloud.com/"

# All 33 Scottish registration counties.
COUNTIES = [
    "ABN", "ANG", "ARG", "AYR", "BNF", "BER", "BUT", "CTH", "CLK",
    "DMB", "DMF", "ELN", "FFE", "GLA", "INV", "KNC", "KNR", "KRK",
    "LAN", "MID", "MOR", "NRN", "OAZ", "PBL", "PTH", "REN", "ROS",
    "ROX", "SEL", "STG", "STH", "WLN", "WGN",
]

SRS_ID = 27700


def make_gpkg_blob(poly) -> tuple[bytes, float, float, float, float]:
    """Encode a shapely polygon as a GeoPackage geometry blob (OSGB)."""
    minx, miny, maxx, maxy = poly.bounds
    header = struct.pack("<2sBBI4d", b"GP", 0, 0x03, SRS_ID, minx, maxx, miny, maxy)
    body = wkb.dumps(poly, byte_order=1)
    return header + body, minx, maxx, miny, maxy


def download_county(code: str) -> Path | None:
    """Download a county shapefile ZIP. Returns path or None on failure."""
    zip_path = SCOTLAND_DIR / f"{code}.zip"
    if zip_path.exists() and zip_path.stat().st_size > 1000:
        return zip_path  # already downloaded

    url = f"{BASE_URL}/{code}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "SunnyPint/0.1 (+https://sunny-pint.co.uk)",
        "Referer": REFERER,
    })

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
        if len(data) < 1000:
            print(f"    {code}: too small ({len(data)} bytes), skipping")
            return None
        zip_path.write_bytes(data)
        return zip_path
    except Exception as e:
        print(f"    {code}: download failed: {e}")
        return None


def extract_shp_path(zip_path: Path) -> Path | None:
    """Extract the BNG shapefile from a county ZIP. Returns .shp path."""
    code = zip_path.stem
    extract_dir = SCOTLAND_DIR / code
    if extract_dir.exists():
        shp = extract_dir / f"{code}_bng.shp"
        if shp.exists():
            return shp

    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        # Extract only the BNG (OSGB) shapefile components.
        for name in z.namelist():
            if "_bng." in name:
                z.extract(name, extract_dir)

    shp = extract_dir / f"{code}_bng.shp"
    return shp if shp.exists() else None


def create_gpkg() -> sqlite3.Connection:
    """Create a fresh GeoPackage for Scottish parcels."""
    if OUT_PATH.exists():
        OUT_PATH.unlink()

    conn = sqlite3.connect(str(OUT_PATH))
    conn.executescript(f"""
        CREATE TABLE gpkg_spatial_ref_sys (
            srs_name TEXT, srs_id INTEGER PRIMARY KEY,
            organization TEXT, organization_coordsys_id INTEGER,
            definition TEXT, description TEXT
        );
        INSERT INTO gpkg_spatial_ref_sys VALUES
            ('OSGB 1936 / British National Grid', {SRS_ID},
             'EPSG', {SRS_ID},
             'PROJCS["OSGB 1936 / British National Grid"]', 'UK Ordnance Survey');

        CREATE TABLE gpkg_contents (
            table_name TEXT PRIMARY KEY, data_type TEXT,
            identifier TEXT, description TEXT,
            last_change TEXT, min_x REAL, min_y REAL,
            max_x REAL, max_y REAL, srs_id INTEGER
        );
        INSERT INTO gpkg_contents VALUES
            ('parcels', 'features', 'parcels',
             'ROS INSPIRE cadastral parcels for Scotland',
             datetime('now'), 0, 0, 700000, 1300000, {SRS_ID});

        CREATE TABLE gpkg_geometry_columns (
            table_name TEXT, column_name TEXT, geometry_type_name TEXT,
            srs_id INTEGER, z INTEGER, m INTEGER
        );
        INSERT INTO gpkg_geometry_columns VALUES
            ('parcels', 'geom', 'POLYGON', {SRS_ID}, 0, 0);

        CREATE TABLE parcels (
            fid INTEGER PRIMARY KEY AUTOINCREMENT,
            geom BLOB,
            local_authority TEXT
        );
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE rtree_parcels_geom USING rtree(
            id, minx, maxx, miny, maxy
        )
    """)
    conn.commit()
    return conn


def main():
    print("Downloading Scottish INSPIRE cadastral parcels")
    print(f"  {len(COUNTIES)} registration counties")
    print()

    SCOTLAND_DIR.mkdir(parents=True, exist_ok=True)

    # Phase 1: Download all county ZIPs.
    print("Phase 1: Downloading county shapefiles...")
    t0 = time.time()
    for i, code in enumerate(COUNTIES, 1):
        zip_path = download_county(code)
        status = f"{zip_path.stat().st_size / 1e6:.1f} MB" if zip_path else "FAILED"
        print(f"  [{i}/{len(COUNTIES)}] {code}: {status}")
        time.sleep(0.5)  # polite rate limit

    elapsed = time.time() - t0
    print(f"\n  Downloads done in {elapsed:.0f}s")

    # Phase 2: Build GeoPackage.
    print("\nPhase 2: Building scotland_parcels.gpkg...")
    conn = create_gpkg()
    total = 0
    t0 = time.time()
    BATCH = 5000

    for i, code in enumerate(COUNTIES, 1):
        zip_path = SCOTLAND_DIR / f"{code}.zip"
        if not zip_path.exists():
            continue

        shp_path = extract_shp_path(zip_path)
        if not shp_path:
            print(f"  {code}: no shapefile found, skipping")
            continue

        county_count = 0
        # County name from code for local_authority field.
        la_name = code  # Could map to full names but code is fine for matching.

        with fiona.open(str(shp_path)) as src:
            batch_data = []
            for feat in src:
                try:
                    geom = shape(feat["geometry"])
                    if geom.is_empty or not geom.is_valid:
                        continue
                    # Handle MultiPolygon — take largest.
                    if geom.geom_type == "MultiPolygon":
                        geom = max(geom.geoms, key=lambda g: g.area)
                    blob, minx, maxx, miny, maxy = make_gpkg_blob(geom)
                    batch_data.append((blob, la_name, minx, maxx, miny, maxy))
                    county_count += 1

                    if len(batch_data) >= BATCH:
                        _write_batch(conn, batch_data)
                        batch_data = []
                except Exception:
                    continue

            if batch_data:
                _write_batch(conn, batch_data)

        total += county_count
        elapsed = time.time() - t0
        print(f"  [{i}/{len(COUNTIES)}] {code}: {county_count:,} parcels ({total:,} total, {elapsed:.0f}s)")

    conn.commit()
    conn.close()

    elapsed = time.time() - t0
    size_mb = OUT_PATH.stat().st_size / 1e6
    print(f"\nDone! {total:,} parcels in {elapsed:.0f}s ({size_mb:.1f} MB)")
    print(f"  Saved to {OUT_PATH}")


def _write_batch(conn: sqlite3.Connection, batch: list):
    """Write a batch of parcels + R-tree entries."""
    for blob, la, minx, maxx, miny, maxy in batch:
        conn.execute("INSERT INTO parcels (geom, local_authority) VALUES (?, ?)", (blob, la))
        fid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            "INSERT INTO rtree_parcels_geom VALUES (?, ?, ?, ?, ?)",
            (fid, minx, maxx, miny, maxy),
        )
    conn.commit()


if __name__ == "__main__":
    main()
