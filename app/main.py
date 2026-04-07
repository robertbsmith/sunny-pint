"""FastAPI app: serves the frontend and building data API."""

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from .lidar import LidarManager
from .buildings import get_building_data

app = FastAPI(title="SunPub")
lidar = LidarManager("data")

PUBS_FILE = Path("data/pubs.json")


class BuildingRequest(BaseModel):
    lat: float
    lng: float
    radius: float = 60.0
    min_height: float = 6.0


@app.get("/api/status")
def status():
    return {"has_lidar": lidar.has_data, "tile_count": len(lidar.tiles)}


@app.get("/api/pubs")
def pubs():
    if PUBS_FILE.exists():
        return json.loads(PUBS_FILE.read_text())
    return []


@app.post("/api/buildings")
def buildings(req: BuildingRequest):
    """Return building polygons with heights for a circular area.
    Called once per pub selection. Shadow computation is client-side."""
    try:
        buildings_wgs, heights = get_building_data(
            req.lat, req.lng, req.radius, lidar, req.min_height
        )
        return {
            "buildings": buildings_wgs,
            "heights": heights,
        }
    except Exception as e:
        print(f"Building fetch error: {e}")
        return {"buildings": [], "heights": []}


app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
