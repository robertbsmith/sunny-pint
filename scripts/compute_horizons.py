"""Compute terrain horizon profiles for pubs.

For each pub, casts rays every 10deg of azimuth and records the maximum
terrain elevation angle. This allows the frontend to determine if a hill
blocks the sun at a given time.

Downloads DTM data from the Defra survey catalogue (same 5km LZW bundles
as measure_heights.py), NOT the slow EA WCS endpoint. Each bundle is
downloaded once, all pubs within it are processed, then discarded — same
streaming pattern as measure_heights.

Parallelised across 8 workers (download + numpy compute releases GIL).
Ray-casting is vectorised with numpy for ~10x speedup over the scalar loop.

Usage:
    uv run python scripts/compute_horizons.py --area norwich
    uv run python scripts/compute_horizons.py --area uk
"""

import base64
import json
import math
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

from areas import parse_area, in_bbox
from measure_heights import (
    _fetch_bundle_zip,
    _open_bundle_tif,
    _pub_search_cells,
    _search_cell,
    os_label_to_bbox,
    to_osgb,
    to_wgs,
    PRODUCT_DTM,
    PRODUCT_YEAR,
    PRODUCT_RES,
    WCS_WORKERS,
)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PUBS_PATH = DATA_DIR / "pubs_merged.json"
PROGRESS_PATH = DATA_DIR / "horizons_progress.json"

# Horizon profile parameters.
N_AZIMUTHS = 36         # every 10deg
MAX_RANGE_M = 500       # how far to cast rays
SAMPLE_STEP_M = 10      # sample every 10m along ray
MIN_HORIZON_DEG = 1.0   # don't store profiles where max angle < this
N_STEPS = int(MAX_RANGE_M / SAMPLE_STEP_M)

# Pre-compute all 36x50 sample offsets (dx, dy in metres from pub centre).
# Shape: (N_AZIMUTHS, N_STEPS) for both dx and dy.
_azimuths_rad = np.linspace(0, 2 * math.pi, N_AZIMUTHS, endpoint=False)
_distances = np.arange(1, N_STEPS + 1) * SAMPLE_STEP_M  # (N_STEPS,)
# dx[a, s] = sin(az) * dist, dy[a, s] = cos(az) * dist
_dx_all = np.outer(np.sin(_azimuths_rad), _distances)  # (36, 50)
_dy_all = np.outer(np.cos(_azimuths_rad), _distances)  # (36, 50)


