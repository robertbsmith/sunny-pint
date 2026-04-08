"""Match pubs to Land Registry INSPIRE plots and compute outdoor areas.

For each pub, finds the cadastral parcel containing it, then subtracts
the building footprint (from OSM) to get the outdoor area polygon.

Runs after merge_pubs.py — enriches data/pubs_merged.json with plot/outdoor
fields, then copies result to public/data/pubs.json.

Usage:
    uv run python scripts/match_plots.py --area norwich
"""

import json
import shutil
from pathlib import Path

import fiona
from pyproj import Transformer
from shapely.geometry import shape, Point, Polygon
from shapely import prepare

from areas import parse_area, in_bbox

DATA = Path(__file__).resolve().parent.parent / "data"
PUBS_IN = DATA / "pubs_merged.json"
PUBS_OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "pubs.json"
GML_FILE = DATA / "inspire" / "Land_Registry_Cadastral_Parcels.gml"

to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
to_wgs = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def osgb_to_wgs_polygon(geom):
    """Convert a shapely polygon from OSGB to WGS84 as [[lat,lng], ...]."""
    coords = []
    for x, y in geom.exterior.coords:
        lng, lat = to_wgs.transform(x, y)
        coords.append([round(lat, 6), round(lng, 6)])
    return coords


def load_parcels():
    """Load all INSPIRE parcels into a list of prepared shapely geometries."""
    if not GML_FILE.exists():
        print(f"  WARNING: {GML_FILE} not found — skipping plot matching")
        print(f"  Download from: https://use-land-property-data.service.gov.uk/datasets/inspire")
        return []

    print(f"  Loading parcels from {GML_FILE.name}...", flush=True)
    parcels = []
    with fiona.open(str(GML_FILE)) as src:
        for feat in src:
            geom = shape(feat["geometry"])
            if geom.is_valid and not geom.is_empty:
                prepare(geom)
                parcels.append(geom)
    print(f"  {len(parcels)} parcels loaded")
    return parcels


def find_containing_parcel(point_osgb, parcels):
    """Find the parcel containing a point."""
    for parcel in parcels:
        if parcel.contains(point_osgb):
            return parcel
    return None


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

    parcels = load_parcels()

    if parcels:
        matched = 0
        outdoor_computed = 0

        for pub in pubs:
            if not in_bbox(pub["lat"], pub["lng"], area.bbox):
                continue

            # Use OSM polygon centroid if available (more accurate than FSA geocode).
            if pub.get("polygon") and len(pub["polygon"]) > 2:
                clat = sum(c[0] for c in pub["polygon"]) / len(pub["polygon"])
                clng = sum(c[1] for c in pub["polygon"]) / len(pub["polygon"])
                px, py = to_osgb.transform(clng, clat)
            else:
                px, py = to_osgb.transform(pub["lng"], pub["lat"])
            pt = Point(px, py)

            parcel = find_containing_parcel(pt, parcels)
            if parcel is None:
                continue

            # Only useful if we have a building to subtract from the parcel.
            building = building_polygon_osgb(pub)
            if not building or not building.is_valid or building.is_empty:
                continue

            matched += 1
            pub["plot"] = osgb_to_wgs_polygon(parcel)

            outdoor = parcel.difference(building)
            if not outdoor.is_empty:
                if outdoor.geom_type == "MultiPolygon":
                    outdoor = max(outdoor.geoms, key=lambda g: g.area)
                pub["outdoor"] = osgb_to_wgs_polygon(outdoor)
                pub["outdoor_area_m2"] = round(outdoor.area, 1)
                outdoor_computed += 1

        print(f"\n  {matched}/{len(pubs)} pubs matched to a plot")
        print(f"  {outdoor_computed} outdoor areas computed (plot minus building)")
    else:
        print("  No parcels — skipping plot matching")

    # Write enriched data to public/data/pubs.json.
    PUBS_OUT.parent.mkdir(parents=True, exist_ok=True)
    PUBS_OUT.write_text(json.dumps(pubs, indent=2))
    print(f"  Written to {PUBS_OUT}")


if __name__ == "__main__":
    main()
