"""Geometric shadow projection from building polygons.

For each building wall segment, projects a shadow quadrilateral based on
the building height and sun position. Unions all shadow quads, then
subtracts building footprints to get ground-level shadow polygons.
"""

import math
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely.validation import make_valid


def compute_shadow_polygons(
    building_polys_wgs: list[list],
    building_heights: list[float],
    sun_azimuth_deg: float,
    sun_altitude_deg: float,
) -> list[list]:
    """Compute shadow polygons for a set of buildings.

    Args:
        building_polys_wgs: List of [[lat, lng], ...] polygon rings.
        building_heights: Height in metres per building.
        sun_azimuth_deg: Compass bearing of the sun (0=N, 90=E).
        sun_altitude_deg: Angle above horizon in degrees.

    Returns:
        List of [[lat, lng], ...] shadow polygon rings (WGS84),
        with building footprints subtracted.
    """
    if sun_altitude_deg <= 0 or not building_polys_wgs:
        return []

    az_rad = math.radians(sun_azimuth_deg)
    tan_alt = math.tan(math.radians(sun_altitude_deg))

    # Metres per degree at mid-latitude.
    mid_lat = sum(c[0] for c in building_polys_wgs[0]) / len(building_polys_wgs[0])
    M_PER_DEG_LAT = 111320.0
    M_PER_DEG_LNG = 111320.0 * math.cos(math.radians(mid_lat))

    all_shadows = []
    all_footprints = []

    for coords, height in zip(building_polys_wgs, building_heights):
        if height <= 0 or len(coords) < 3:
            continue

        # Cap shadow length for sanity (avoids infinite geometry at horizon).
        shadow_len = min(height / tan_alt, 200.0)
        dlat = -shadow_len * math.cos(az_rad) / M_PER_DEG_LAT
        dlng = -shadow_len * math.sin(az_rad) / M_PER_DEG_LNG

        # Build footprint (shapely uses x=lng, y=lat).
        footprint = Polygon([(c[1], c[0]) for c in coords])
        if not footprint.is_valid:
            footprint = make_valid(footprint)
        if footprint.is_empty:
            continue
        all_footprints.append(footprint)

        # Project each wall segment into a shadow quadrilateral.
        ring = list(footprint.exterior.coords)
        wall_shadows = [footprint]  # include the roof shadow (footprint itself)

        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            # Projected vertices.
            x1p, y1p = x1 + dlng, y1 + dlat
            x2p, y2p = x2 + dlng, y2 + dlat
            # Quadrilateral: wall base → projected wall base.
            quad = Polygon([(x1, y1), (x2, y2), (x2p, y2p), (x1p, y1p)])
            if quad.is_valid and not quad.is_empty and quad.area > 0:
                wall_shadows.append(quad)

        # Also add the projected footprint (the "roof shadow on the ground").
        projected = Polygon([(c[1] + dlng, c[0] + dlat) for c in coords])
        if projected.is_valid and not projected.is_empty:
            wall_shadows.append(projected)

        # Union this building's shadow components.
        try:
            bld_shadow = unary_union(wall_shadows)
            if not bld_shadow.is_valid:
                bld_shadow = make_valid(bld_shadow)
            if not bld_shadow.is_empty:
                all_shadows.append(bld_shadow)
        except Exception:
            continue

    if not all_shadows:
        return []

    # Union all building shadows into one geometry.
    try:
        combined = unary_union(all_shadows)
    except Exception:
        return []

    # Subtract all building footprints.
    try:
        buildings_union = unary_union(all_footprints)
        ground_shadow = combined.difference(buildings_union)
    except Exception:
        ground_shadow = combined

    if not ground_shadow.is_valid:
        ground_shadow = make_valid(ground_shadow)

    return _to_latlng_rings(ground_shadow)


def _to_latlng_rings(geom) -> list[list]:
    """Convert a shapely geometry to list of [[lat, lng], ...] rings."""
    if geom.is_empty:
        return []

    if isinstance(geom, Polygon):
        parts = [geom]
    elif isinstance(geom, MultiPolygon):
        parts = list(geom.geoms)
    else:
        return []

    result = []
    for poly in parts:
        if poly.is_empty or poly.exterior is None:
            continue
        coords = [[y, x] for x, y in poly.exterior.coords]
        if len(coords) >= 3:
            result.append(coords)
    return result
