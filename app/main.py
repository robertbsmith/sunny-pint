"""FastAPI app: serves the frontend and the shadow-computation API."""

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from .lidar import LidarManager

app = FastAPI(title="SunPub")
lidar = LidarManager("data")

PUBS_FILE = Path("data/pubs.json")


class ShadowRequest(BaseModel):
    north: float
    south: float
    east: float
    west: float
    sun_azimuth: float
    sun_altitude: float
    min_height: float = 0.0
    seats: list[dict]


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
            "has_lidar": lidar.has_data,
            "seats": [],
            "buildings": [],
            "shadow_image": None,
            "sun_pct": None,
            "below_horizon": True,
        }

    try:
        result = lidar.query(
            req.north, req.south, req.east, req.west,
            req.sun_azimuth, req.sun_altitude,
            req.seats, req.min_height,
        )
    except Exception as e:
        print(f"Shadow computation error: {e}")
        result = None

    if result is None:
        return {
            "has_lidar": False,
            "seats": [],
            "buildings": [],
            "shadow_image": None,
            "sun_pct": None,
        }
    return result


class DebugRequest(BaseModel):
    north: float
    south: float
    east: float
    west: float
    min_height: float = 6.0


@app.post("/api/debug")
def debug_layers(req: DebugRequest):
    result = lidar.debug_layers(req.north, req.south, req.east, req.west, req.min_height)
    if result is None:
        return {"error": "No LiDAR data"}
    return result


class ElevationRequest(BaseModel):
    north: float
    south: float
    east: float
    west: float


@app.post("/api/elevation")
def elevation(req: ElevationRequest):
    result = lidar.elevation_image(req.north, req.south, req.east, req.west)
    if result is None:
        return {"has_lidar": False}
    return result


app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
