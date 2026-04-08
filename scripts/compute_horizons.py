"""Compute terrain horizon profiles for pubs.

For each pub, casts rays every 10° of azimuth and records the maximum
terrain elevation angle. This allows the frontend to determine if a hill
blocks the sun at a given time.

Runs after measure_heights (uses the same EA WCS for DTM data).

Usage:
    uv run python scripts/compute_horizons.py --area norwich
"""

import base64
import json
import math
import time
import urllib.request
from io import BytesIO
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

from areas import parse_area, in_bbox

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PUBS_IN = DATA_DIR / "pubs_merged.json"
PUBS_OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "pubs.json"

to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

# EA DTM WCS endpoint.
EA_DTM_WCS = (
    "https://environment.data.gov.uk/spatialdata/"
    "lidar-composite-digital-terrain-model-dtm-1m/wcs"
)
EA_DTM_COV = (
    "13787b9a-26a4-4775-8523-806d13af58fc__"
    "Lidar_Composite_Elevation_DTM_1m"
)

# Horizon profile parameters.
N_AZIMUTHS = 36         # every 10°
MAX_RANGE_M = 500       # how far to cast rays
SAMPLE_STEP_M = 10      # sample every 10m along ray
MIN_HORIZON_DEG = 1.0   # don't store profiles where max angle < this


def fetch_dtm_tile(cx: float, cy: float, radius: float = 600) -> tuple:
    """Fetch a DTM tile centred on OSGB (cx, cy). Returns (array, transform) or (None, None)."""
    w, s = cx - radius, cy - radius
    e, n = cx + radius, cy + radius
    url = (
        f"{EA_DTM_WCS}?service=WCS&version=2.0.1&request=GetCoverage"
        f"&CoverageId={EA_DTM_COV}"
        f"&format=image/tiff"
        f"&subset=E({int(w)},{int(e)})"
        f"&subset=N({int(s)},{int(n)})"
        f"&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/27700"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "SunPub/0.1"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
        if data[:2] not in (b"II", b"MM") or len(data) < 1000:
            return None, None
        with rasterio.open(BytesIO(data)) as ds:
            arr = ds.read(1).astype(np.float32)
            arr = np.where(np.isnan(arr) | (arr < -100), 0, arr)
            return arr, ds.transform
    except Exception:
        return None, None


def compute_horizon(dtm: np.ndarray, transform, cx: float, cy: float) -> tuple:
    """Compute horizon profile from a DTM array.

    Returns (pub_elev, horizon_bytes) or (None, None).
    horizon_bytes is a bytes object of N_AZIMUTHS uint8 values (angle × 10).
    """
    # Get pub ground elevation.
    col, row = ~transform * (cx, cy)
    row, col = int(round(row)), int(round(col))
    if row < 0 or row >= dtm.shape[0] or col < 0 or col >= dtm.shape[1]:
        return None, None

    pub_elev = float(dtm[row, col])
    if pub_elev <= 0:
        return None, None

    angles = np.zeros(N_AZIMUTHS, dtype=np.float32)

    for i in range(N_AZIMUTHS):
        azimuth_deg = i * (360.0 / N_AZIMUTHS)
        az_rad = math.radians(azimuth_deg)
        dx = math.sin(az_rad)  # east component
        dy = math.cos(az_rad)  # north component

        max_angle = 0.0
        for step in range(1, int(MAX_RANGE_M / SAMPLE_STEP_M) + 1):
            dist = step * SAMPLE_STEP_M
            sx = cx + dx * dist
            sy = cy + dy * dist

            sc, sr = ~transform * (sx, sy)
            sr, sc = int(round(sr)), int(round(sc))
            if sr < 0 or sr >= dtm.shape[0] or sc < 0 or sc >= dtm.shape[1]:
                break

            terrain_elev = float(dtm[sr, sc])
            if terrain_elev <= 0:
                continue

            elev_diff = terrain_elev - pub_elev
            if elev_diff > 0:
                angle = math.degrees(math.atan2(elev_diff, dist))
                max_angle = max(max_angle, angle)

        angles[i] = max_angle

    # Skip flat pubs.
    if angles.max() < MIN_HORIZON_DEG:
        return pub_elev, None

    # Quantize to uint8 at 0.1° resolution (max 25.5°).
    horizon_bytes = bytes(min(255, int(a * 10)) for a in angles)
    return pub_elev, horizon_bytes


def main():
    area = parse_area()
    print(f"Computing terrain horizons for {area.name}")

    if not PUBS_IN.exists():
        print(f"ERROR: {PUBS_IN} not found.")
        return

    with open(PUBS_IN) as f:
        pubs = json.load(f)

    # Filter to area.
    area_pubs = [(i, p) for i, p in enumerate(pubs) if in_bbox(p["lat"], p["lng"], area.bbox)]
    print(f"  {len(area_pubs)} pubs in {area.name}")

    # Cache DTM tiles to avoid re-fetching for nearby pubs.
    dtm_cache: dict[tuple[int, int], tuple] = {}
    TILE_SIZE = 1000

    computed = 0
    with_horizon = 0
    t0 = time.time()

    for idx, (pi, pub) in enumerate(area_pubs, 1):
        cx, cy = to_osgb.transform(pub["lng"], pub["lat"])
        tile_key = (int(cx // TILE_SIZE) * TILE_SIZE, int(cy // TILE_SIZE) * TILE_SIZE)

        if tile_key not in dtm_cache:
            dtm_cache[tile_key] = fetch_dtm_tile(
                tile_key[0] + TILE_SIZE / 2, tile_key[1] + TILE_SIZE / 2
            )

        dtm, tfm = dtm_cache[tile_key]
        if dtm is None:
            continue

        pub_elev, horizon_bytes = compute_horizon(dtm, tfm, cx, cy)
        if pub_elev is not None:
            pubs[pi]["elev"] = round(pub_elev, 1)
            computed += 1
        if horizon_bytes is not None:
            pubs[pi]["horizon"] = base64.b64encode(horizon_bytes).decode("ascii")
            with_horizon += 1

        if idx % 500 == 0 or idx == len(area_pubs):
            elapsed = time.time() - t0
            rate = idx / elapsed if elapsed > 0 else 0
            remaining = (len(area_pubs) - idx) / rate if rate > 0 else 0
            print(
                f"  [{idx}/{len(area_pubs)}] {computed} elevations, "
                f"{with_horizon} horizons, ETA: {remaining:.0f}s",
                flush=True,
            )

    # Save back to merged file (horizons are part of pub data).
    with open(PUBS_IN, "w") as f:
        json.dump(pubs, f, indent=2)
    print(f"\n  {computed} elevations, {with_horizon} horizon profiles")
    print(f"  Saved to {PUBS_IN}")


if __name__ == "__main__":
    main()
