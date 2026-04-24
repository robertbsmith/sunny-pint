"""Recompute horizon profiles with extended range (OS Terrain 50).

This stage can run independently of ENRICH — it reads pubs_enriched.json,
recomputes horizon + horizon_dist using both the 1m Defra DTM (close range)
and OS Terrain 50 (long range), and writes the results back.

Use this when:
- Horizon parameters change (range, resolution, algorithm)
- OS Terrain 50 data is updated
- You want to add horizon_dist to pubs that only have horizon (from v1)

Does NOT re-run heights, parcels, or outdoor areas.

Usage:
    uv run python -m pipeline.stages.horizon --area uk
    uv run python pipeline/stages/horizon.py --area uk [--force]
"""

import argparse
import base64
import json
import sys
import time
from pathlib import Path

# Ensure workspace root is on sys.path for `pipeline.*` imports.
_root = str(Path(__file__).resolve().parent.parent.parent)
if _root not in sys.path:
    sys.path.insert(0, _root)

import numpy as np

from pipeline.utils.terrain50 import Terrain50, download_terrain50

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
ENRICHED_PATH = DATA_DIR / "pubs_enriched.json"

# Horizon parameters (must match compute_horizons.py / enrich.py).
N_AZIMUTHS = 36
MAX_RANGE_1M = 500
SAMPLE_STEP_1M = 10
N_STEPS_1M = MAX_RANGE_1M // SAMPLE_STEP_1M
MIN_HORIZON_DEG = 1.0

_azimuths_rad = np.linspace(0, 2 * np.pi, N_AZIMUTHS, endpoint=False)
_distances_1m = np.arange(1, N_STEPS_1M + 1) * SAMPLE_STEP_1M
_dx_1m = np.outer(np.sin(_azimuths_rad), _distances_1m)
_dy_1m = np.outer(np.cos(_azimuths_rad), _distances_1m)

# OS Terrain 50 long-range parameters.
T50_START = 550
T50_END = 3000
T50_STEP = 50
_distances_t50 = np.arange(T50_START, T50_END + 1, T50_STEP)


def _compute_horizon_t50_only(cx: float, cy: float, pub_elev: float,
                              terrain50: Terrain50) -> tuple[bytes, bytes] | tuple[None, None]:
    """Compute horizon using OS Terrain 50 only (no 1m DTM needed).

    For pubs that already have 1m DTM horizons, this extends the range.
    For pubs without any DTM coverage, this provides coarse horizons.
    """
    az_rad = _azimuths_rad[:, np.newaxis]
    t50_east = (cx + np.sin(az_rad) * _distances_t50[np.newaxis, :]).ravel()
    t50_north = (cy + np.cos(az_rad) * _distances_t50[np.newaxis, :]).ravel()

    t50_elevs = terrain50.elevation_array(t50_east, t50_north).reshape(N_AZIMUTHS, len(_distances_t50))
    t50_diff = np.maximum(np.where(np.isnan(t50_elevs), 0.0, t50_elevs) - pub_elev, 0.0)
    t50_angles = np.degrees(np.arctan2(t50_diff, _distances_t50[np.newaxis, :]))

    max_angles = t50_angles.max(axis=1)
    max_indices = t50_angles.argmax(axis=1)
    ridge_distances = _distances_t50[max_indices].astype(float)

    if max_angles.max() < MIN_HORIZON_DEG:
        return None, None

    angle_bytes = bytes(min(255, int(a * 10)) for a in max_angles)
    dist_bytes = bytes(min(255, int(d / 12)) for d in ridge_distances)
    return angle_bytes, dist_bytes


def _merge_horizons(existing_b64: str | None, t50_angle_bytes: bytes,
                    existing_dist_b64: str | None, t50_dist_bytes: bytes) -> tuple[str, str]:
    """Merge existing 1m DTM horizons with OS Terrain 50 long-range horizons.

    Takes the max angle per azimuth from both sources, using the corresponding
    distance from whichever source had the higher angle.
    """
    if existing_b64:
        existing_angles = list(base64.b64decode(existing_b64))
    else:
        existing_angles = [0] * N_AZIMUTHS

    if existing_dist_b64:
        existing_dists = list(base64.b64decode(existing_dist_b64))
    else:
        # Estimate distances for old-format horizons (no dist data).
        # Use 250m as a reasonable default for 1m DTM range.
        existing_dists = [21] * N_AZIMUTHS  # 21 × 12 = 252m

    t50_angles = list(t50_angle_bytes)
    t50_dists = list(t50_dist_bytes)

    merged_angles = []
    merged_dists = []
    for i in range(N_AZIMUTHS):
        if t50_angles[i] > existing_angles[i]:
            merged_angles.append(t50_angles[i])
            merged_dists.append(t50_dists[i])
        else:
            merged_angles.append(existing_angles[i])
            merged_dists.append(existing_dists[i])

    return (
        base64.b64encode(bytes(merged_angles)).decode("ascii"),
        base64.b64encode(bytes(merged_dists)).decode("ascii"),
    )


