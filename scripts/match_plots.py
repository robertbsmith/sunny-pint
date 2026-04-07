"""Match pubs to Land Registry INSPIRE plots and compute outdoor areas.

For each pub, finds the cadastral parcel containing it, then subtracts
the building footprint (from OSM) to get the outdoor area polygon.
Writes enriched pub data back to data/pubs.json.
"""

import json
from pathlib import Path

import fiona
from pyproj import Transformer
from shapely.geometry import shape, mapping, Point
from shapely.ops import unary_union
from shapely import prepare

DATA = Path(__file__).resolve().parent.parent / "data"
PUBS_FILE = DATA / "pubs.json"
GML_FILE = DATA / "inspire" / "Land_Registry_Cadastral_Parcels.gml"

to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
to_wgs = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def osgb_to_wgs_polygon(geom):
    """Convert a shapely polygon from OSGB to WGS84 as [[lat,lng], ...]."""
    coords = []
    for x, y in geom.exterior.coords:
        lng, lat = to_wgs.transform(x, y)
        coords.append([lat, lng])
    return coords


def load_parcels():
    """Load all INSPIRE parcels into a list of (shapely_geom, props)."""
    print(f"Loading parcels from {GML_FILE} ...")
    parcels = []
    with fiona.open(str(GML_FILE)) as src:
        for feat in src:
            geom = shape(feat["geometry"])
            if geom.is_valid and not geom.is_empty:
                prepare(geom)
                parcels.append(geom)
    print(f"  Loaded {len(parcels)} parcels")
    return parcels


def find_containing_parcel(point_osgb, parcels):
    """Find the parcel containing a point. Returns shapely geom or None."""
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
    from shapely.geometry import Polygon
    poly = Polygon(coords)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly


def main():
    pubs = json.loads(PUBS_FILE.read_text())
    parcels = load_parcels()

    matched = 0
    outdoor_computed = 0

    for pub in pubs:
        # Convert pub location to OSGB.
        px, py = to_osgb.transform(pub["lng"], pub["lat"])
        pt = Point(px, py)

        parcel = find_containing_parcel(pt, parcels)
        if parcel is None:
            pub["plot"] = None
            pub["outdoor"] = None
            continue

        matched += 1
        pub["plot"] = osgb_to_wgs_polygon(parcel)

        # Compute outdoor area = plot minus building.
        building = building_polygon_osgb(pub)
        if building and building.is_valid and not building.is_empty:
            outdoor = parcel.difference(building)
            if not outdoor.is_empty:
                # Take the largest polygon if it's a MultiPolygon.
                if outdoor.geom_type == "MultiPolygon":
                    outdoor = max(outdoor.geoms, key=lambda g: g.area)
                pub["outdoor"] = osgb_to_wgs_polygon(outdoor)
                pub["outdoor_area_m2"] = round(outdoor.area, 1)
                outdoor_computed += 1
            else:
                pub["outdoor"] = None
        else:
            # No building polygon — use the full plot as outdoor approximation.
            pub["outdoor"] = pub["plot"]

    print(f"\nResults:")
    print(f"  {matched}/{len(pubs)} pubs matched to a plot")
    print(f"  {outdoor_computed} outdoor areas computed (plot minus building)")

    PUBS_FILE.write_text(json.dumps(pubs, indent=2))
    print(f"  Updated {PUBS_FILE}")


if __name__ == "__main__":
    main()
