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
INSPIRE_GPKG = DATA / "inspire.gpkg"
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


def load_parcels_near_pubs(pubs: list[dict]) -> tuple | None:
    """Load INSPIRE parcels near pubs from the GeoPackage (fast R-tree queries).

    Falls back to individual GML files if GeoPackage doesn't exist.
    Returns (STRtree, parcels_list) or None.
    """
    # Build pub points in OSGB.
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
    BUF = 50

    if INSPIRE_GPKG.exists():
        return _load_from_gpkg(pub_points_osgb, pub_tree, BUF)
    else:
        print(f"  WARNING: {INSPIRE_GPKG} not found. Run: uv run python scripts/build_inspire_gpkg.py")
        return None


def _load_from_gpkg(pub_points_osgb, pub_tree, buf):
    """Load parcels from the INSPIRE GeoPackage using R-tree spatial queries."""
    import sqlite3 as _sqlite3

    # Query parcels near each pub using the GeoPackage R-tree index.
    # Compute the union bbox of all pubs (with buffer) for a single query.
    pub_xs = [p.x for p in pub_points_osgb]
    pub_ys = [p.y for p in pub_points_osgb]
    min_x, max_x = min(pub_xs) - buf, max(pub_xs) + buf
    min_y, max_y = min(pub_ys) - buf, max(pub_ys) + buf
    print(f"  Querying INSPIRE GeoPackage for parcels in pub area...", flush=True)

    conn = _sqlite3.connect(str(INSPIRE_GPKG))

    # Use R-tree spatial index for fast bbox query.
    try:
        rows = conn.execute(
            "SELECT p.fid, p.geom FROM parcels p "
            "JOIN rtree_parcels_geom r ON p.fid = r.id "
            "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
            (min_x, max_x, min_y, max_y),
        ).fetchall()
    except _sqlite3.OperationalError:
        # No R-tree — fall back to full scan (slow).
        print("  WARNING: no R-tree index, falling back to full scan")
        rows = conn.execute("SELECT fid, geom FROM parcels").fetchall()
    conn.close()

    print(f"  {len(rows)} parcels in pub area bbox", flush=True)

    # Parse geometries and filter to those actually near a pub.
    parcels = []
    for fid, blob in rows:
        try:
            hl = gpkg_header_len(blob)
            geom = wkb.loads(blob[hl:])
            if geom.is_empty or not geom.is_valid:
                continue

            nearby = pub_tree.query(geom.buffer(buf))
            if len(nearby) == 0:
                continue

            prepare(geom)
            parcels.append(geom)
        except Exception:
            continue

    print(f"  {len(parcels)} parcels near pubs")
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
