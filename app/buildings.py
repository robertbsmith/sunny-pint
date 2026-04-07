"""Query building outlines from a local GeoPackage (spatial-indexed SQLite)."""

import sqlite3
from functools import lru_cache
from pathlib import Path

import numpy as np
from pyproj import Transformer
from rasterio.features import rasterize
from shapely.geometry import Polygon
from shapely import wkb

GPKG_PATH = Path("data/buildings.gpkg")
to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

# Keep a single connection open (SQLite is fine with this for reads).
_conn = None


def _get_conn():
    global _conn
    if _conn is None and GPKG_PATH.exists():
        _conn = sqlite3.connect(str(GPKG_PATH))
    return _conn


def _query_buildings(south, west, north, east):
    """Query buildings from the GeoPackage using the R-tree spatial index."""
    conn = _get_conn()
    if conn is None:
        return [], []

    rows = conn.execute("""
        SELECT fid, geom FROM buildings
        WHERE fid IN (
            SELECT id FROM rtree_buildings_geom
            WHERE minx <= ? AND maxx >= ?
            AND miny <= ? AND maxy >= ?
        )
    """, (east, west, north, south)).fetchall()

    osgb_polys = []
    wgs_polys = []

    for fid, geom_blob in rows:
        try:
            # GeoPackage stores geometry as GeoPackage Binary.
            # Parse with shapely via wkb (skip the GPKG header).
            gpkg_header_len = _gpkg_header_len(geom_blob)
            wkb_data = geom_blob[gpkg_header_len:]
            geom = wkb.loads(wkb_data)

            if geom.is_empty or not geom.is_valid:
                continue

            # WGS-84 coords for frontend.
            wgs_coords = [[lat, lon] for lon, lat in geom.exterior.coords]
            wgs_polys.append(wgs_coords)

            # OSGB coords for rasterization.
            osgb_coords = [to_osgb.transform(lon, lat)
                           for lon, lat in geom.exterior.coords]
            osgb_poly = Polygon(osgb_coords)
            if osgb_poly.is_valid and not osgb_poly.is_empty:
                osgb_polys.append(osgb_poly)
            else:
                wgs_polys.pop()  # keep lists in sync
        except Exception:
            continue

    return osgb_polys, wgs_polys


def _gpkg_header_len(blob):
    """Parse GeoPackage Binary header to find where WKB starts."""
    if len(blob) < 8:
        return 0
    # Bytes 0-1: magic "GP"
    # Byte 2: version
    # Byte 3: flags
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    # Envelope sizes: 0=none, 1=xy(32B), 2=xyz(48B), 3=xym(48B), 4=xyzm(64B)
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_type, 0)


@lru_cache(maxsize=128)
def _cached_query(key):
    return _query_buildings(*key)


def get_buildings(south, west, north, east, transform, shape):
    """Get buildings for a WGS-84 bbox.

    Returns (raster_mask, osgb_polygons, wgs_polygons).
    """
    key = (
        round(south - 0.001, 4),
        round(west - 0.001, 4),
        round(north + 0.001, 4),
        round(east + 0.001, 4),
    )
    osgb_polys, wgs_polys = _cached_query(key)

    if not osgb_polys:
        return np.zeros(shape, dtype=bool), [], wgs_polys

    shapes = [(p, 1) for p in osgb_polys]
    mask = rasterize(
        shapes, out_shape=shape, transform=transform,
        fill=0, dtype=np.uint8,
    )
    return mask.astype(bool), osgb_polys, wgs_polys


def get_building_data(lat, lng, radius_m, lidar_manager, min_height=6.0):
    """Get building polygons with heights for a circular area.

    Returns (wgs_polygons, heights) where each entry is a building.
    Heights are sampled from LiDAR DSM (90th percentile within footprint).
    """
    import math

    dlat = (radius_m + 200) / 111320.0  # extra buffer for shadow sources
    dlng = (radius_m + 200) / (111320.0 * math.cos(math.radians(lat)))
    south, north = lat - dlat, lat + dlat
    west, east = lng - dlng, lng + dlng

    # Get DSM for height sampling.
    ow, os_ = to_osgb.transform(west, south)
    oe, on = to_osgb.transform(east, north)
    dsm, tfm = lidar_manager._read_area(ow, os_, oe, on)

    # Get buildings.
    if dsm is not None:
        _, osgb_polys, wgs_polys = get_buildings(
            south, west, north, east, tfm, dsm.shape
        )
    else:
        key = (
            round(south - 0.001, 4),
            round(west - 0.001, 4),
            round(north + 0.001, 4),
            round(east + 0.001, 4),
        )
        osgb_polys, wgs_polys = _cached_query(key)

    if not osgb_polys or dsm is None:
        # No LiDAR — return buildings with default height.
        return wgs_polys, [8.0] * len(wgs_polys)

    # Sample height per building from DSM.
    from .shadow import _local_min
    ground = _local_min(dsm, radius=11)

    heights = []
    for poly in osgb_polys:
        # Rasterize this single building.
        mask = rasterize(
            [(poly, 1)], out_shape=dsm.shape, transform=tfm,
            fill=0, dtype=np.uint8,
        ).astype(bool)

        if not mask.any():
            heights.append(8.0)  # default
            continue

        dsm_vals = dsm[mask]
        ground_vals = ground[mask]
        local_ground = float(np.median(ground_vals))

        # Only consider pixels above ground (ignore misaligned edges).
        above = dsm_vals[dsm_vals > local_ground + min_height]
        if len(above) > 0:
            roof_h = float(np.percentile(above, 90))
            heights.append(max(roof_h - local_ground, 3.0))
        else:
            # Try with lower threshold.
            above = dsm_vals[dsm_vals > local_ground + 2.0]
            if len(above) > 0:
                heights.append(float(np.percentile(above, 90)) - local_ground)
            else:
                heights.append(8.0)

    return wgs_polys, heights