def compute_horizon(dtm: np.ndarray, transform, cx: float, cy: float,
                    terrain50=None):
    """Compute horizon profile from a DTM array (vectorised).

    Uses the 1m DTM for 0-500m (close-range detail) and optionally
    OS Terrain 50 for 500-3000m (distant ridges). Takes the max angle
    from both sources per azimuth.

    Returns (pub_elev, horizon_bytes, horizon_dist_bytes) or (None, None, None).
    horizon_bytes: N_AZIMUTHS uint8 values (angle × 10, max 25.5°).
    horizon_dist_bytes: N_AZIMUTHS uint8 values (distance ÷ 12, max 3060m).
    """
    # Get pub ground elevation from 1m DTM.
    inv = ~transform
    col0, row0 = inv * (cx, cy)
    row0, col0 = int(round(row0)), int(round(col0))
    if row0 < 0 or row0 >= dtm.shape[0] or col0 < 0 or col0 >= dtm.shape[1]:
        return None, None, None

    pub_elev = float(dtm[row0, col0])
    if pub_elev <= 0:
        return None, None, None

    # ── Phase 1: 1m DTM (0-500m, 10m steps) ─────────────────────────

    sx = cx + _dx_all  # (36, 50)
    sy = cy + _dy_all  # (36, 50)

    a, b, c, d, e, f = transform.a, transform.b, transform.c, transform.d, transform.e, transform.f
    det = a * e - b * d
    cols = (e * (sx - c) - b * (sy - f)) / det
    rows = (a * (sy - f) - d * (sx - c)) / det
    cols = np.round(cols).astype(np.int32)
    rows = np.round(rows).astype(np.int32)

    h, w = dtm.shape
    valid = (rows >= 0) & (rows < h) & (cols >= 0) & (cols < w)
    rows_safe = np.clip(rows, 0, h - 1)
    cols_safe = np.clip(cols, 0, w - 1)

    terrain_elev = dtm[rows_safe, cols_safe]  # (36, 50)
    terrain_elev = np.where(valid, terrain_elev, 0.0)

    elev_diff = np.maximum(terrain_elev - pub_elev, 0.0)
    angles = np.where(valid,
                      np.degrees(np.arctan2(elev_diff, _distances[np.newaxis, :])),
                      0.0)

    max_angles = angles.max(axis=1)  # (36,)
    max_indices = angles.argmax(axis=1)  # (36,)
    ridge_distances = _distances[max_indices].astype(float)  # (36,)

    # ── Phase 2: OS Terrain 50 (500-3000m, 50m steps) ────────────────

    if terrain50 is not None and terrain50.available:
        T50_START = 550   # start just past 1m DTM range
        T50_END = 3000
        T50_STEP = 50
        t50_distances = np.arange(T50_START, T50_END + 1, T50_STEP)
        n_t50 = len(t50_distances)

        # Build sample points for all azimuths
        az_rad = _azimuths_rad[:, np.newaxis]  # (36, 1)
        t50_dx = np.sin(az_rad) * t50_distances[np.newaxis, :]  # (36, n_t50)
        t50_dy = np.cos(az_rad) * t50_distances[np.newaxis, :]

        t50_east = (cx + t50_dx).ravel()
        t50_north = (cy + t50_dy).ravel()

        t50_elevs = terrain50.elevation_array(t50_east, t50_north).reshape(N_AZIMUTHS, n_t50)

        t50_diff = np.where(np.isnan(t50_elevs), 0.0, t50_elevs) - pub_elev
        t50_diff = np.maximum(t50_diff, 0.0)
        t50_angles = np.degrees(np.arctan2(t50_diff, t50_distances[np.newaxis, :]))

        t50_max = t50_angles.max(axis=1)  # (36,)
        t50_max_idx = t50_angles.argmax(axis=1)
        t50_ridge_dist = t50_distances[t50_max_idx].astype(float)

        # Merge: take whichever source has the higher angle per azimuth
        use_t50 = t50_max > max_angles
        max_angles = np.where(use_t50, t50_max, max_angles)
        ridge_distances = np.where(use_t50, t50_ridge_dist, ridge_distances)

    # ── Encode ────────────────────────────────────────────────────────

    if max_angles.max() < MIN_HORIZON_DEG:
        return pub_elev, None, None

    # Angles: uint8 at 0.1° resolution (max 25.5°).
    horizon_bytes = bytes(min(255, int(a * 10)) for a in max_angles)
    # Distances: uint8 at 12m resolution (max 3060m).
    horizon_dist_bytes = bytes(min(255, int(d / 12)) for d in ridge_distances)
    return pub_elev, horizon_bytes, horizon_dist_bytes


# ── Bundle discovery ──────────────────────────────────────────────────────


def discover_dtm_bundles(pubs: list[dict]) -> dict[str, dict]:
    """Discover DTM bundle URIs for all 5km tiles that contain pubs.

    Returns {tile_id: {"dtm": uri, "label": "TG20nw"}}
    """
    cells = _pub_search_cells(pubs)
    print(f"  {len(pubs)} pubs -> {len(cells)} 10km search cells")

    bundles: dict[str, dict] = {}
    lock = threading.Lock()
    completed = 0
    t0 = time.time()

    def collect(cell):
        return _search_cell(cell)

    with ThreadPoolExecutor(max_workers=WCS_WORKERS) as ex:
        for results in ex.map(collect, cells):
            completed += 1
            for r in results:
                prod = r.get("product", {}).get("id")
                year = r.get("year", {}).get("id")
                res = r.get("resolution", {}).get("id")
                if prod != PRODUCT_DTM or year != PRODUCT_YEAR or res != PRODUCT_RES:
                    continue
                tile = r.get("tile", {})
                tid = tile.get("id")
                uri = r.get("uri")
                if not tid or not uri:
                    continue
                with lock:
                    bundles[tid] = {"dtm": uri, "label": tile.get("label", tid)}
            if completed % 50 == 0 or completed == len(cells):
                rate = completed / (time.time() - t0) if time.time() > t0 else 0
                eta = (len(cells) - completed) / rate if rate else 0
                print(f"  search [{completed}/{len(cells)}]  {rate:.1f}/s  ETA {eta:.0f}s")

    return bundles


