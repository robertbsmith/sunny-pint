"""Fetch all building outlines in Norwich from OSM and rasterize to a
1m binary GeoTIFF matching the LiDAR grid."""

import json
import time
import urllib.request
import urllib.parse
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.features import rasterize
from pyproj import Transformer
from shapely.geometry import Polygon

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Match our LiDAR grid extent.
EASTING_MIN = 618000
EASTING_MAX = 628000
NORTHING_MIN = 303000
NORTHING_MAX = 313000

OUT = Path(__file__).resolve().parent.parent / "data" / "buildings.tif"
to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
to_wgs = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def fetch_tile(south, west, north, east):
    query = f"""
[out:json][timeout:60];
way["building"]({south:.4f},{west:.4f},{north:.4f},{east:.4f});
out geom;
"""
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data)
    req.add_header("User-Agent", "SunPub/0.1")
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read())


def to_osgb_polygon(geom_nodes):
    coords = []
    for node in geom_nodes:
        x, y = to_osgb.transform(node["lon"], node["lat"])
        coords.append((x, y))
    if len(coords) < 3:
        return None
    poly = Polygon(coords)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly if not poly.is_empty else None


def main():
    # Split the area into tiles for Overpass.
    # Convert LiDAR grid corners to WGS84.
    w_wgs, s_wgs = to_wgs.transform(EASTING_MIN, NORTHING_MIN)
    e_wgs, n_wgs = to_wgs.transform(EASTING_MAX, NORTHING_MAX)

    # ~2.5km tiles
    n_cols, n_rows = 4, 4
    lat_step = (n_wgs - s_wgs) / n_rows
    lng_step = (e_wgs - w_wgs) / n_cols

    all_shapes = []
    seen_ids = set()

    for row in range(n_rows):
        for col in range(n_cols):
            s = s_wgs + row * lat_step
            n = s_wgs + (row + 1) * lat_step
            w = w_wgs + col * lng_step
            e = w_wgs + (col + 1) * lng_step

            print(f"  Tile [{row},{col}] ({s:.3f},{w:.3f} - {n:.3f},{e:.3f}) ... ",
                  end="", flush=True)
            try:
                raw = fetch_tile(s, w, n, e)
                count = 0
                for el in raw.get("elements", []):
                    if el["id"] in seen_ids:
                        continue
                    seen_ids.add(el["id"])
                    if "geometry" not in el:
                        continue
                    poly = to_osgb_polygon(el["geometry"])
                    if poly:
                        all_shapes.append((poly, 1))
                        count += 1
                print(f"{count} buildings")
            except Exception as exc:
                print(f"error: {exc}")

            time.sleep(1)  # be nice to Overpass

    print(f"\nTotal: {len(all_shapes)} unique buildings")

    # Rasterize.
    width = EASTING_MAX - EASTING_MIN
    height = NORTHING_MAX - NORTHING_MIN
    transform = from_origin(EASTING_MIN, NORTHING_MAX, 1.0, 1.0)

    print(f"Rasterizing to {width}x{height} grid...")
    raster = rasterize(
        all_shapes,
        out_shape=(height, width),
        transform=transform,
        fill=0,
        dtype=np.uint8,
    )

    building_pixels = raster.sum()
    print(f"{building_pixels} building pixels ({100*building_pixels/(width*height):.1f}%)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        OUT, "w", driver="GTiff",
        height=height, width=width, count=1, dtype=np.uint8,
        crs="EPSG:27700", transform=transform, compress="deflate",
    ) as dst:
        dst.write(raster, 1)

    print(f"Saved {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
