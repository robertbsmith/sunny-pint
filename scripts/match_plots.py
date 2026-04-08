"""Match pubs to Land Registry INSPIRE plots and compute outdoor areas.

For each pub, finds the cadastral parcel containing it, then subtracts
all building footprints (from OSM GeoPackage) to get the outdoor area polygon.

Runs after merge_pubs.py — enriches data/pubs_merged.json with plot/outdoor
fields, then copies result to public/data/pubs.json.

Usage:
    uv run python scripts/match_plots.py --area norwich
"""

import json
import sqlite3
from pathlib import Path

import fiona
from pyproj import Transformer
from shapely.geometry import shape, Point, Polygon
from shapely.geometry import Point as ShapelyPoint
from shapely import prepare, wkb
from shapely.ops import unary_union
from shapely.strtree import STRtree

from areas import parse_area, in_bbox

DATA = Path(__file__).resolve().parent.parent / "data"
PUBS_IN = DATA / "pubs_merged.json"
PUBS_OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "pubs.json"
INSPIRE_DIR = DATA / "inspire"
GPKG_PATH = DATA / "buildings.gpkg"

to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
to_wgs = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def gpkg_header_len(blob: bytes) -> int:
    if len(blob) < 8:
        return 0
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_type, 0)


def load_buildings_osgb(area):
    """Load building polygons from GeoPackage, converted to OSGB, with spatial index."""
    if not GPKG_PATH.exists():
        print(f"  WARNING: {GPKG_PATH} not found — can't subtract buildings from plots")
        return [], None

    conn = sqlite3.connect(str(GPKG_PATH))
    rows = conn.execute("SELECT geom FROM buildings").fetchall()
    conn.close()

    buildings = []
    for (blob,) in rows:
        try:
            hl = gpkg_header_len(blob)
            geom = wkb.loads(blob[hl:])
            if geom.is_empty or not geom.is_valid:
                continue
            centroid = geom.centroid
            if not in_bbox(centroid.y, centroid.x, area.bbox):
                continue
            # Convert WGS84 polygon to OSGB.
            osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
            poly = Polygon(osgb_coords)
            if poly.is_valid and not poly.is_empty:
                buildings.append(poly)
        except Exception:
            continue

    tree = STRtree(buildings) if buildings else None
    print(f"  {len(buildings)} buildings loaded for plot subtraction")
    return buildings, tree


def osgb_to_wgs_rings(geom):
    """Convert a shapely polygon from OSGB to WGS84 as [exterior, ...holes].

    Each ring is [[lat,lng], ...]. First ring is exterior, rest are holes.
    """
    rings = []
    # Exterior ring.
    exterior = []
    for x, y in geom.exterior.coords:
        lng, lat = to_wgs.transform(x, y)
        exterior.append([round(lat, 6), round(lng, 6)])
    rings.append(exterior)
    # Interior rings (holes from subtracted buildings).
    for interior in geom.interiors:
        hole = []
        for x, y in interior.coords:
            lng, lat = to_wgs.transform(x, y)
            hole.append([round(lat, 6), round(lng, 6)])
        rings.append(hole)
    return rings


def load_parcels_near_pubs(pubs: list[dict]) -> STRtree | None:
    """Load INSPIRE parcels from individual GML files, filtered to those near pubs.

    Returns an STRtree spatial index of parcels, or None if no GML files found.
    """
    gml_files = sorted(INSPIRE_DIR.glob("*.gml"))
    if not gml_files:
        print(f"  WARNING: no GML files in {INSPIRE_DIR} — skipping plot matching")
        print(f"  Run: uv run python scripts/download_inspire.py")
        return None

    # Build a set of pub points in OSGB for fast proximity checking.
    pub_points_osgb = []
    for pub in pubs:
        if pub.get("polygon") and len(pub["polygon"]) > 2:
            clat = sum(c[0] for c in pub["polygon"]) / len(pub["polygon"])
            clng = sum(c[1] for c in pub["polygon"]) / len(pub["polygon"])
        else:
            clat, clng = pub["lat"], pub["lng"]
        x, y = to_osgb.transform(clng, clat)
        pub_points_osgb.append(ShapelyPoint(x, y))

    pub_tree = STRtree(pub_points_osgb)

    # Buffer distance: 50m should catch the parcel containing any pub.
    BUF = 50

    parcels = []
    total_loaded = 0
    total_kept = 0

    for i, gml_file in enumerate(gml_files, 1):
        name = gml_file.stem.replace("_", " ")
        try:
            with fiona.open(str(gml_file)) as src:
                file_count = 0
                kept = 0
                for feat in src:
                    geom = shape(feat["geometry"])
                    if geom.is_empty or not geom.is_valid:
                        continue
                    file_count += 1

                    # Only keep parcels near a pub.
                    nearby = pub_tree.query(geom.buffer(BUF))
                    if len(nearby) == 0:
                        continue

                    prepare(geom)
                    parcels.append(geom)
                    kept += 1

                total_loaded += file_count
                total_kept += kept
        except Exception as e:
            print(f"  [{i}/{len(gml_files)}] {name}: ERROR {e}")
            continue

        if i % 25 == 0 or i == len(gml_files):
            print(f"  [{i}/{len(gml_files)}] {total_kept} parcels near pubs (of {total_loaded} total)", flush=True)

    print(f"  {total_kept} parcels near pubs from {len(gml_files)} files")
    if not parcels:
        return None

    return STRtree(parcels), parcels