def assign_pubs_to_bundles(
    pubs: list[dict],
    bundles: dict[str, dict],
) -> dict[str, list[int]]:
    """Map each pub index to the 5km bundle containing it.

    Returns {tile_id: [pub_index, ...]}
    """
    # Build a lookup: (tile_id) -> OSGB bbox.
    tile_bboxes: dict[str, tuple[int, int, int, int]] = {}
    for tid, b in bundles.items():
        bbox = os_label_to_bbox(b["label"])
        if bbox:
            tile_bboxes[tid] = bbox

    # For each pub, find which tile contains it.
    assignments: dict[str, list[int]] = {tid: [] for tid in bundles}
    unmatched = 0
    for i, pub in enumerate(pubs):
        cx, cy = to_osgb.transform(pub["lng"], pub["lat"])
        matched = False
        for tid, (emin, nmin, emax, nmax) in tile_bboxes.items():
            if emin <= cx < emax and nmin <= cy < nmax:
                assignments[tid].append(i)
                matched = True
                break
        if not matched:
            unmatched += 1

    # Drop tiles with no pubs.
    assignments = {tid: idxs for tid, idxs in assignments.items() if idxs}
    if unmatched:
        print(f"  {unmatched} pubs not matched to any DTM bundle (outside England?)")
    print(f"  {len(assignments)} bundles have pubs assigned")
    return assignments


def process_bundle_horizons(
    tile_id: str,
    bundle: dict,
    pubs: list[dict],
    pub_indices: list[int],
) -> list[dict]:
    """Download a DTM bundle and compute horizons for all pubs in it.

    Returns list of {index, elev, horizon_b64} dicts.
    """
    zip_bytes = _fetch_bundle_zip(bundle["dtm"])
    if not zip_bytes:
        return []

    dtm_ds, dtm_mem = _open_bundle_tif(zip_bytes)
    if dtm_ds is None:
        if dtm_mem:
            dtm_mem.close()
        return []

    try:
        dtm = dtm_ds.read(1).astype(np.float32)
        dtm = np.where(np.isnan(dtm) | (dtm < -100), 0, dtm)
        transform = dtm_ds.transform
    finally:
        dtm_ds.close()
        dtm_mem.close()

    # Lazy-load OS Terrain 50 for long-range horizon rays.
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
        from pipeline.utils.terrain50 import Terrain50
        t50 = Terrain50()
        if not t50.available:
            t50 = None
    except Exception:
        t50 = None

    results = []
    for idx in pub_indices:
        pub = pubs[idx]
        cx, cy = to_osgb.transform(pub["lng"], pub["lat"])
        pub_elev, horizon_bytes, horizon_dist_bytes = compute_horizon(
            dtm, transform, cx, cy, terrain50=t50
        )
        entry = {"index": idx, "elev": None, "horizon_b64": None, "horizon_dist_b64": None}
        if pub_elev is not None:
            entry["elev"] = round(pub_elev, 1)
        if horizon_bytes is not None:
            entry["horizon_b64"] = base64.b64encode(horizon_bytes).decode("ascii")
        if horizon_dist_bytes is not None:
            entry["horizon_dist_b64"] = base64.b64encode(horizon_dist_bytes).decode("ascii")
        results.append(entry)

    return results


def _write_progress(state: dict):
    try:
        tmp = PROGRESS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2, default=str))
        tmp.replace(PROGRESS_PATH)
    except Exception:
        pass


