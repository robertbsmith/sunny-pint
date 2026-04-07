"""FastAPI app: serves the frontend and the shadow-computation API."""

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from .lidar import LidarManager
from .buildings import get_building_data
from .shadows import compute_shadow_polygons

app = FastAPI(title="SunPub")
lidar = LidarManager("data")

PUBS_FILE = Path("data/pubs.json")


class ShadowRequest(BaseModel):
    lat: float
    lng: float
    radius: float = 60.0
    sun_azimuth: float
    sun_altitude: float
    min_height: float = 6.0


@app.get("/api/status")
def status():
    return {"has_lidar": lidar.has_data, "tile_count": len(lidar.tiles)}


@app.get("/api/pubs")
def pubs():
    if PUBS_FILE.exists():
        return json.loads(PUBS_FILE.read_text())
    return []


@app.post("/api/shadow")
def shadow(req: ShadowRequest):
    if req.sun_altitude <= 0:
        return {
            "shadow_polys": [],
            "buildings": [],
            "sun_pct": None,
            "below_horizon": True,
        }

    try:
        # Get buildings with heights from LiDAR.
        buildings_wgs, heights = get_building_data(
            req.lat, req.lng, req.radius, lidar, req.min_height
        )

        # Geometric shadow projection.
        shadow_polys = compute_shadow_polygons(
            buildings_wgs, heights,
            req.sun_azimuth, req.sun_altitude,
        )

        # Sun percentage: estimate from shadow area vs circle area.
        sun_pct = _estimate_sun_pct(
            shadow_polys, buildings_wgs,
            req.lat, req.lng, req.radius,
        )

        return {
            "shadow_polys": shadow_polys,
            "buildings": buildings_wgs,
            "sun_pct": sun_pct,
        }
    except Exception as e:
        print(f"Shadow error: {e}")
        import traceback
        traceback.print_exc()
        return {
            "shadow_polys": [],
            "buildings": [],
            "sun_pct": None,
            "error": str(e),
        }


def _estimate_sun_pct(shadow_polys, building_polys, lat, lng, radius_m):
    """Estimate % of the circle area that's in sun."""
    import math
    from shapely.geometry import Point, Polygon
    from shapely.ops import unary_union

    M_PER_DEG_LAT = 111320.0
    M_PER_DEG_LNG = 111320.0 * math.cos(math.radians(lat))

    # Circle area in degrees (approximate).
    circle = Point(lng, lat).buffer(radius_m / M_PER_DEG_LNG)

    # Shadow area within circle.
    shadow_shapes = []
    for coords in shadow_polys:
        p = Polygon([(c[1], c[0]) for c in coords])
        if p.is_valid and not p.is_empty:
            shadow_shapes.append(p)

    # Building area within circle.
    for coords in building_polys:
        p = Polygon([(c[1], c[0]) for c in coords])
        if p.is_valid and not p.is_empty:
            shadow_shapes.append(p)

    if not shadow_shapes:
        return 100.0

    blocked = unary_union(shadow_shapes).intersection(circle)
    blocked_frac = blocked.area / circle.area if circle.area > 0 else 0
    return round(100.0 * (1.0 - blocked_frac), 1)


@app.post("/api/debug")
def debug_layers():
    return {"message": "Debug layers not available in geometric mode"}


app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
