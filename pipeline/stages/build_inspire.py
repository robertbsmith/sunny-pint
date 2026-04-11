"""Convert INSPIRE GML files into a single GeoPackage with spatial index.

This is a one-time conversion that makes match_plots.py fast for any area.
Reading 318 GML files individually is slow; a single GeoPackage with R-tree
gives instant bbox queries.

The INSPIRE GML files are uniform: each `wfs:member` wraps an `LR:PREDEFINED`
element with one `gml:Polygon` (single exterior ring, optional interiors) and
an `LR:INSPIREID`. We stream-parse with stdlib `xml.etree.iterparse` and write
features directly via the `sqlite3` module — fiona/GDAL chokes on multi-GB
GeoPackage writes (transaction state goes bad late in the run with
"attempt to write a readonly database"), so we manage the schema and bulk
inserts ourselves.

Usage:
    uv run --project scripts python scripts/build_inspire_gpkg.py
"""

import sqlite3
import struct
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from shapely import wkb
from shapely.geometry import Polygon

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
INSPIRE_DIR = DATA_DIR / "inspire"
OUTPUT = DATA_DIR / "inspire.gpkg"

# INSPIRE GML namespaces (LR has no scheme prefix — that's how Land Registry ships them).
NS_LR = "www.landregistry.gov.uk"
NS_GML = "http://www.opengis.net/gml/3.2"

TAG_PREDEFINED = f"{{{NS_LR}}}PREDEFINED"
TAG_INSPIREID = f"{{{NS_LR}}}INSPIREID"
TAG_POLYGON = f"{{{NS_GML}}}Polygon"
TAG_EXTERIOR = f"{{{NS_GML}}}exterior"
TAG_INTERIOR = f"{{{NS_GML}}}interior"
TAG_POSLIST = f"{{{NS_GML}}}posList"

SRS_ID = 27700  # OSGB 1936 / British National Grid
BATCH_SIZE = 20_000

# ── GPKG geometry encoding ────────────────────────────────────────────────


def make_gpkg_blob(poly: Polygon) -> tuple[bytes, float, float, float, float]:
    """Encode a shapely Polygon as a GPKG geometry blob and return its bbox.

    GPKG header layout (little-endian, envelope type 1 = xy):
        2s  magic 'GP'
        B   version (0)
        B   flags (0x03 = LE byte order + xy envelope)
        I   srs_id
        4d  envelope minx, maxx, miny, maxy
    Total header = 40 bytes, followed by WKB.
    """
    minx, miny, maxx, maxy = poly.bounds
    header = struct.pack("<2sBBI4d", b"GP", 0, 0x03, SRS_ID, minx, maxx, miny, maxy)
    body = wkb.dumps(poly, byte_order=1)
    return header + body, minx, maxx, miny, maxy


# ── GPKG schema bootstrap ─────────────────────────────────────────────────

# Minimal WKT for EPSG:27700 — a placeholder is fine because match_plots.py
# only reads the geometry blobs, not the SRS definition.
_WKT_27700 = (
    'PROJCS["OSGB 1936 / British National Grid",'
    'GEOGCS["OSGB 1936",DATUM["OSGB_1936",SPHEROID["Airy 1830",6377563.396,299.3249646]],'
    "PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]],"
    'PROJECTION["Transverse_Mercator"],'
    'PARAMETER["latitude_of_origin",49],PARAMETER["central_meridian",-2],'
    'PARAMETER["scale_factor",0.9996012717],'
    'PARAMETER["false_easting",400000],PARAMETER["false_northing",-100000],'
    'UNIT["metre",1],AUTHORITY["EPSG","27700"]]'
)

GPKG_BOOTSTRAP_SQL = f"""
PRAGMA application_id = 1196444487;  -- 'GPKG' big-endian
PRAGMA user_version   = 10300;        -- GeoPackage 1.3

CREATE TABLE gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL PRIMARY KEY,
    organization TEXT NOT NULL,
    organization_coordsys_id INTEGER NOT NULL,
    definition TEXT NOT NULL,
    description TEXT
);

INSERT INTO gpkg_spatial_ref_sys VALUES
    ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian'),
    ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic'),
    ('British National Grid', {SRS_ID}, 'EPSG', {SRS_ID}, '{_WKT_27700}', 'OSGB 1936 / British National Grid');

CREATE TABLE gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY,
    data_type TEXT NOT NULL,
    identifier TEXT UNIQUE,
    description TEXT DEFAULT '',
    last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    min_x DOUBLE,
    min_y DOUBLE,
    max_x DOUBLE,
    max_y DOUBLE,
    srs_id INTEGER,
    CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
);

CREATE TABLE gpkg_geometry_columns (
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    geometry_type_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL,
    z TINYINT NOT NULL,
    m TINYINT NOT NULL,
    CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
    CONSTRAINT uk_gc_table_name UNIQUE (table_name),
    CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
    CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id)
);

CREATE TABLE parcels (
    fid INTEGER PRIMARY KEY AUTOINCREMENT,
    geom BLOB,
    inspire_id TEXT,
    local_authority TEXT
);

INSERT INTO gpkg_contents (table_name, data_type, identifier, srs_id)
    VALUES ('parcels', 'features', 'parcels', {SRS_ID});

INSERT INTO gpkg_geometry_columns VALUES ('parcels', 'geom', 'POLYGON', {SRS_ID}, 0, 0);

CREATE VIRTUAL TABLE rtree_parcels_geom USING rtree(id, minx, maxx, miny, maxy);
"""