def building_polygon_osgb(pub):
    """Convert a pub's OSM building polygon to OSGB shapely geometry."""
    if not pub.get("polygon"):
        return None
    coords = []
    for lat, lng in pub["polygon"]:
        x, y = to_osgb.transform(lng, lat)
        coords.append((x, y))
    poly = Polygon(coords)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly


def main():
    area = parse_area()
    print(f"Matching plots for {area.name}")

    if not PUBS_IN.exists():
        print(f"ERROR: {PUBS_IN} not found. Run merge_pubs.py first.")
        return

    pubs = json.loads(PUBS_IN.read_text())
    print(f"  {len(pubs)} pubs loaded")

    result = load_parcels_near_pubs(pubs)

    if result:
        parcel_tree, all_parcels = result

        # Load all buildings for subtracting from plots.
        all_buildings, building_tree = load_buildings_osgb(area)

        matched = 0
        outdoor_computed = 0

        for pi, pub in enumerate(pubs):
            if not in_bbox(pub["lat"], pub["lng"], area.bbox):
                continue

            if pub.get("polygon") and len(pub["polygon"]) > 2:
                clat = sum(c[0] for c in pub["polygon"]) / len(pub["polygon"])
                clng = sum(c[1] for c in pub["polygon"]) / len(pub["polygon"])
                px, py = to_osgb.transform(clng, clat)
            else:
                px, py = to_osgb.transform(pub["lng"], pub["lat"])
            pt = Point(px, py)

            # Find containing parcel via spatial index.
            candidates = parcel_tree.query(pt)
            parcel = None
            for idx in candidates:
                if all_parcels[idx].contains(pt):
                    parcel = all_parcels[idx]
                    break

            if parcel is None:
                continue

            matched += 1
            pub["plot"] = osgb_to_wgs_rings(parcel)[0]

            # Subtract ALL buildings that intersect this parcel.
            if building_tree:
                hit_idxs = building_tree.query(parcel)
                overlapping = [all_buildings[i] for i in hit_idxs if all_buildings[i].intersects(parcel)]
            else:
                overlapping = []

            if not overlapping:
                b = building_polygon_osgb(pub)
                if b and b.is_valid and not b.is_empty:
                    overlapping = [b]

            if not overlapping:
                continue

            buildings_union = unary_union(overlapping)
            outdoor = parcel.difference(buildings_union)
            if not outdoor.is_empty:
                if outdoor.geom_type == "MultiPolygon":
                    outdoor = max(outdoor.geoms, key=lambda g: g.area)
                pub["outdoor"] = osgb_to_wgs_rings(outdoor)
                pub["outdoor_area_m2"] = round(outdoor.area, 1)
                outdoor_computed += 1

            if (pi + 1) % 5000 == 0:
                print(f"  {pi + 1}/{len(pubs)} pubs processed, {matched} matched...", flush=True)

        print(f"\n  {matched}/{len(pubs)} pubs matched to a plot")
        print(f"  {outdoor_computed} outdoor areas computed (plot minus all buildings)")
    else:
        print("  No parcels — skipping plot matching")

    # Write to public/data/pubs.json — strip polygon (replaced with centroid) to save bandwidth.
    PUBS_OUT.parent.mkdir(parents=True, exist_ok=True)
    output_pubs = []
    for pub in pubs:
        out = dict(pub)
        # Replace full polygon with centroid for the public file.
        if "polygon" in out and out["polygon"] and len(out["polygon"]) > 2:
            out["clat"] = round(sum(c[0] for c in out["polygon"]) / len(out["polygon"]), 6)
            out["clng"] = round(sum(c[1] for c in out["polygon"]) / len(out["polygon"]), 6)
        # Remove plot (only used during pipeline) and polygon from public output.
        out.pop("polygon", None)
        out.pop("plot", None)
        output_pubs.append(out)
    PUBS_OUT.write_text(json.dumps(output_pubs))
    size_mb = PUBS_OUT.stat().st_size / 1e6
    print(f"  Written to {PUBS_OUT} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
