"""Convert INSPIRE GML files into a single GeoPackage with spatial index.

This is a one-time conversion that makes match_plots.py fast for any area.
Reading 318 GML files individually is slow; a single GeoPackage with R-tree
gives instant bbox queries.

The INSPIRE GML files are uniform: each `wfs:member` wraps an `LR:PREDEFINED`
element with one `gml:Polygon` (single exterior ring, optional interiors) and
an `LR:INSPIREID`. We stream-parse with stdlib `xml.etree.iterparse` and write
batches of WKB features via fiona — much faster than going through GDAL OGR's
GML driver per file.

Usage:
    uv run python scripts/build_inspire_gpkg.py
"""

import time
import xml.etree.ElementTree as ET
from pathlib import Path

import fiona
from fiona.crs import CRS
from shapely.geometry import Polygon, mapping

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
INSPIRE_DIR = DATA_DIR / "inspire"
OUTPUT = DATA_DIR / "inspire.gpkg"

SCHEMA = {
    "geometry": "Polygon",
    "properties": {
        "inspire_id": "str",
    },
}

# INSPIRE GML namespaces (LR has no scheme prefix — that's how Land Registry ships them).
NS_LR = "www.landregistry.gov.uk"
NS_GML = "http://www.opengis.net/gml/3.2"

TAG_PREDEFINED = f"{{{NS_LR}}}PREDEFINED"
TAG_INSPIREID = f"{{{NS_LR}}}INSPIREID"
TAG_POLYGON = f"{{{NS_GML}}}Polygon"
TAG_EXTERIOR = f"{{{NS_GML}}}exterior"
TAG_INTERIOR = f"{{{NS_GML}}}interior"
TAG_POSLIST = f"{{{NS_GML}}}posList"

BATCH_SIZE = 10_000


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

        # The Polygon may sit a few levels deep under LR:GEOMETRY.
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


def main() -> None:
    gml_files = sorted(INSPIRE_DIR.glob("*.gml"))
    if not gml_files:
        print("No GML files found in data/inspire/")
        return

    print(f"Converting {len(gml_files)} GML files to GeoPackage...")
    print(f"Output: {OUTPUT}")
    print()

    tmp = OUTPUT.with_suffix(".gpkg.tmp")
    if tmp.exists():
        tmp.unlink()

    t0 = time.time()
    total = 0
    errors = 0

    with fiona.open(
        str(tmp), "w",
        driver="GPKG",
        schema=SCHEMA,
        crs=CRS.from_epsg(27700),
        layer="parcels",
    ) as dst:
        batch: list[dict] = []
        for i, gml_file in enumerate(gml_files, 1):
            try:
                for inspire_id, poly in iter_features(gml_file):
                    batch.append({
                        "geometry": mapping(poly),
                        "properties": {"inspire_id": inspire_id},
                    })
                    total += 1
                    if len(batch) >= BATCH_SIZE:
                        dst.writerecords(batch)
                        batch.clear()
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

        if batch:
            dst.writerecords(batch)

    elapsed = time.time() - t0
    tmp.rename(OUTPUT)
    size_mb = OUTPUT.stat().st_size / 1e6
    print(f"\nDone in {elapsed:.0f}s")
    print(f"  {total:,} parcels, {size_mb:.0f} MB")
    print(f"  {errors} files with errors")
    print(f"  Saved to {OUTPUT}")


if __name__ == "__main__":
    main()
