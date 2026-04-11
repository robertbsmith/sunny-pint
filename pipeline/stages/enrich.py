"""Stage 3: ENRICH — per-tile enrichment of pubs and buildings.

Two phases:
  Phase 1 (England): Downloads 5km LZW bundles from the Defra survey
    catalogue. Each bundle processed once for heights + horizons + parcels.
  Phase 2 (Wales/Scotland): Falls back to per-1km WCS/COG fetchers for
    pubs not covered by Defra bundles. Uses NRW COG (Wales) and JNCC WCS
    (Scotland) — the same data sources as v1 measure_heights.

Both phases perform a single pass:
  - Samples building heights (DSM - DTM)
  - Computes pub ground elevation + terrain horizon (DTM)
  - Matches pub to INSPIRE parcel + computes outdoor area

Idempotency: each pub's source data is hashed. If the hash matches a
previous run and all enrichment fields are present, the pub is skipped.
Heights baked into buildings.gpkg are also skipped per-fid.
"""

import base64
import hashlib
import json
import math
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import from_origin
from shapely import prepare, wkb
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from pipeline.utils.bundles import (
    PRODUCT_DTM,
    PRODUCT_DSM_LAST,
    PRODUCT_DSM_FIRST,
    PRODUCT_YEAR,
    PRODUCT_RES,
    fetch_bundle_zip,
    open_bundle_tif,
    search_cell,
)
from pipeline.utils.grid import (
    label_to_bbox,
    osgb_cell_to_geojson,
    pub_search_cells,
    to_osgb,
    to_wgs,
)
from pipeline.utils.progress import eta_str, write_progress

from pipeline.utils.lidar import fetch_ndsm as _fetch_ndsm_wcs

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
GPKG_PATH = DATA_DIR / "buildings.gpkg"
INSPIRE_GPKG = DATA_DIR / "inspire.gpkg"
SCOTLAND_GPKG = DATA_DIR / "scotland_parcels.gpkg"
# Accept both v2 filename (pubs_extracted.json) and v1 (pubs_merged.json).
PUBS_PATH = DATA_DIR / "pubs_extracted.json"
PUBS_PATH_V1 = DATA_DIR / "pubs_merged.json"
ENRICHED_PATH = DATA_DIR / "pubs_enriched.json"

# Constants.
MIN_HEIGHT_M = 3.0
DEFAULT_HEIGHT_M = 8.0
SHADOW_RADIUS_M = 300
N_AZIMUTHS = 36
MAX_RANGE_M = 500
SAMPLE_STEP_M = 10
MIN_HORIZON_DEG = 1.0
N_STEPS = int(MAX_RANGE_M / SAMPLE_STEP_M)
WORKERS = 8
SAVE_INTERVAL = 300

# Pre-computed horizon ray offsets.
_azimuths_rad = np.linspace(0, 2 * math.pi, N_AZIMUTHS, endpoint=False)
_distances = np.arange(1, N_STEPS + 1) * SAMPLE_STEP_M
_dx_all = np.outer(np.sin(_azimuths_rad), _distances)
_dy_all = np.outer(np.cos(_azimuths_rad), _distances)


# ── Per-pub hashing ──────────────────────────────────────────────────────


def _pub_hash(pub: dict) -> str:
    """Hash a pub's source data to detect changes across runs."""
    key = f"{pub.get('osm_id')}:{pub.get('lat')}:{pub.get('lng')}"
    if pub.get("polygon"):
        key += ":" + json.dumps(pub["polygon"], sort_keys=True)
    return hashlib.md5(key.encode()).hexdigest()[:12]


def _pub_is_enriched(pub: dict) -> bool:
    """Check if a pub has been through the enrichment pipeline.

    Any enrichment field means it was processed — even if some fields
    are missing (e.g. no INSPIRE parcel match, no LiDAR coverage).
    Re-running with the same source data won't produce different results.
    """
    return any(k in pub for k in ("elev", "horizon", "outdoor", "local_authority"))


# ── Building height sampling ─────────────────────────────────────────────


def _gpkg_header_len(blob: bytes) -> int:
    if len(blob) < 8:
        return 0
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_type, 0)


def _sample_building_heights(
    ndsm: np.ndarray,
    dtm: np.ndarray | None,
    transform,
    osgb_polys: list[Polygon],
) -> list[tuple[float | None, float | None]]:
    """Sample 90th-percentile height per building (bbox-sliced for speed)."""
    if ndsm is None or ndsm.size == 0:
        return [(None, None)] * len(osgb_polys)

    h_px, w_px = ndsm.shape
    px_w = abs(transform.a)
    px_h = abs(transform.e)
    origin_x = transform.c
    origin_y = transform.f

    results: list[tuple[float | None, float | None]] = []
    for poly in osgb_polys:
        minx, miny, maxx, maxy = poly.bounds
        col0 = max(0, int(math.floor((minx - origin_x) / px_w)))
        col1 = min(w_px, int(math.ceil((maxx - origin_x) / px_w)))
        row0 = max(0, int(math.floor((origin_y - maxy) / px_h)))
        row1 = min(h_px, int(math.ceil((origin_y - miny) / px_h)))

        if col1 <= col0 or row1 <= row0:
            results.append((None, None))
            continue

        sub_origin_x = origin_x + col0 * px_w
        sub_origin_y = origin_y - row0 * px_h
        sub_tfm = from_origin(sub_origin_x, sub_origin_y, px_w, px_h)
        sub_shape = (row1 - row0, col1 - col0)

        try:
            mask = rasterize(
                [(poly, 1)], out_shape=sub_shape, transform=sub_tfm,
                fill=0, dtype=np.uint8,
            ).astype(bool)
        except Exception:
            results.append((None, None))
            continue

        if not mask.any():
            results.append((None, None))
            continue

        ndsm_sub = ndsm[row0:row1, col0:col1]
        ground = None
        if dtm is not None:
            dtm_sub = dtm[row0:row1, col0:col1]
            dtm_vals = dtm_sub[mask]
            valid_dtm = dtm_vals[dtm_vals > -100]
            if len(valid_dtm) > 0:
                ground = float(np.median(valid_dtm))

        vals = ndsm_sub[mask]
        above = vals[vals > MIN_HEIGHT_M]
        if len(above) > 0:
            results.append((float(np.percentile(above, 90)), ground))
        else:
            above = vals[vals > 2.0]
            if len(above) > 0:
                h = float(np.percentile(above, 90))
                results.append((h if h >= MIN_HEIGHT_M else None, ground))
            else:
                results.append((None, ground))

    return results


