"""Shared Defra survey catalogue bundle download utilities.

Used by the ENRICH stage for both DSM+DTM downloads. Centralises the
API interaction so there's one source of truth for the catalogue URL,
subscription key, retry logic, and zip validation.
"""

import json
import threading
import time
import urllib.error
import urllib.request
import zipfile
from io import BytesIO

import rasterio

# Defra survey catalogue API.
SEARCH_URL = (
    "https://environment.data.gov.uk/backend/catalog/api/tiles/"
    "collections/survey/search"
)
TILE_KEY = "dspui"
HEADERS = {
    "Content-Type": "application/geo+json",
    "Accept": "*/*",
    "Origin": "https://environment.data.gov.uk",
    "Referer": "https://environment.data.gov.uk/survey",
    "User-Agent": "SunnyPint/0.1 (+https://sunny-pint.co.uk)",
}

# Product IDs.
PRODUCT_DTM = "lidar_composite_dtm"
PRODUCT_DSM_LAST = "lidar_composite_last_return_dsm"
PRODUCT_DSM_FIRST = "lidar_composite_first_return_dsm"
PRODUCT_YEAR = "2022"
PRODUCT_RES = "1"


def search_cell(cell_polygon_geojson: dict) -> list[dict]:
    """POST the survey catalogue search API with a GeoJSON polygon.

    Returns the raw `results` array (may be empty).
    """
    body = json.dumps(cell_polygon_geojson).encode()
    req = urllib.request.Request(SEARCH_URL, data=body, headers=HEADERS, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
        return payload.get("results", []) or []
    except Exception:
        return []


def fetch_bundle_zip(uri: str, max_retries: int = 3) -> bytes | None:
    """Download a 5km LiDAR bundle. Returns raw zip bytes or None.

    Validates PK magic bytes and retries on transient errors.
    """
    url = f"{uri}?subscription-key={TILE_KEY}"
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": HEADERS["User-Agent"]})
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = resp.read()
            if len(data) > 4 and data[:4] == b"PK\x03\x04":
                return data
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
        except Exception:
            pass
        if attempt < max_retries - 1:
            time.sleep(1.0 + attempt)
    return None


def open_bundle_tif(zip_bytes: bytes):
    """Extract the .tif from a bundle zip and open as rasterio MemoryFile.

    Returns (dataset, MemoryFile) — caller must close both.
    """
    with zipfile.ZipFile(BytesIO(zip_bytes)) as z:
        tif_name = next((n for n in z.namelist() if n.lower().endswith(".tif")), None)
        if not tif_name:
            return None, None
        tif_bytes = z.read(tif_name)
    mem = rasterio.MemoryFile(tif_bytes)
    return mem.open(), mem