def main():
    area = parse_area()
    print(f"Computing terrain horizons for {area.name}")

    if not PUBS_PATH.exists():
        print(f"ERROR: {PUBS_PATH} not found.")
        return

    with open(PUBS_PATH) as f:
        pubs = json.load(f)

    # Filter to area.
    area_pubs_idx = [i for i, p in enumerate(pubs) if in_bbox(p["lat"], p["lng"], area.bbox)]
    area_pubs = [pubs[i] for i in area_pubs_idx]
    print(f"  {len(area_pubs)} pubs in {area.name}")
    print()

    # Phase 1: Discover DTM bundles.
    print("Discovering DTM bundles...")
    bundles = discover_dtm_bundles(area_pubs)
    print(f"  {len(bundles)} DTM bundles found")
    print()

    # Skip pubs that already have elev+horizon from a previous run.
    pubs_needing_work = {i for i, p in enumerate(area_pubs) if "elev" not in p or "horizon" not in p}
    already_done = len(area_pubs) - len(pubs_needing_work)
    if already_done:
        print(f"  {already_done}/{len(area_pubs)} pubs already have elev+horizon (skipped)")
    if not pubs_needing_work:
        print("  All pubs already have horizons — nothing to do.")
        return

    # Phase 2: Assign pubs to bundles (only pubs that still need horizons).
    print("Assigning pubs to bundles...")
    assignments = assign_pubs_to_bundles(area_pubs, bundles)
    # Filter assignments to only include pubs needing work.
    for tid in list(assignments):
        assignments[tid] = [i for i in assignments[tid] if i in pubs_needing_work]
        if not assignments[tid]:
            del assignments[tid]
    print()

    # Phase 3: Download + compute in parallel.
    stats = {
        "phase": "horizons",
        "started_at": time.time(),
        "total_bundles": len(assignments),
        "completed": 0,
        "pubs_computed": 0,
        "with_horizon": 0,
    }

    items = sorted(assignments.items())
    n_total = len(items)
    t0 = stats["started_at"]

    print(f"Processing {n_total} bundles with {WCS_WORKERS} workers...")
    print()

    all_results: list[dict] = []
    last_save = time.time()
    SAVE_INTERVAL = 300  # incremental save every 5 minutes

    def _incremental_save():
        """Write results collected so far to pubs_merged.json.

        This makes the script crash-safe: if killed, we keep everything
        computed up to the last save point.
        """
        for r in all_results:
            gi = area_pubs_idx[r["index"]]
            if r["elev"] is not None:
                pubs[gi]["elev"] = r["elev"]
            if r["horizon_b64"] is not None:
                pubs[gi]["horizon"] = r["horizon_b64"]
            if r.get("horizon_dist_b64") is not None:
                pubs[gi]["horizon_dist"] = r["horizon_dist_b64"]
        tmp = PUBS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(pubs, indent=2))
        tmp.replace(PUBS_PATH)
        print(f"  ** incremental save ({stats['pubs_computed']} pubs) **", flush=True)

    with ThreadPoolExecutor(max_workers=WCS_WORKERS) as ex:
        futures = {
            ex.submit(process_bundle_horizons, tid, bundles[tid], area_pubs, idxs): tid
            for tid, idxs in items
        }
        for future in as_completed(futures):
            stats["completed"] += 1
            done = stats["completed"]
            try:
                results = future.result()
            except Exception as exc:
                tid = futures[future]
                print(f"  [{done}/{n_total}] {tid} EXC: {exc}")
                continue

            all_results.extend(results)
            for r in results:
                if r["elev"] is not None:
                    stats["pubs_computed"] += 1
                if r["horizon_b64"] is not None:
                    stats["with_horizon"] += 1

            elapsed = time.time() - t0
            rate = done / elapsed if elapsed else 0
            eta = (n_total - done) / rate if rate else 0
            label = bundles[futures[future]]["label"]
            print(
                f"  [{done}/{n_total}] {label:<8} "
                f"{len(results)} pubs  "
                f"total {stats['pubs_computed']} elevs / {stats['with_horizon']} horizons  "
                f"{rate:.2f}/s  ETA {eta:.0f}s"
            )
            if done % 10 == 0:
                _write_progress(stats)

            # Incremental save every 5 minutes so a crash doesn't lose hours.
            if time.time() - last_save > SAVE_INTERVAL:
                _incremental_save()
                last_save = time.time()

    _write_progress(stats)

    # Final write of all results to pubs_merged.json.
    for r in all_results:
        gi = area_pubs_idx[r["index"]]
        if r["elev"] is not None:
            pubs[gi]["elev"] = r["elev"]
        if r["horizon_b64"] is not None:
            pubs[gi]["horizon"] = r["horizon_b64"]

    with open(PUBS_PATH, "w") as f:
        json.dump(pubs, f, indent=2)

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.0f}s")
    print(f"  {stats['pubs_computed']} elevations, {stats['with_horizon']} horizon profiles")
    print(f"  Saved to {PUBS_PATH}")


if __name__ == "__main__":
    main()