# ── Horizon computation ──────────────────────────────────────────────────


def _compute_horizon(dtm: np.ndarray, transform, cx: float, cy: float,
                     terrain50=None):
    """Vectorised horizon profile with optional long-range OS Terrain 50.

    Returns (elev, horizon_bytes, horizon_dist_bytes) or (None, None, None).
    """
    inv = ~transform
    col0, row0 = inv * (cx, cy)
    row0, col0 = int(round(row0)), int(round(col0))
    if row0 < 0 or row0 >= dtm.shape[0] or col0 < 0 or col0 >= dtm.shape[1]:
        return None, None, None
    pub_elev = float(dtm[row0, col0])
    if pub_elev <= 0:
        return None, None, None

    # Phase 1: 1m DTM (0-500m)
    sx = cx + _dx_all
    sy = cy + _dy_all
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

    terrain_elev = np.where(valid, dtm[rows_safe, cols_safe], 0.0)
    elev_diff = np.maximum(terrain_elev - pub_elev, 0.0)
    angles = np.where(valid, np.degrees(np.arctan2(elev_diff, _distances[np.newaxis, :])), 0.0)

    max_angles = angles.max(axis=1)
    max_indices = angles.argmax(axis=1)
    ridge_distances = _distances[max_indices].astype(float)

    # Phase 2: OS Terrain 50 (500-3000m)
    if terrain50 is not None and terrain50.available:
        T50_START, T50_END, T50_STEP = 550, 3000, 50
        t50_dists = np.arange(T50_START, T50_END + 1, T50_STEP)
        az_rad = _azimuths_rad[:, np.newaxis]
        t50_east = (cx + np.sin(az_rad) * t50_dists[np.newaxis, :]).ravel()
        t50_north = (cy + np.cos(az_rad) * t50_dists[np.newaxis, :]).ravel()

        t50_elevs = terrain50.elevation_array(t50_east, t50_north).reshape(N_AZIMUTHS, len(t50_dists))
        t50_diff = np.maximum(np.where(np.isnan(t50_elevs), 0.0, t50_elevs) - pub_elev, 0.0)
        t50_angles = np.degrees(np.arctan2(t50_diff, t50_dists[np.newaxis, :]))

        t50_max = t50_angles.max(axis=1)
        t50_max_idx = t50_angles.argmax(axis=1)
        t50_ridge_dist = t50_dists[t50_max_idx].astype(float)

        use_t50 = t50_max > max_angles
        max_angles = np.where(use_t50, t50_max, max_angles)
        ridge_distances = np.where(use_t50, t50_ridge_dist, ridge_distances)

    if max_angles.max() < MIN_HORIZON_DEG:
        return pub_elev, None, None
    horizon_bytes = bytes(min(255, int(a * 10)) for a in max_angles)
    horizon_dist_bytes = bytes(min(255, int(d / 12)) for d in ridge_distances)
    return pub_elev, horizon_bytes, horizon_dist_bytes


# ── Bundle discovery ─────────────────────────────────────────────────────


def _discover_bundles(pubs: list[dict]) -> dict[str, dict]:
    """Discover DTM+DSM bundle URIs for all 5km tiles covering pubs."""
    cells = pub_search_cells(pubs)
    print(f"  {len(pubs)} pubs -> {len(cells)} 10km search cells")

    bundles: dict[str, dict] = {}
    lock = threading.Lock()
    completed = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for results in ex.map(lambda c: search_cell(osgb_cell_to_geojson(c[0], c[1])), cells):
            completed += 1
            for r in results:
                prod = r.get("product", {}).get("id")
                year = r.get("year", {}).get("id")
                res = r.get("resolution", {}).get("id")
                if year != PRODUCT_YEAR or res != PRODUCT_RES:
                    continue
                tile = r.get("tile", {})
                tid = tile.get("id")
                uri = r.get("uri")
                if not tid or not uri:
                    continue
                with lock:
                    entry = bundles.setdefault(tid, {"dtm": None, "dsm": None, "label": tile.get("label", tid)})
                    if prod == PRODUCT_DTM:
                        entry["dtm"] = uri
                    elif prod == PRODUCT_DSM_LAST:
                        entry["dsm"] = uri
                    elif prod == PRODUCT_DSM_FIRST and not entry["dsm"]:
                        entry["dsm"] = uri
            if completed % 50 == 0 or completed == len(cells):
                rate = completed / (time.time() - t0) if time.time() > t0 else 0
                print(f"    search [{completed}/{len(cells)}] {rate:.1f}/s {eta_str(completed, len(cells), t0)}")

    # Keep bundles with at least DTM (DSM optional for height-only tiles).
    return {tid: v for tid, v in bundles.items() if v["dtm"]}