def run(area=None, force: bool = False) -> dict:
    """Recompute horizons with extended range for all pubs."""
    from pyproj import Transformer

    if not ENRICHED_PATH.exists():
        raise FileNotFoundError(f"{ENRICHED_PATH} not found — run ENRICH first")

    # Ensure OS Terrain 50 is available.
    download_terrain50()
    t50 = Terrain50()
    if not t50.available:
        raise RuntimeError("OS Terrain 50 not available")

    to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

    pubs = json.loads(ENRICHED_PATH.read_text())
    print(f"  {len(pubs)} pubs loaded")

    # Identify pubs needing horizon update.
    needs_update = []
    already_done = 0
    for i, pub in enumerate(pubs):
        if not force and pub.get("horizon_dist"):
            already_done += 1
            continue
        # Need either elev (from 1m DTM) or at least lat/lng for OS50-only
        if pub.get("elev") or (pub.get("lat") and pub.get("lng")):
            needs_update.append(i)

    print(f"  {already_done} pubs already have horizon_dist — skipping")
    print(f"  {len(needs_update)} pubs to process")

    if not needs_update:
        return {"updated": 0, "skipped": already_done}

    t0 = time.time()
    updated = 0
    SAVE_INTERVAL = 300

    last_save = t0
    for pi, idx in enumerate(needs_update):
        pub = pubs[idx]
        cx, cy = to_osgb.transform(pub["lng"], pub["lat"])
        pub_elev = pub.get("elev")

        if pub_elev is None:
            # No 1m DTM elevation — try OS50 for both elev and horizon
            pub_elev = t50.elevation(cx, cy)
            if pub_elev is None or pub_elev <= 0:
                continue

        t50_angles, t50_dists = _compute_horizon_t50_only(cx, cy, pub_elev, t50)
        if t50_angles is None:
            # No significant terrain — keep existing horizon if any
            if pub.get("horizon") and not pub.get("horizon_dist"):
                # Add default distances for existing close-range horizons
                existing = base64.b64decode(pub["horizon"])
                pub["horizon_dist"] = base64.b64encode(
                    bytes(21 for _ in existing)  # ~250m default
                ).decode("ascii")
                updated += 1
            continue

        # Merge with existing 1m DTM horizons.
        merged_h, merged_d = _merge_horizons(
            pub.get("horizon"), t50_angles,
            pub.get("horizon_dist"), t50_dists,
        )
        pub["horizon"] = merged_h
        pub["horizon_dist"] = merged_d
        updated += 1

        if (pi + 1) % 1000 == 0:
            elapsed = time.time() - t0
            rate = (pi + 1) / elapsed if elapsed else 0
            remaining = len(needs_update) - pi - 1
            eta = remaining / rate if rate else 0
            print(f"  [{pi + 1}/{len(needs_update)}] {updated} updated {rate:.0f}/s ETA {eta:.0f}s",
                  flush=True)

        if time.time() - last_save > SAVE_INTERVAL:
            tmp = ENRICHED_PATH.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(pubs, indent=2))
            tmp.replace(ENRICHED_PATH)
            print(f"  ** incremental save ({updated} updated) **", flush=True)
            last_save = time.time()

    # Final save.
    ENRICHED_PATH.write_text(json.dumps(pubs, indent=2))
    elapsed = time.time() - t0
    print(f"  Done: {updated} horizons updated in {elapsed:.0f}s")
    return {"updated": updated, "skipped": already_done}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recompute horizons with OS Terrain 50")
    parser.add_argument("--area", default="uk")
    parser.add_argument("--force", action="store_true", help="Recompute all, not just missing")
    args = parser.parse_args()

    run(force=args.force)
