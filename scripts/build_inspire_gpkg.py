"""Convert INSPIRE GML files into a single GeoPackage with spatial index.

This is a one-time conversion that makes match_plots.py fast for any area.
Reading 318 GML files individually is slow; a single GeoPackage with R-tree
gives instant bbox queries.

Usage:
    uv run python scripts/build_inspire_gpkg.py
"""

import time
from pathlib import Path

import fiona
from fiona.crs import CRS
from shapely.geometry import shape, mapping

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
INSPIRE_DIR = DATA_DIR / "inspire"
OUTPUT = DATA_DIR / "inspire.gpkg"

SCHEMA = {
    "geometry": "Polygon",
    "properties": {
        "inspire_id": "str",
    },
}


def main():
    gml_files = sorted(INSPIRE_DIR.glob("*.gml"))
    if not gml_files:
        print("No GML files found in data/inspire/")
        return

    print(f"Converting {len(gml_files)} GML files to GeoPackage...")
    print(f"Output: {OUTPUT}")
    print()

    tmp = OUTPUT.with_suffix(".gpkg.tmp")
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
        for i, gml_file in enumerate(gml_files, 1):
            name = gml_file.stem.replace("_", " ")
            file_count = 0
            try:
                with fiona.open(str(gml_file)) as src:
                    for feat in src:
                        geom = shape(feat["geometry"])
                        if geom.is_empty or not geom.is_valid:
                            continue
                        props = feat.get("properties", {})
                        inspire_id = props.get("INSPIREID", "") or props.get("inspireid", "") or ""
                        dst.write({
                            "geometry": mapping(geom),
                            "properties": {"inspire_id": inspire_id},
                        })
                        file_count += 1
                        total += 1
            except Exception as e:
                print(f"  [{i}/{len(gml_files)}] {name}: ERROR {e}")
                errors += 1
                continue

            if i % 25 == 0 or i == len(gml_files):
                elapsed = time.time() - t0
                rate = total / elapsed if elapsed > 0 else 0
                print(f"  [{i}/{len(gml_files)}] {total:,} parcels ({rate:.0f}/s)", flush=True)

    elapsed = time.time() - t0
    tmp.rename(OUTPUT)
    size_mb = OUTPUT.stat().st_size / 1e6
    print(f"\nDone in {elapsed:.0f}s")
    print(f"  {total:,} parcels, {size_mb:.0f} MB")
    print(f"  {errors} files with errors")
    print(f"  Saved to {OUTPUT}")


if __name__ == "__main__":
    main()