# ── Per-bundle processing ────────────────────────────────────────────────


def _process_bundle(
    tile_id: str,
    bundle: dict,
    pubs_in_tile: list[tuple[int, dict]],
    gpkg_path: str,
    existing_height_fids: set[int],
    parcel_tree: STRtree | None,
    all_parcels: list | None,
    all_parcel_las: list | None,
) -> dict:
    """Worker: download one 5km tile, enrich all pubs + buildings in it."""
    t0 = time.time()

    # Download DTM (always needed) + DSM (for building heights).
    dtm_zip = fetch_bundle_zip(bundle["dtm"])
    dsm_zip = fetch_bundle_zip(bundle["dsm"]) if bundle.get("dsm") else None
    download_s = time.time() - t0
    download_bytes = (len(dtm_zip) if dtm_zip else 0) + (len(dsm_zip) if dsm_zip else 0)

    if not dtm_zip:
        return {
            "tile_id": tile_id, "status": "fetch_failed",
            "pub_results": [], "height_updates": [], "elev_updates": [],
            "download_s": download_s, "download_bytes": download_bytes,
        }

    # Open DTM.
    dtm_ds, dtm_mem = open_bundle_tif(dtm_zip)
    if dtm_ds is None:
        if dtm_mem:
            dtm_mem.close()
        return {
            "tile_id": tile_id, "status": "decode_failed",
            "pub_results": [], "height_updates": [], "elev_updates": [],
            "download_s": download_s, "download_bytes": download_bytes,
        }

    try:
        dtm_arr = dtm_ds.read(1).astype(np.float32)
        dtm_arr = np.where(np.isnan(dtm_arr) | (dtm_arr < -100), 0, dtm_arr)
        dtm_transform = dtm_ds.transform
        dtm_bounds = dtm_ds.bounds
    finally:
        dtm_ds.close()
        dtm_mem.close()

    # Open DSM if available, compute nDSM.
    ndsm = None
    if dsm_zip:
        dsm_ds, dsm_mem = open_bundle_tif(dsm_zip)
        if dsm_ds is not None:
            try:
                dsm_arr = dsm_ds.read(1).astype(np.float32)
                dsm_arr = np.where(np.isnan(dsm_arr) | (dsm_arr < -100), 0, dsm_arr)
                if dsm_arr.shape == dtm_arr.shape:
                    ndsm = dsm_arr - dtm_arr
                    ndsm[ndsm < 0] = 0
            finally:
                dsm_ds.close()
                dsm_mem.close()

    # ── Building heights ─────────────────────────────────────────────
    height_updates: list[tuple[float, int]] = []
    elev_updates: list[tuple[float, int]] = []

    if ndsm is not None:
        # Load buildings in this tile from GPKG.
        conn = sqlite3.connect(f"file:{gpkg_path}?mode=ro", uri=True, timeout=60.0)
        conn.execute("PRAGMA busy_timeout=60000")
        try:
            lng1, lat1 = to_wgs.transform(dtm_bounds.left, dtm_bounds.bottom)
            lng2, lat2 = to_wgs.transform(dtm_bounds.right, dtm_bounds.top)
            min_lng, max_lng = min(lng1, lng2), max(lng1, lng2)
            min_lat, max_lat = min(lat1, lat2), max(lat1, lat2)
            try:
                rows = conn.execute(
                    "SELECT b.fid, b.geom, b.height, b.levels FROM buildings b "
                    "JOIN rtree_buildings_geom r ON b.fid = r.id "
                    "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
                    (min_lng, max_lng, min_lat, max_lat),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
        finally:
            conn.close()

        tile_buildings: list[tuple[int, Polygon, str, str]] = []
        for fid, blob, osm_h, levels in rows:
            if fid in existing_height_fids:
                continue
            try:
                hl = _gpkg_header_len(blob)
                geom = wkb.loads(blob[hl:])
                if geom.is_empty or not geom.is_valid:
                    continue
                osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
                poly = Polygon(osgb_coords)
                if not poly.is_valid or poly.is_empty:
                    continue
                cx, cy = poly.centroid.x, poly.centroid.y
                if not (dtm_bounds.left <= cx < dtm_bounds.right and dtm_bounds.bottom <= cy < dtm_bounds.top):
                    continue
                # Only bake heights for buildings near a pub.
                near_pub = False
                for _, pub in pubs_in_tile:
                    pe, pn = to_osgb.transform(pub["lng"], pub["lat"])
                    if (cx - pe) ** 2 + (cy - pn) ** 2 <= SHADOW_RADIUS_M ** 2:
                        near_pub = True
                        break
                if not near_pub:
                    continue
                tile_buildings.append((fid, poly, osm_h, levels))
            except Exception:
                continue

        if tile_buildings:
            osgb_polys = [b[1] for b in tile_buildings]
            results = _sample_building_heights(ndsm, dtm_arr, dtm_transform, osgb_polys)
            for (fid, _, osm_h, levels), (h, ground) in zip(tile_buildings, results):
                if h is not None and h >= MIN_HEIGHT_M:
                    height_updates.append((round(h, 1), fid))
                else:
                    fb = DEFAULT_HEIGHT_M
                    if osm_h:
                        try:
                            fb = float(osm_h.replace("m", "").strip())
                        except ValueError:
                            pass
                    if levels and fb == DEFAULT_HEIGHT_M:
                        try:
                            fb = int(levels) * 3.0
                        except ValueError:
                            pass
                    height_updates.append((round(fb, 1), fid))
                if ground is not None:
                    elev_updates.append((round(ground, 1), fid))

    # ── Per-pub enrichment ───────────────────────────────────────────
    pub_results: list[dict] = []

    for pub_idx, pub in pubs_in_tile:
        result: dict = {"index": pub_idx}
        cx, cy = to_osgb.transform(pub["lng"], pub["lat"])

        # Ground elevation + horizon from DTM (+ OS Terrain 50 for long range).
        pub_elev, horizon_bytes, horizon_dist_bytes = _compute_horizon(
            dtm_arr, dtm_transform, cx, cy, terrain50=_terrain50
        )
        if pub_elev is not None:
            result["elev"] = round(pub_elev, 1)
        if horizon_bytes is not None:
            result["horizon"] = base64.b64encode(horizon_bytes).decode("ascii")
        if horizon_dist_bytes is not None:
            result["horizon_dist"] = base64.b64encode(horizon_dist_bytes).decode("ascii")

        # INSPIRE parcel matching + outdoor area.
        if parcel_tree is not None and all_parcels is not None:
            pt = Point(cx, cy)
            candidates = parcel_tree.query(pt)
            parcel = None
            parcel_la = None
            for idx in candidates:
                if all_parcels[idx].contains(pt):
                    parcel = all_parcels[idx]
                    parcel_la = all_parcel_las[idx] if all_parcel_las else None
                    break

            if parcel is not None:
                result["local_authority"] = parcel_la

                # Compute outdoor area: parcel - nearby buildings.
                # Query buildings near this parcel from GPKG.
                conn2 = sqlite3.connect(f"file:{gpkg_path}?mode=ro", uri=True, timeout=60.0)
                conn2.execute("PRAGMA busy_timeout=60000")
                try:
                    pbox = parcel.bounds
                    buf = 8
                    plng1, plat1 = to_wgs.transform(pbox[0] - buf, pbox[1] - buf)
                    plng2, plat2 = to_wgs.transform(pbox[2] + buf, pbox[3] + buf)
                    try:
                        brows = conn2.execute(
                            "SELECT b.geom FROM buildings b "
                            "JOIN rtree_buildings_geom r ON b.fid = r.id "
                            "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
                            (min(plng1, plng2), max(plng1, plng2), min(plat1, plat2), max(plat1, plat2)),
                        ).fetchall()
                    except sqlite3.OperationalError:
                        brows = []
                finally:
                    conn2.close()

                nearby_buildings = []
                for (blob,) in brows:
                    try:
                        hl = _gpkg_header_len(blob)
                        geom = wkb.loads(blob[hl:])
                        if geom.is_empty or not geom.is_valid:
                            continue
                        osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
                        bpoly = Polygon(osgb_coords)
                        if bpoly.is_valid and bpoly.intersects(parcel):
                            nearby_buildings.append(bpoly)
                    except Exception:
                        continue

                if nearby_buildings:
                    buildings_union = unary_union(nearby_buildings)
                    outdoor = parcel.difference(buildings_union)
                    if not outdoor.is_empty:
                        if outdoor.geom_type == "MultiPolygon":
                            outdoor = max(outdoor.geoms, key=lambda g: g.area)
                        # Convert outdoor to WGS84 ring format.
                        rings = []
                        ext = outdoor.exterior.coords
                        rings.append([[round(lat, 6), round(lng, 6)] for lng, lat in
                                     [to_wgs.transform(x, y) for x, y in ext]])
                        for hole in outdoor.interiors:
                            rings.append([[round(lat, 6), round(lng, 6)] for lng, lat in
                                         [to_wgs.transform(x, y) for x, y in hole.coords]])
                        result["outdoor"] = rings
                        result["outdoor_area_m2"] = round(outdoor.area, 1)

        pub_results.append(result)

    return {
        "tile_id": tile_id,
        "status": "ok",
        "pub_results": pub_results,
        "height_updates": height_updates,
        "elev_updates": elev_updates,
        "download_s": download_s,
        "download_bytes": download_bytes,
        "buildings_heighted": len(height_updates),
        "pubs_enriched": len(pub_results),
    }


# ── INSPIRE parcel loading ───────────────────────────────────────────────


def _load_parcels_from_gpkg(
    gpkg_path: Path,
    pub_tree_for_filter: STRtree,
    min_x: float, max_x: float, min_y: float, max_y: float,
) -> tuple[list, list[str | None], int]:
    """Load parcels from one GeoPackage. Returns (parcels, las, scanned)."""
    import sqlite3 as _sq

    conn = _sq.connect(str(gpkg_path))
    cols = [r[1] for r in conn.execute("PRAGMA table_info(parcels)").fetchall()]
    has_la = "local_authority" in cols
    la_select = "p.local_authority" if has_la else "NULL AS local_authority"

    BATCH = 50000
    try:
        cursor = conn.execute(
            f"SELECT p.fid, p.geom, {la_select} FROM parcels p "
            "JOIN rtree_parcels_geom r ON p.fid = r.id "
            "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
            (min_x, max_x, min_y, max_y),
        )
    except _sq.OperationalError:
        cursor = conn.execute(f"SELECT fid, geom, {la_select} FROM parcels")

    parcels = []
    parcel_las: list[str | None] = []
    scanned = 0
    t0 = time.time()
    while True:
        batch = cursor.fetchmany(BATCH)
        if not batch:
            break
        for fid, blob, la in batch:
            scanned += 1
            try:
                hl = _gpkg_header_len(blob)
                geom = wkb.loads(blob[hl:])
                if geom.is_empty or not geom.is_valid:
                    continue
                nearby = pub_tree_for_filter.query(geom.buffer(50))
                if len(nearby) == 0:
                    continue
                prepare(geom)
                parcels.append(geom)
                parcel_las.append(la)
            except Exception:
                continue
        elapsed = time.time() - t0
        rate = scanned / elapsed if elapsed else 0
        print(f"    {gpkg_path.name}: {scanned:,} scanned, {len(parcels):,} kept  {rate:,.0f}/s", flush=True)

    conn.close()
    return parcels, parcel_las, scanned


def _load_parcels(pubs_osgb: list[tuple[float, float]]) -> tuple:
    """Load parcels from INSPIRE (England+Wales) and Scotland GPKGs.

    Returns (STRtree, parcels, LAs) or (None, None, None).
    """
    gpkgs = []
    if INSPIRE_GPKG.exists():
        gpkgs.append(INSPIRE_GPKG)
    if SCOTLAND_GPKG.exists():
        gpkgs.append(SCOTLAND_GPKG)
    if not gpkgs:
        print("  WARNING: no parcel GeoPackages found — skipping parcel matching")
        return None, None, None

    pub_xs = [p[0] for p in pubs_osgb]
    pub_ys = [p[1] for p in pubs_osgb]
    min_x, max_x = min(pub_xs) - 50, max(pub_xs) + 50
    min_y, max_y = min(pub_ys) - 50, max(pub_ys) + 50
    pub_tree_for_filter = STRtree([Point(x, y) for x, y in pubs_osgb])

    all_parcels = []
    all_las: list[str | None] = []
    total_scanned = 0

    for gpkg in gpkgs:
        print(f"  Loading parcels from {gpkg.name}...", flush=True)
        parcels, las, scanned = _load_parcels_from_gpkg(
            gpkg, pub_tree_for_filter, min_x, max_x, min_y, max_y,
        )
        all_parcels.extend(parcels)
        all_las.extend(las)
        total_scanned += scanned

    print(f"  {len(all_parcels):,} parcels near pubs (from {total_scanned:,} scanned across {len(gpkgs)} GPKGs)")

    if not all_parcels:
        return None, None, None
    return STRtree(all_parcels), all_parcels, all_las


# ── Main ─────────────────────────────────────────────────────────────────


def run(area) -> dict:
    """Run the ENRICH stage. Returns stats dict."""
    from pipeline.utils.areas import in_bbox
    from pipeline.utils.terrain50 import Terrain50, download_terrain50

    # Ensure OS Terrain 50 is available for long-range horizon rays.
    download_terrain50()
    global _terrain50
    _terrain50 = Terrain50()
    if _terrain50.available:
        print("  OS Terrain 50 loaded for long-range horizons")
    else:
        print("  WARNING: OS Terrain 50 not available — horizons limited to 500m")
        _terrain50 = None

    pubs_file = PUBS_PATH if PUBS_PATH.exists() else PUBS_PATH_V1
    if not pubs_file.exists():
        raise FileNotFoundError(f"Neither {PUBS_PATH} nor {PUBS_PATH_V1} found — run extract first")

    # Load pubs.
    print(f"  Reading pubs from {pubs_file.name}")
    all_pubs = json.loads(pubs_file.read_text())
    # If enriched file exists, merge existing enrichments.
    if ENRICHED_PATH.exists():
        enriched = json.loads(ENRICHED_PATH.read_text())
        enriched_by_id = {p.get("id") or p.get("osm_id"): p for p in enriched if p.get("id") or p.get("osm_id")}
        merged_count = 0
        for pub in all_pubs:
            oid = pub.get("id") or pub.get("osm_id")
            if oid and oid in enriched_by_id:
                for k in ("elev", "horizon", "horizon_dist", "outdoor", "outdoor_area_m2", "local_authority", "_enrich_hash"):
                    if k in enriched_by_id[oid]:
                        pub[k] = enriched_by_id[oid][k]
                merged_count += 1
        print(f"  Merged enrichments from previous run for {merged_count} pubs")

    # Filter to area.
    area_pubs = [(i, p) for i, p in enumerate(all_pubs) if in_bbox(p["lat"], p["lng"], area.bbox)]
    print(f"  {len(area_pubs)} pubs in {area.name}")

    # Identify pubs needing work. A pub is skipped if it was already
    # processed in a previous run (exists in enriched output by ID) AND
    # its source data hasn't changed (same hash). Re-running a pub that
    # was processed but missing fields (no parcel match, no LiDAR) is
    # pointless — the source data hasn't changed so the result won't either.
    prev_ids = set(enriched_by_id.keys()) if ENRICHED_PATH.exists() else set()
    pubs_to_process = []
    skipped = 0
    for i, pub in area_pubs:
        pub_id = pub.get("id") or pub.get("osm_id")
        if pub_id in prev_ids:
            # Only skip if the pub was MEANINGFULLY enriched (has at least
            # elev or outdoor). Pubs written to enriched output during a
            # failed/killed run may exist by ID but have no actual data.
            if _pub_is_enriched(pub):
                h = _pub_hash(pub)
                prev_hash = pub.get("_enrich_hash")
                if prev_hash is None or prev_hash == h:
                    skipped += 1
                    continue
        pub["_enrich_hash"] = _pub_hash(pub)
        pubs_to_process.append((i, pub))

    print(f"  {skipped} pubs skipped (unchanged + already enriched)")
    print(f"  {len(pubs_to_process)} pubs need enrichment")

    if not pubs_to_process:
        ENRICHED_PATH.write_text(json.dumps(all_pubs, indent=2))
        return {"pubs_enriched": 0, "pubs_skipped": skipped}

    # Load parcels from both INSPIRE (England+Wales) and Scotland GPKGs.
    # Use all pubs for bbox filtering so border-region pubs aren't missed.
    all_osgb = [to_osgb.transform(p["lng"], p["lat"]) for _, p in pubs_to_process]
    all_parcels_list: list = []
    all_las_list: list[str | None] = []

    if all_osgb and INSPIRE_GPKG.exists():
        print(f"  Loading INSPIRE parcels (England+Wales)...")
        pub_tree = STRtree([Point(x, y) for x, y in all_osgb])
        p, l, s = _load_parcels_from_gpkg(
            INSPIRE_GPKG, pub_tree,
            min(x for x, y in all_osgb) - 50, max(x for x, y in all_osgb) + 50,
            min(y for x, y in all_osgb) - 50, max(y for x, y in all_osgb) + 50,
        )
        all_parcels_list.extend(p)
        all_las_list.extend(l)
        print(f"    {len(p):,} INSPIRE parcels kept (from {s:,} scanned)")

    if all_osgb and SCOTLAND_GPKG.exists():
        print(f"  Loading Scotland parcels...")
        pub_tree = STRtree([Point(x, y) for x, y in all_osgb])
        p, l, s = _load_parcels_from_gpkg(
            SCOTLAND_GPKG, pub_tree,
            min(x for x, y in all_osgb) - 50, max(x for x, y in all_osgb) + 50,
            min(y for x, y in all_osgb) - 50, max(y for x, y in all_osgb) + 50,
        )
        all_parcels_list.extend(p)
        all_las_list.extend(l)
        print(f"    {len(p):,} Scotland parcels kept (from {s:,} scanned)")

    parcel_tree = STRtree(all_parcels_list) if all_parcels_list else None
    all_parcels = all_parcels_list if all_parcels_list else None
    all_parcel_las = all_las_list if all_las_list else None
    print(f"  {len(all_parcels_list):,} total parcels loaded")

    # Discover DTM+DSM bundles.
    print("\n  Discovering LiDAR bundles...")
    pubs_for_discovery = [p for _, p in pubs_to_process]
    bundles = _discover_bundles(pubs_for_discovery)
    print(f"  {len(bundles)} bundles found")

    # Assign pubs to bundles by 5km tile.
    tile_pub_map: dict[str, list[tuple[int, dict]]] = {tid: [] for tid in bundles}
    unmatched_pubs: list[tuple[int, dict]] = []
    tile_bboxes = {tid: label_to_bbox(b["label"]) for tid, b in bundles.items()}
    tile_bboxes = {tid: bb for tid, bb in tile_bboxes.items() if bb}

    for gi, pub in pubs_to_process:
        cx, cy = to_osgb.transform(pub["lng"], pub["lat"])
        matched = False
        for tid, (emin, nmin, emax, nmax) in tile_bboxes.items():
            if emin <= cx < emax and nmin <= cy < nmax:
                tile_pub_map[tid].append((gi, pub))
                matched = True
                break
        if not matched:
            unmatched_pubs.append((gi, pub))

    # Drop empty tiles.
    tile_pub_map = {tid: pubs for tid, pubs in tile_pub_map.items() if pubs}
    if unmatched_pubs:
        print(f"  {len(unmatched_pubs)} pubs not in Defra bundles (Wales/Scotland — Phase 2)")
    print(f"  {len(tile_pub_map)} bundle tiles + {len(unmatched_pubs)} WCS/COG pubs to process\n")

    # Load existing building heights for skip logic.
    conn = sqlite3.connect(str(GPKG_PATH), timeout=60.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")
    conn.execute("PRAGMA synchronous=NORMAL")

    # Ensure columns exist.
    cols = [r[1] for r in conn.execute("PRAGMA table_info(buildings)")]
    if "lidar_height" not in cols:
        conn.execute("ALTER TABLE buildings ADD COLUMN lidar_height REAL")
    if "ground_elev" not in cols:
        conn.execute("ALTER TABLE buildings ADD COLUMN ground_elev REAL")
    conn.commit()

    existing_fids = {r[0] for r in conn.execute(
        "SELECT fid FROM buildings WHERE lidar_height IS NOT NULL"
    ).fetchall()}

    # Register dummy spatial functions for GPKG triggers.
    conn.create_function("ST_IsEmpty", 1, lambda g: 0)
    conn.create_function("ST_MinX", 1, lambda g: 0.0)
    conn.create_function("ST_MaxX", 1, lambda g: 0.0)
    conn.create_function("ST_MinY", 1, lambda g: 0.0)
    conn.create_function("ST_MaxY", 1, lambda g: 0.0)

    # Process tiles in parallel.
    stats = {
        "started_at": time.time(),
        "total_tiles": len(tile_pub_map),
        "completed": 0,
        "pubs_enriched": 0,
        "buildings_heighted": 0,
        "bytes_downloaded": 0,
    }
    t0 = stats["started_at"]
    last_save = t0
    items = sorted(tile_pub_map.items())

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {
            ex.submit(
                _process_bundle, tid, bundles[tid], pubs,
                str(GPKG_PATH), existing_fids,
                parcel_tree, all_parcels, all_parcel_las,
            ): tid
            for tid, pubs in items
        }
        for future in as_completed(futures):
            stats["completed"] += 1
            done = stats["completed"]
            try:
                r = future.result()
            except Exception as exc:
                tid = futures[future]
                print(f"  [{done}/{len(items)}] {tid} EXC: {exc}")
                continue

            if r["status"] != "ok":
                print(f"  [{done}/{len(items)}] {bundles[futures[future]]['label']} {r['status']}")
                continue

            # Write building heights.
            if r["height_updates"]:
                conn.executemany(
                    "UPDATE buildings SET lidar_height = ? WHERE fid = ?",
                    r["height_updates"],
                )
            if r["elev_updates"]:
                conn.executemany(
                    "UPDATE buildings SET ground_elev = ? WHERE fid = ?",
                    r["elev_updates"],
                )
            if done % 20 == 0:
                conn.commit()

            # Apply pub enrichments.
            for pr in r["pub_results"]:
                gi = pr["index"]
                for k in ("elev", "horizon", "horizon_dist", "outdoor", "outdoor_area_m2", "local_authority"):
                    if k in pr:
                        all_pubs[gi][k] = pr[k]

            stats["pubs_enriched"] += len(r["pub_results"])
            stats["buildings_heighted"] += r["buildings_heighted"]
            stats["bytes_downloaded"] += r["download_bytes"]

            elapsed = time.time() - t0
            rate = done / elapsed if elapsed else 0
            label = bundles[futures[future]]["label"]
            print(
                f"  [{done}/{len(items)}] {label:<8} "
                f"{r['pubs_enriched']}p {r['buildings_heighted']}b "
                f"dl {r['download_s']:.0f}s "
                f"{rate:.2f}/s {eta_str(done, len(items), t0)}"
            )
            if done % 5 == 0:
                write_progress("enrich", stats)

            # Incremental save.
            if time.time() - last_save > SAVE_INTERVAL:
                conn.commit()
                tmp = ENRICHED_PATH.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(all_pubs, indent=2))
                tmp.replace(ENRICHED_PATH)
                print(f"  ** incremental save **", flush=True)
                last_save = time.time()

    conn.commit()

    # ── Phase 2: WCS/COG fallback for Wales + Scotland ───────────────
    #
    # Pubs not matched to any Defra bundle (unmatched_pubs) are processed
    # via the v1 WCS/COG fetchers: NRW COG for Wales, JNCC WCS for
    # Scotland. Each pub gets a 1km OSGB tile fetch. Heights + horizons
    # are computed in the same pass since we have the DTM in memory.

    if unmatched_pubs:
        print(f"\n  Phase 2: processing {len(unmatched_pubs)} Wales/Scotland pubs via WCS/COG...")
        phase2_t0 = time.time()
        phase2_done = 0
        TILE_SIZE = 1000

        for gi, pub in unmatched_pubs:
            cx, cy = to_osgb.transform(pub["lng"], pub["lat"])
            # 1km OSGB tile containing this pub.
            te = int(cx // TILE_SIZE) * TILE_SIZE
            tn = int(cy // TILE_SIZE) * TILE_SIZE
            w, s, e, n = te, tn, te + TILE_SIZE, tn + TILE_SIZE

            ndsm, dtm_arr, tfm = _fetch_ndsm_wcs(w, s, e, n)

            result: dict = {"index": gi}

            # Horizon + elevation from DTM (+ OS Terrain 50 for long range).
            if dtm_arr is not None:
                pub_elev, horizon_bytes, horizon_dist_bytes = _compute_horizon(
                    dtm_arr, tfm, cx, cy, terrain50=_terrain50
                )
                if pub_elev is not None:
                    result["elev"] = round(pub_elev, 1)
                if horizon_bytes is not None:
                    result["horizon"] = base64.b64encode(horizon_bytes).decode("ascii")
                if horizon_dist_bytes is not None:
                    result["horizon_dist"] = base64.b64encode(horizon_dist_bytes).decode("ascii")

            # Building heights from nDSM.
            if ndsm is not None:
                # Query nearby buildings from GPKG.
                lng1, lat1 = to_wgs.transform(w, s)
                lng2, lat2 = to_wgs.transform(e, n)
                min_lng, max_lng = min(lng1, lng2), max(lng1, lng2)
                min_lat, max_lat = min(lat1, lat2), max(lat1, lat2)
                try:
                    rows = conn.execute(
                        "SELECT b.fid, b.geom, b.height, b.levels FROM buildings b "
                        "JOIN rtree_buildings_geom r ON b.fid = r.id "
                        "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
                        (min_lng, max_lng, min_lat, max_lat),
                    ).fetchall()
                except sqlite3.OperationalError:
                    rows = []

                tile_buildings = []
                for fid, blob, osm_h, levels in rows:
                    if fid in existing_fids:
                        continue
                    try:
                        hl = _gpkg_header_len(blob)
                        geom = wkb.loads(blob[hl:])
                        if geom.is_empty or not geom.is_valid:
                            continue
                        osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
                        poly = Polygon(osgb_coords)
                        if poly.is_valid and not poly.is_empty:
                            pcx, pcy = poly.centroid.x, poly.centroid.y
                            if (pcx - cx) ** 2 + (pcy - cy) ** 2 <= SHADOW_RADIUS_M ** 2:
                                tile_buildings.append((fid, poly, osm_h, levels))
                    except Exception:
                        continue

                if tile_buildings:
                    osgb_polys = [b[1] for b in tile_buildings]
                    ht_results = _sample_building_heights(ndsm, dtm_arr, tfm, osgb_polys)
                    for (fid, _, osm_h, levels), (h, ground) in zip(tile_buildings, ht_results):
                        if h is not None and h >= MIN_HEIGHT_M:
                            conn.execute("UPDATE buildings SET lidar_height = ? WHERE fid = ?", (round(h, 1), fid))
                        if ground is not None:
                            conn.execute("UPDATE buildings SET ground_elev = ? WHERE fid = ?", (round(ground, 1), fid))
                    stats["buildings_heighted"] += len(tile_buildings)

            # INSPIRE parcel matching + outdoor area (same as Phase 1).
            if parcel_tree is not None and all_parcels is not None:
                pt = Point(cx, cy)
                candidates = parcel_tree.query(pt)
                parcel = None
                parcel_la = None
                for idx in candidates:
                    if all_parcels[idx].contains(pt):
                        parcel = all_parcels[idx]
                        parcel_la = all_parcel_las[idx] if all_parcel_las else None
                        break

                if parcel is not None:
                    result["local_authority"] = parcel_la

                    # Compute outdoor area: parcel - nearby buildings.
                    conn2 = sqlite3.connect(f"file:{gpkg_path}?mode=ro", uri=True, timeout=60.0)
                    conn2.execute("PRAGMA busy_timeout=60000")
                    try:
                        pbox = parcel.bounds
                        buf = 8
                        plng1, plat1 = to_wgs.transform(pbox[0] - buf, pbox[1] - buf)
                        plng2, plat2 = to_wgs.transform(pbox[2] + buf, pbox[3] + buf)
                        try:
                            brows = conn2.execute(
                                "SELECT b.geom FROM buildings b "
                                "JOIN rtree_buildings_geom r ON b.fid = r.id "
                                "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
                                (min(plng1, plng2), max(plng1, plng2), min(plat1, plat2), max(plat1, plat2)),
                            ).fetchall()
                        except sqlite3.OperationalError:
                            brows = []
                    finally:
                        conn2.close()

                    nearby_buildings = []
                    for (blob,) in brows:
                        try:
                            hl = _gpkg_header_len(blob)
                            geom = wkb.loads(blob[hl:])
                            if geom.is_empty or not geom.is_valid:
                                continue
                            osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
                            bpoly = Polygon(osgb_coords)
                            if bpoly.is_valid and bpoly.intersects(parcel):
                                nearby_buildings.append(bpoly)
                        except Exception:
                            continue

                    if nearby_buildings:
                        buildings_union = unary_union(nearby_buildings)
                        outdoor = parcel.difference(buildings_union)
                        if not outdoor.is_empty:
                            if outdoor.geom_type == "MultiPolygon":
                                outdoor = max(outdoor.geoms, key=lambda g: g.area)
                            rings = []
                            ext = outdoor.exterior.coords
                            rings.append([[round(lat, 6), round(lng, 6)] for lng, lat in
                                         [to_wgs.transform(x, y) for x, y in ext]])
                            for hole in outdoor.interiors:
                                rings.append([[round(lat, 6), round(lng, 6)] for lng, lat in
                                             [to_wgs.transform(x, y) for x, y in hole.coords]])
                            result["outdoor"] = rings
                            result["outdoor_area_m2"] = round(outdoor.area, 1)

            # Apply enrichments.
            for k in ("elev", "horizon", "horizon_dist", "local_authority", "outdoor", "outdoor_area_m2"):
                if k in result:
                    all_pubs[gi][k] = result[k]

            phase2_done += 1
            stats["pubs_enriched"] += 1
            if phase2_done % 50 == 0:
                conn.commit()
                elapsed = time.time() - phase2_t0
                rate = phase2_done / elapsed if elapsed else 0
                print(
                    f"  Phase 2: [{phase2_done}/{len(unmatched_pubs)}] "
                    f"{rate:.1f}/s {eta_str(phase2_done, len(unmatched_pubs), phase2_t0)}"
                )

        conn.commit()
        print(f"  Phase 2 done: {phase2_done} pubs enriched")

    conn.close()

    # Final save.
    ENRICHED_PATH.write_text(json.dumps(all_pubs, indent=2))
    write_progress("enrich", stats)

    elapsed = time.time() - t0
    return {
        "pubs_enriched": stats["pubs_enriched"],
        "pubs_skipped": skipped,
        "buildings_heighted": stats["buildings_heighted"],
        "tiles_processed": stats["completed"],
        "gb_downloaded": round(stats["bytes_downloaded"] / 1e9, 1),
        "duration_s": round(elapsed, 1),
    }