def init_gpkg(path: Path) -> sqlite3.Connection:
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(str(path))
    conn.executescript(GPKG_BOOTSTRAP_SQL)
    # Speed pragmas — safe because we trash the file on failure anyway.
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA journal_mode = MEMORY")
    conn.execute("PRAGMA cache_size = -200000")  # ~200 MB page cache
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.commit()
    return conn


# ── GML parsing ───────────────────────────────────────────────────────────


def parse_poslist(text: str) -> list[tuple[float, float]]:
    """Parse a `gml:posList` text node ("x1 y1 x2 y2 ...") into [(x, y), ...]."""
    parts = text.split()
    return [(float(parts[i]), float(parts[i + 1])) for i in range(0, len(parts), 2)]


def iter_features(gml_path: Path):
    """Stream `(inspire_id, polygon)` tuples from one GML file."""
    context = ET.iterparse(str(gml_path), events=("end",))
    for _, elem in context:
        if elem.tag != TAG_PREDEFINED:
            continue

        inspire_id = ""
        id_el = elem.find(TAG_INSPIREID)
        if id_el is not None and id_el.text:
            inspire_id = id_el.text

        polygon_el = elem.find(f".//{TAG_POLYGON}")
        if polygon_el is None:
            elem.clear()
            continue

        exterior = None
        interiors: list[list[tuple[float, float]]] = []
        for ring_parent in polygon_el:
            poslist_el = ring_parent.find(f".//{TAG_POSLIST}")
            if poslist_el is None or not poslist_el.text:
                continue
            coords = parse_poslist(poslist_el.text)
            if ring_parent.tag == TAG_EXTERIOR:
                exterior = coords
            elif ring_parent.tag == TAG_INTERIOR:
                interiors.append(coords)

        elem.clear()  # Drop parsed element to keep memory bounded.

        if not exterior or len(exterior) < 4:
            continue
        try:
            poly = Polygon(exterior, interiors)
        except Exception:
            continue
        if poly.is_empty or not poly.is_valid:
            continue
        yield inspire_id, poly


# ── Main ──────────────────────────────────────────────────────────────────


def main() -> None:
    gml_files = sorted(INSPIRE_DIR.glob("*.gml"))
    if not gml_files:
        print("No GML files found in data/inspire/")
        return

    print(f"Converting {len(gml_files)} GML files to GeoPackage...")
    print(f"Output: {OUTPUT}")
    print()

    tmp = OUTPUT.with_suffix(".gpkg.tmp")
    conn = init_gpkg(tmp)

    insert_parcel = (
        "INSERT INTO parcels (fid, geom, inspire_id, local_authority) VALUES (?, ?, ?, ?)"
    )
    insert_rtree = "INSERT INTO rtree_parcels_geom (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)"

    t0 = time.time()
    total = 0
    errors = 0
    fid = 0
    parcel_batch: list[tuple[int, bytes, str, str]] = []
    rtree_batch: list[tuple[int, float, float, float, float]] = []
    overall_minx = overall_miny = float("inf")
    overall_maxx = overall_maxy = float("-inf")

    def flush() -> None:
        if not parcel_batch:
            return
        conn.executemany(insert_parcel, parcel_batch)
        conn.executemany(insert_rtree, rtree_batch)
        conn.commit()
        parcel_batch.clear()
        rtree_batch.clear()

    try:
        for i, gml_file in enumerate(gml_files, 1):
            # The GML filename is the only place the local authority is recorded.
            # "Norwich_City_Council.gml" → "Norwich City Council". This is what
            # match_plots.py reads back to derive locality for SEO landing pages.
            local_authority = gml_file.stem.replace("_", " ")
            try:
                for inspire_id, poly in iter_features(gml_file):
                    fid += 1
                    blob, minx, maxx, miny, maxy = make_gpkg_blob(poly)
                    parcel_batch.append((fid, blob, inspire_id, local_authority))
                    rtree_batch.append((fid, minx, maxx, miny, maxy))
                    if minx < overall_minx:
                        overall_minx = minx
                    if miny < overall_miny:
                        overall_miny = miny
                    if maxx > overall_maxx:
                        overall_maxx = maxx
                    if maxy > overall_maxy:
                        overall_maxy = maxy
                    total += 1
                    if len(parcel_batch) >= BATCH_SIZE:
                        flush()
            except ET.ParseError as e:
                print(f"  [{i}/{len(gml_files)}] {gml_file.stem}: PARSE ERROR {e}")
                errors += 1
                continue
            except Exception as e:
                print(f"  [{i}/{len(gml_files)}] {gml_file.stem}: ERROR {e}")
                errors += 1
                continue

            if i % 25 == 0 or i == len(gml_files):
                elapsed = time.time() - t0
                rate = total / elapsed if elapsed > 0 else 0
                eta = (len(gml_files) - i) * elapsed / i if i > 0 else 0
                print(
                    f"  [{i}/{len(gml_files)}] {total:,} parcels "
                    f"({rate:,.0f}/s, {elapsed:.0f}s elapsed, ~{eta:.0f}s left)",
                    flush=True,
                )

        flush()

        # Update bbox in gpkg_contents now that we know the dataset extent.
        if total > 0:
            conn.execute(
                "UPDATE gpkg_contents SET min_x=?, min_y=?, max_x=?, max_y=? WHERE table_name='parcels'",
                (overall_minx, overall_miny, overall_maxx, overall_maxy),
            )
            conn.commit()
    finally:
        conn.close()

    elapsed = time.time() - t0
    tmp.rename(OUTPUT)
    size_mb = OUTPUT.stat().st_size / 1e6
    print(f"\nDone in {elapsed:.0f}s")
    print(f"  {total:,} parcels, {size_mb:.0f} MB")
    print(f"  {errors} files with errors")
    print(f"  Saved to {OUTPUT}")


if __name__ == "__main__":
    main()
