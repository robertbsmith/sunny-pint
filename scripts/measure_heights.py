"""Sample building heights from LiDAR DSM/DTM and bake into GeoPackage.

Two-phase fetch:
  1. Bundle phase (England) — pulls 5km zipped GeoTIFFs from the Defra
     survey catalogue API. ~10× faster than WCS per km², covers most pubs.
  2. WCS phase (remaining buildings) — falls back to per-1km WCS for
     anything Phase 1 couldn't reach: Wales (NRW COG), Scotland (JNCC WCS),
     or English gaps where the catalogue had no 2022 1m composite.

Both phases write into the same `lidar_height` / `ground_elev` columns and
are idempotent: building rows that already have a height are skipped, so
the script is safe to re-run after a crash.

Live progress is also written to `data/heights_progress.json` every few
bundles for easy `cat`/`jq` monitoring from another shell.

Usage:
    uv run python scripts/measure_heights.py --area norwich
    uv run python scripts/measure_heights.py --area uk
"""

import json
import math
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path

import numpy as np
import rasterio
from areas import Area, in_bbox, parse_area
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.windows import from_bounds
from shapely import wkb
from shapely.geometry import Polygon

# ── Paths ──────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GPKG_PATH = DATA_DIR / "buildings.gpkg"
LIDAR_DIR = DATA_DIR / "lidar"

# ── Coordinate transforms ─────────────────────────────────────────────────

to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
to_wgs = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)

# ── LiDAR sources ─────────────────────────────────────────────────────────

EA_DSM_WCS = (
    "https://environment.data.gov.uk/spatialdata/"
    "lidar-composite-digital-surface-model-last-return-dsm-1m/wcs"
)
EA_DSM_COV = (
    "9ba4d5ac-d596-445a-9056-dae3ddec0178__"
    "Lidar_Composite_Elevation_LZ_DSM_1m"
)
EA_DTM_WCS = (
    "https://environment.data.gov.uk/spatialdata/"
    "lidar-composite-digital-terrain-model-dtm-1m/wcs"
)
EA_DTM_COV = (
    "13787b9a-26a4-4775-8523-806d13af58fc__"
    "Lidar_Composite_Elevation_DTM_1m"
)

JNCC_WCS_BASE = "https://srsp-ows.jncc.gov.uk/ows"
JNCC_DSM_PHASES = [f"scotland__scotland-lidar-{i}-dsm" for i in range(1, 7)]
JNCC_DTM_PHASES = [f"scotland__scotland-lidar-{i}-dtm" for i in range(1, 7)]

NRW_DSM_COG = (
    "https://dmwproductionblob.blob.core.windows.net/cogs/lidar/"
    "wales_dsm_32bit_cog.tif"
)
NRW_DTM_COG = (
    "https://dmwproductionblob.blob.core.windows.net/cogs/lidar/"
    "wales_dtm_32bit_cog.tif"
)

# Defra survey catalogue API — primary path. Returns 5km LZW-compressed
# GeoTIFF bundles, ~10× faster per km² than WCS. England-only.
SURVEY_SEARCH_URL = (
    "https://environment.data.gov.uk/backend/catalog/api/tiles/"
    "collections/survey/search"
)
SURVEY_TILE_KEY = "dspui"  # public subscription key the dspui frontend uses
SURVEY_HEADERS = {
    "Content-Type": "application/geo+json",
    "Accept": "*/*",
    "Origin": "https://environment.data.gov.uk",
    "Referer": "https://environment.data.gov.uk/survey",
    "User-Agent": "SunnyPint/0.1 (+https://sunny-pint.co.uk)",
}
PRODUCT_DTM = "lidar_composite_dtm"
PRODUCT_DSM_LAST = "lidar_composite_last_return_dsm"
PRODUCT_DSM_FIRST = "lidar_composite_first_return_dsm"
PRODUCT_YEAR = "2022"
PRODUCT_RES = "1"

# ── Constants ─────────────────────────────────────────────────────────────

MIN_HEIGHT_M = 3.0   # buildings shorter than this are filtered
DEFAULT_HEIGHT_M = 8.0
TILE_SIZE_M = 1000    # WCS phase: iterate by 1km tiles (matches EA grid)
WCS_WORKERS = 8       # parallel HTTP fetches for both bundle + WCS phases


# ── Height sampling ───────────────────────────────────────────────────────


def sample_heights(
    ndsm: np.ndarray,
    dtm: np.ndarray | None,
    transform,
    osgb_polys: list[Polygon],
) -> list[tuple[float | None, float | None]]:
    """Sample 90th-percentile height and ground elevation per building.

    ndsm = DSM - DTM (height above ground).
    dtm = bare ground elevation (above sea level), or None.
    Returns list of (height, ground_elev) tuples.

    Each building is rasterised + masked inside its own pixel bounding box,
    so per-building cost stays O(building area) instead of O(tile area). This
    matters at 4km tiles where the full label array is 16M cells.
    """
    if ndsm is None or ndsm.size == 0:
        return [(None, None)] * len(osgb_polys)

    h_px, w_px = ndsm.shape
    # Pixel size from the affine: |a| east-west, |e| north-south.
    px_w = abs(transform.a)
    px_h = abs(transform.e)
    # Origin (top-left) world coords.
    origin_x = transform.c
    origin_y = transform.f

    results: list[tuple[float | None, float | None]] = []
    for poly in osgb_polys:
        minx, miny, maxx, maxy = poly.bounds
        # World → pixel indices. Note y is flipped (origin at top).
        col0 = max(0, int(math.floor((minx - origin_x) / px_w)))
        col1 = min(w_px, int(math.ceil((maxx - origin_x) / px_w)))
        row0 = max(0, int(math.floor((origin_y - maxy) / px_h)))
        row1 = min(h_px, int(math.ceil((origin_y - miny) / px_h)))

        if col1 <= col0 or row1 <= row0:
            results.append((None, None))
            continue

        # Build a tile-local affine for the slice.
        sub_origin_x = origin_x + col0 * px_w
        sub_origin_y = origin_y - row0 * px_h
        sub_tfm = from_origin(sub_origin_x, sub_origin_y, px_w, px_h)
        sub_shape = (row1 - row0, col1 - col0)

        try:
            mask = rasterize(
                [(poly, 1)],
                out_shape=sub_shape,
                transform=sub_tfm,
                fill=0,
                dtype=np.uint8,
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


# ── LiDAR fetching ────────────────────────────────────────────────────────


_last_wcs_time = 0.0
_wcs_lock = threading.Lock()
WCS_DELAY_S = 0.1  # minimum seconds between WCS requests (shared across workers)
WCS_MAX_RETRIES = 3


def _fetch_tiff_bytes(url: str, timeout: int = 120) -> bytes | None:
    """Fetch a GeoTIFF from a URL with rate limiting and retry.

    Returns bytes or None on failure. Thread-safe — multiple workers share
    the global rate limiter via _wcs_lock.
    """
    global _last_wcs_time

    for attempt in range(WCS_MAX_RETRIES):
        # Rate limit: serialize the spacing across all worker threads.
        with _wcs_lock:
            elapsed = time.time() - _last_wcs_time
            if elapsed < WCS_DELAY_S:
                time.sleep(WCS_DELAY_S - elapsed)
            _last_wcs_time = time.time()

        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "SunnyPint/0.1 (+https://sunny-pint.co.uk)")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if data[:2] in (b"II", b"MM") and len(data) > 1000:
                return data
            return None
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 503, 504) and attempt < WCS_MAX_RETRIES - 1:
                wait = (attempt + 1) * 5  # 5s, 10s, 15s backoff
                print(f"  (HTTP {exc.code}, retry in {wait}s)", end="", flush=True)
                time.sleep(wait)
                continue
            print(f"WCS error: {exc}")
            return None
        except Exception as exc:
            print(f"WCS error: {exc}")
            return None

    return None


def _read_tiff_bytes(data: bytes):
    """Read a GeoTIFF from bytes. Returns (array, transform) or (None, None)."""
    with rasterio.open(BytesIO(data)) as ds:
        arr = ds.read(1).astype(np.float32)
        arr = np.where(np.isnan(arr) | (arr < -100), 0, arr)
        return arr, ds.transform


def _ea_wcs_url(wcs_base: str, coverage_id: str, w, s, e, n) -> str:
    return (
        f"{wcs_base}?service=WCS&version=2.0.1&request=GetCoverage"
        f"&CoverageId={coverage_id}"
        f"&format=image/tiff"
        f"&subset=E({int(w)},{int(e)})"
        f"&subset=N({int(s)},{int(n)})"
        f"&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/27700"
    )


# ── Local tile index ──────────────────────────────────────────────────────

_tile_index: list[tuple[Path, rasterio.coords.BoundingBox]] | None = None


def _get_tile_index() -> list[tuple[Path, rasterio.coords.BoundingBox]]:
    """Build or return cached index of local LiDAR DSM tiles."""
    global _tile_index
    if _tile_index is not None:
        return _tile_index
    _tile_index = []
    if not LIDAR_DIR.exists():
        return _tile_index
    for path in sorted(LIDAR_DIR.glob("dsm_*.tif")):
        try:
            with rasterio.open(path) as ds:
                _tile_index.append((path, ds.bounds))
        except Exception:
            continue
    return _tile_index


def _read_mosaic(paths: list[Path], w, s, e, n):
    """Read and mosaic multiple tiles into one array for an OSGB bbox."""
    w, s, e, n = math.floor(w), math.floor(s), math.ceil(e), math.ceil(n)
    cols = int(e - w)
    rows = int(n - s)
    out = np.zeros((rows, cols), dtype=np.float32)
    tfm = from_origin(w, n, 1.0, 1.0)

    for path in paths:
        with rasterio.open(path) as ds:
            tb = ds.bounds
            ol, ob = max(w, tb.left), max(s, tb.bottom)
            or_, ot = min(e, tb.right), min(n, tb.top)
            if ol >= or_ or ob >= ot:
                continue
            win = from_bounds(ol, ob, or_, ot, ds.transform)
            tile = ds.read(1, window=win)
            tile = np.where(np.isnan(tile) | (tile < -100), 0, tile)
            c0, r0 = int(ol - w), int(n - ot)
            th, tw = tile.shape
            out[r0:r0 + th, c0:c0 + tw] = np.maximum(
                out[r0:r0 + th, c0:c0 + tw], tile
            )

    return (out, tfm) if out.max() > 1.0 else (None, None)


def fetch_local(w, s, e, n):
    """Fetch DSM and DTM from local tiles. Returns (ndsm, dtm, transform)."""
    index = _get_tile_index()
    if not index:
        return None, None, None

    matching_dsm = [
        p for p, b in index
        if b.right > w and b.left < e and b.top > s and b.bottom < n
    ]
    if not matching_dsm:
        return None, None, None

    dsm, tfm = _read_mosaic(matching_dsm, w, s, e, n)
    if dsm is None:
        return None, None, None

    matching_dtm = [
        Path(str(p).replace("dsm_", "dtm_")) for p in matching_dsm
    ]
    matching_dtm = [p for p in matching_dtm if p.exists()]

    if matching_dtm:
        dtm, _ = _read_mosaic(matching_dtm, w, s, e, n)
        if dtm is not None:
            ndsm = dsm - dtm
            ndsm[ndsm < 0] = 0
            return ndsm, dtm, tfm

    dtm_data = _fetch_tiff_bytes(_ea_wcs_url(EA_DTM_WCS, EA_DTM_COV, w, s, e, n))
    if dtm_data is not None:
        dtm, dtm_tfm = _read_tiff_bytes(dtm_data)
        if dtm.shape == dsm.shape:
            ndsm = dsm - dtm
            ndsm[ndsm < 0] = 0
            return ndsm, dtm, tfm

    ndsm, tfm = _dsm_with_ground_estimate(dsm, tfm)
    return ndsm, None, tfm


def fetch_ea_wcs(w, s, e, n):
    """Fetch DSM and DTM from EA WCS (England). Returns (ndsm, dtm, transform)."""
    dsm_data = _fetch_tiff_bytes(_ea_wcs_url(EA_DSM_WCS, EA_DSM_COV, w, s, e, n))
    if dsm_data is None:
        return None, None, None
    dsm, tfm = _read_tiff_bytes(dsm_data)

    dtm_data = _fetch_tiff_bytes(_ea_wcs_url(EA_DTM_WCS, EA_DTM_COV, w, s, e, n))
    if dtm_data is not None:
        dtm, _ = _read_tiff_bytes(dtm_data)
        if dtm.shape == dsm.shape:
            ndsm = dsm - dtm
            ndsm[ndsm < 0] = 0
            return ndsm, dtm, tfm

    ndsm, tfm = _dsm_with_ground_estimate(dsm, tfm)
    return ndsm, None, tfm


def fetch_jncc_wcs(w, s, e, n):
    """Fetch from JNCC WCS (Scotland). Returns (ndsm, dtm, transform)."""
    for dsm_phase, dtm_phase in zip(JNCC_DSM_PHASES, JNCC_DTM_PHASES):
        dsm_url = (
            f"{JNCC_WCS_BASE}?service=WCS&version=2.0.1&request=GetCoverage"
            f"&CoverageId={dsm_phase}&format=image/tiff"
            f"&subset=E({int(w)},{int(e)})&subset=N({int(s)},{int(n)})"
        )
        dsm_data = _fetch_tiff_bytes(dsm_url, timeout=60)
        if dsm_data is None:
            continue
        dsm, tfm = _read_tiff_bytes(dsm_data)
        if dsm.max() < 1.0:
            continue

        dtm_url = (
            f"{JNCC_WCS_BASE}?service=WCS&version=2.0.1&request=GetCoverage"
            f"&CoverageId={dtm_phase}&format=image/tiff"
            f"&subset=E({int(w)},{int(e)})&subset=N({int(s)},{int(n)})"
        )
        dtm_data = _fetch_tiff_bytes(dtm_url, timeout=60)
        if dtm_data is not None:
            dtm, _ = _read_tiff_bytes(dtm_data)
            if dtm.shape == dsm.shape:
                ndsm = dsm - dtm
                ndsm[ndsm < 0] = 0
                return ndsm, dtm, tfm

        ndsm, tfm = _dsm_with_ground_estimate(dsm, tfm)
        return ndsm, None, tfm

    return None, None, None


def fetch_nrw_cog(w, s, e, n):
    """Fetch from NRW COG (Wales). Returns (ndsm, dtm, transform)."""
    try:
        with rasterio.open(NRW_DSM_COG) as src:
            win = from_bounds(w, s, e, n, src.transform)
            dsm = src.read(1, window=win).astype(np.float32)
            dsm = np.where(np.isnan(dsm) | (dsm < -100), 0, dsm)
            if dsm.max() < 1.0:
                return None, None, None
            tfm = rasterio.windows.transform(win, src.transform)
    except Exception:
        return None, None, None

    try:
        with rasterio.open(NRW_DTM_COG) as src:
            win = from_bounds(w, s, e, n, src.transform)
            dtm = src.read(1, window=win).astype(np.float32)
            dtm = np.where(np.isnan(dtm) | (dtm < -100), 0, dtm)
            if dtm.shape == dsm.shape:
                ndsm = dsm - dtm
                ndsm[ndsm < 0] = 0
                return ndsm, dtm, tfm
    except Exception:
        pass

    ndsm, tfm = _dsm_with_ground_estimate(dsm, tfm)
    return ndsm, None, tfm


def _dsm_with_ground_estimate(dsm, tfm):
    """Fallback: estimate ground from DSM using sliding window minimum."""
    h, w = dsm.shape
    ground = dsm.copy()
    radius = 11
    padded = np.pad(ground, ((0, 0), (radius, radius)), mode="edge")
    for i in range(1, 2 * radius + 1):
        np.minimum(ground, padded[:, i:i + w], out=ground)
    padded = np.pad(ground, ((radius, radius), (0, 0)), mode="edge")
    for i in range(1, 2 * radius + 1):
        np.minimum(ground, padded[i:i + h, :], out=ground)

    ndsm = dsm - ground
    ndsm[ndsm < 0] = 0
    return ndsm, tfm


def fetch_ndsm(w, s, e, n):
    """Fetch normalised DSM and DTM for an OSGB bbox.

    Tries local tiles first, then EA WCS (covers all of England).
    Falls back to NRW (Wales) and JNCC (Scotland) if EA returns nothing.
    Returns (ndsm_array, dtm_array_or_None, transform) or (None, None, None).
    """
    arr, dtm, tfm = fetch_local(w, s, e, n)
    if arr is not None:
        return arr, dtm, tfm

    # Route by OSGB coordinates to the correct LiDAR source directly.
    # Avoids wasting ~8s per tile on failed EA requests for non-England areas.
    cx, cy = (w + e) / 2, (s + n) / 2

    # Scotland: north of the border (~northing 540000).
    if cy > 540000:
        return fetch_jncc_wcs(w, s, e, n)

    # Wales: roughly west of OSGB easting 340000.
    if cx < 340000:
        arr, dtm, tfm = fetch_nrw_cog(w, s, e, n)
        if arr is not None:
            return arr, dtm, tfm

    # England: EA WCS (also covers English areas near Welsh/Scottish borders).
    arr, dtm, tfm = fetch_ea_wcs(w, s, e, n)
    if arr is not None:
        return arr, dtm, tfm

    # Last resort: try NRW/JNCC for border areas that EA didn't cover.
    if cx < 400000 and cy < 540000:
        arr, dtm, tfm = fetch_nrw_cog(w, s, e, n)
        if arr is not None:
            return arr, dtm, tfm
    if cy > 500000:
        return fetch_jncc_wcs(w, s, e, n)

    return None, None, None


# ── GeoPackage helpers ────────────────────────────────────────────────────


def gpkg_header_len(blob: bytes) -> int:
    if len(blob) < 8:
        return 0
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_type, 0)


def register_gpkg_functions(conn: sqlite3.Connection):
    """Register dummy spatial functions so R-tree triggers don't fail on UPDATE."""
    conn.create_function("ST_IsEmpty", 1, lambda g: 0)
    conn.create_function("ST_MinX", 1, lambda g: 0.0)
    conn.create_function("ST_MaxX", 1, lambda g: 0.0)
    conn.create_function("ST_MinY", 1, lambda g: 0.0)
    conn.create_function("ST_MaxY", 1, lambda g: 0.0)


def ensure_lidar_columns(conn: sqlite3.Connection):
    cols = [row[1] for row in conn.execute("PRAGMA table_info(buildings)")]
    if "lidar_height" not in cols:
        conn.execute("ALTER TABLE buildings ADD COLUMN lidar_height REAL")
    if "ground_elev" not in cols:
        conn.execute("ALTER TABLE buildings ADD COLUMN ground_elev REAL")
    conn.commit()


def fallback_height(osm_height: str, levels: str) -> float:
    if osm_height:
        try:
            h = float(osm_height.replace("m", "").strip())
            if h > 0:
                return h
        except ValueError:
            pass
    if levels:
        try:
            n = int(levels)
            if n > 0:
                return n * 3.0
        except ValueError:
            pass
    return DEFAULT_HEIGHT_M


# ── Worker: fetch LiDAR + sample heights for one tile ────────────────────


def process_tile(
    te: int,
    tn: int,
    gpkg_path: str,
    existing_fids: set[int],
    pubs_osgb_in_tile: list[tuple[float, float]] | None = None,
):
    """Worker: load buildings for an OSGB tile, fetch LiDAR, sample heights.

    Runs in a thread pool. Each call opens its own read-only sqlite
    connection (sqlite handles concurrent readers fine). DB writes happen
    in the main thread to keep the writer single.

    If pubs_osgb_in_tile is provided, buildings further than 300m from any
    pub in the list are skipped (same optimisation as the bundle path).

    Returns dict: te, tn, n_buildings, height_updates, elev_updates,
    measured, fallback, status ("ok"/"no_lidar"/"empty").
    """
    # Per-worker read-only connection.
    conn = sqlite3.connect(f"file:{gpkg_path}?mode=ro", uri=True, timeout=60.0)
    conn.execute("PRAGMA busy_timeout=60000")
    try:
        tile_buildings = load_buildings_for_tile(conn, te, tn)
    finally:
        conn.close()

    tile_buildings = [b for b in tile_buildings if b[0] not in existing_fids]

    # 300m-from-pub filter — same as the bundle path.
    if pubs_osgb_in_tile:
        filtered = []
        for item in tile_buildings:
            _, poly, _, _ = item
            cx, cy = poly.centroid.x, poly.centroid.y
            for pe, pn in pubs_osgb_in_tile:
                if (cx - pe) ** 2 + (cy - pn) ** 2 <= SHADOW_RADIUS_SQ:
                    filtered.append(item)
                    break
        tile_buildings = filtered

    if not tile_buildings:
        return {
            "te": te, "tn": tn, "n_buildings": 0,
            "height_updates": [], "elev_updates": [],
            "measured": 0, "fallback": 0, "status": "empty",
        }

    w, s = te, tn
    e, n = te + TILE_SIZE_M, tn + TILE_SIZE_M
    ndsm, dtm, tfm = fetch_ndsm(w, s, e, n)

    height_updates: list[tuple[float, int]] = []
    elev_updates: list[tuple[float, int]] = []
    measured = 0
    fallback = 0

    if ndsm is not None:
        osgb_polys = [b[1] for b in tile_buildings]
        results = sample_heights(ndsm, dtm, tfm, osgb_polys)
        for (fid, _, osm_h, levels), (h, ground) in zip(tile_buildings, results):
            if h is not None and h >= MIN_HEIGHT_M:
                height_updates.append((round(h, 1), fid))
                measured += 1
            else:
                height_updates.append((round(fallback_height(osm_h, levels), 1), fid))
                fallback += 1
            if ground is not None:
                elev_updates.append((round(ground, 1), fid))
        status = "ok"
    else:
        for fid, _, osm_h, levels in tile_buildings:
            height_updates.append((round(fallback_height(osm_h, levels), 1), fid))
            fallback += 1
        status = "no_lidar"

    return {
        "te": te, "tn": tn, "n_buildings": len(tile_buildings),
        "height_updates": height_updates, "elev_updates": elev_updates,
        "measured": measured, "fallback": fallback, "status": status,
    }


# ── Bundle phase: 5km LZW GeoTIFFs from Defra survey catalogue ────────────


def _load_pubs(area: Area) -> list[dict]:
    """Load pubs from data/pubs_merged.json filtered to the requested area."""
    pubs_path = Path(__file__).resolve().parent.parent / "data" / "pubs_merged.json"
    if not pubs_path.exists():
        return []
    with open(pubs_path) as f:
        all_pubs = json.load(f)
    return [p for p in all_pubs if in_bbox(p["lat"], p["lng"], area.bbox)]


def _pub_search_cells(pubs: list[dict], cell_size_m: int = 10000) -> list[tuple[int, int]]:
    """Group pubs into OSGB cells of `cell_size_m` (default 10km).

    Each unique cell needs one search-API query. Pubs within 500m of a cell
    boundary also touch the neighbour cells, so we add those to be safe.
    """
    cells: set[tuple[int, int]] = set()
    buf = 500
    for p in pubs:
        e, n = to_osgb.transform(p["lng"], p["lat"])
        for dx in (-buf, 0, buf):
            for dy in (-buf, 0, buf):
                cells.add((
                    int((e + dx) // cell_size_m) * cell_size_m,
                    int((n + dy) // cell_size_m) * cell_size_m,
                ))
    return sorted(cells)


def _osgb_cell_to_geojson(e: int, n: int, size_m: int = 10000) -> dict:
    """Convert an OSGB cell (bottom-left corner + size) to a WGS84 polygon."""
    # 5 corners (closing the ring) sampled in OSGB then projected to WGS84.
    corners_osgb = [
        (e,           n),
        (e + size_m,  n),
        (e + size_m,  n + size_m),
        (e,           n + size_m),
        (e,           n),
    ]
    coords = [list(to_wgs.transform(x, y)) for x, y in corners_osgb]
    return {"type": "Polygon", "coordinates": [coords]}


def _search_cell(cell: tuple[int, int], cell_size_m: int = 10000) -> list[dict]:
    """POST the survey catalogue search API for one OSGB cell.

    Returns the raw `results` array (may be empty). Filters happen later.
    """
    polygon = _osgb_cell_to_geojson(cell[0], cell[1], cell_size_m)
    body = json.dumps(polygon).encode()
    req = urllib.request.Request(SURVEY_SEARCH_URL, data=body, headers=SURVEY_HEADERS, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
        return payload.get("results", []) or []
    except Exception:
        return []


def discover_bundles(area: Area) -> dict[str, dict]:
    """Discover all 5km bundle URIs needed for an area's pubs.

    Returns dict keyed by tile_id (e.g. "TG2005") with values:
        {"dtm": uri, "dsm": uri, "label": "TG20nw"}

    Tiles missing either DTM or DSM are dropped (we need both).
    """
    pubs = _load_pubs(area)
    cells = _pub_search_cells(pubs)
    print(f"  {len(pubs)} pubs → {len(cells)} 10km search cells")

    bundles: dict[str, dict] = {}
    seen_lock = threading.Lock()

    def collect(cell):
        return _search_cell(cell)

    completed = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WCS_WORKERS) as ex:
        for results in ex.map(collect, cells):
            completed += 1
            for r in results:
                prod = r.get("product", {}).get("id")
                year = r.get("year", {}).get("id")
                res = r.get("resolution", {}).get("id")
                if year != PRODUCT_YEAR or res != PRODUCT_RES:
                    continue
                tile = r.get("tile", {})
                tid = tile.get("id")
                if not tid:
                    continue
                uri = r.get("uri")
                if not uri:
                    continue
                with seen_lock:
                    entry = bundles.setdefault(tid, {"dtm": None, "dsm": None, "label": tile.get("label", tid)})
                    if prod == PRODUCT_DTM:
                        entry["dtm"] = uri
                    elif prod == PRODUCT_DSM_LAST:
                        entry["dsm"] = uri
                    elif prod == PRODUCT_DSM_FIRST and not entry["dsm"]:
                        # Fall back to first-return DSM only if last-return missing.
                        entry["dsm"] = uri
            if completed % 50 == 0 or completed == len(cells):
                rate = completed / (time.time() - t0)
                eta = (len(cells) - completed) / rate if rate else 0
                print(f"  search [{completed}/{len(cells)}]  {rate:.1f}/s  ETA {eta:.0f}s")

    # Drop tiles missing either DTM or DSM.
    complete = {tid: v for tid, v in bundles.items() if v["dtm"] and v["dsm"]}
    incomplete = len(bundles) - len(complete)
    if incomplete:
        print(f"  {incomplete} tiles dropped (missing DTM or DSM)")
    return complete


def _fetch_bundle_zip(uri: str, max_retries: int = 3) -> bytes | None:
    """Download a 5km LiDAR bundle. Returns raw zip bytes or None on failure.

    Validates that the response is a real PK-magic zip (the API occasionally
    returns an HTML error page or empty body) and retries on transient errors.
    """
    url = f"{uri}?subscription-key={SURVEY_TILE_KEY}"
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": SURVEY_HEADERS["User-Agent"]})
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = resp.read()
            # PK\x03\x04 = ZIP local-file header.
            if len(data) > 4 and data[:4] == b"PK\x03\x04":
                return data
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None  # tile genuinely doesn't exist
        except Exception:
            pass
        if attempt < max_retries - 1:
            time.sleep(1.0 + attempt)
    return None


# ── OS grid label decoding ────────────────────────────────────────────────


def _letter_to_pos(c: str) -> tuple[int, int]:
    """Returns (col, row) for an OS grid letter, with row 0 = bottom row.

    Letters arranged in a 5×5 block (no I), reading W→E top-to-bottom:
        A B C D E   (row 4 — top)
        F G H J K
        L M N O P
        Q R S T U
        V W X Y Z   (row 0 — bottom)
    """
    idx = ord(c.upper()) - ord("A")
    if idx > 7:  # skip I
        idx -= 1
    col = idx % 5
    row = 4 - idx // 5
    return col, row


def os_label_to_bbox(label: str) -> tuple[int, int, int, int] | None:
    """Decode an OS 5km grid label like 'TG10nw' to OSGB (e_min, n_min, e_max, n_max).

    Returns None for malformed labels.
    """
    if len(label) != 6:
        return None
    try:
        c1, r1 = _letter_to_pos(label[0])
        c2, r2 = _letter_to_pos(label[1])
        digit_e = int(label[2])
        digit_n = int(label[3])
    except (ValueError, IndexError):
        return None
    quarter = label[4:6].lower()
    if quarter not in ("nw", "ne", "sw", "se"):
        return None
    # 500km block origin (SV = 0,0). S is at letter pos (col=2, row=1).
    e500 = (c1 - 2) * 500000
    n500 = (r1 - 1) * 500000
    # 100km cell origin within 500km block. V (col=0, row=0) = (0, 0).
    e100 = c2 * 100000
    n100 = r2 * 100000
    e_min = e500 + e100 + digit_e * 10000 + (5000 if "e" in quarter else 0)
    n_min = n500 + n100 + digit_n * 10000 + (5000 if "n" in quarter else 0)
    return e_min, n_min, e_min + 5000, n_min + 5000


def _open_bundle_tif(zip_bytes: bytes):
    """Extract the .tif from a bundle zip and open it as an in-memory dataset.

    Returns (rasterio dataset, MemoryFile) — caller must close both.
    """
    with zipfile.ZipFile(BytesIO(zip_bytes)) as z:
        tif_name = next((n for n in z.namelist() if n.lower().endswith(".tif")), None)
        if not tif_name:
            return None, None
        tif_bytes = z.read(tif_name)
    mem = rasterio.MemoryFile(tif_bytes)
    return mem.open(), mem


SHADOW_RADIUS_M = 300       # buildings beyond this from any pub can't cast a useful shadow
SHADOW_RADIUS_SQ = SHADOW_RADIUS_M * SHADOW_RADIUS_M


def process_bundle(
    tile_id: str,
    bundle: dict,
    gpkg_path: str,
    existing_fids: set[int],
    all_pubs_osgb: list[tuple[float, float]],
):
    """Worker: download DTM+DSM bundles for one 5km tile, sample heights.

    Returns a result dict the main thread uses to write updates and stats.
    """
    t0 = time.time()
    dtm_zip = _fetch_bundle_zip(bundle["dtm"])
    dsm_zip = _fetch_bundle_zip(bundle["dsm"])
    download_s = time.time() - t0
    download_bytes = (len(dtm_zip) if dtm_zip else 0) + (len(dsm_zip) if dsm_zip else 0)

    if not dtm_zip or not dsm_zip:
        return {
            "tile_id": tile_id, "label": bundle["label"], "status": "fetch_failed",
            "n_buildings": 0, "measured": 0, "fallback": 0,
            "height_updates": [], "elev_updates": [],
            "download_s": download_s, "sample_s": 0.0, "download_bytes": download_bytes,
        }

    dtm_ds, dtm_mem = _open_bundle_tif(dtm_zip)
    dsm_ds, dsm_mem = _open_bundle_tif(dsm_zip)
    if dtm_ds is None or dsm_ds is None:
        if dtm_mem:
            dtm_mem.close()
        if dsm_mem:
            dsm_mem.close()
        return {
            "tile_id": tile_id, "label": bundle["label"], "status": "decode_failed",
            "n_buildings": 0, "measured": 0, "fallback": 0,
            "height_updates": [], "elev_updates": [],
            "download_s": download_s, "sample_s": 0.0, "download_bytes": download_bytes,
        }

    try:
        # Read full rasters (5km × 5km × 1m × float32 = ~100 MB each peak).
        dsm_arr = dsm_ds.read(1).astype(np.float32)
        dtm_arr = dtm_ds.read(1).astype(np.float32)
        dsm_arr = np.where(np.isnan(dsm_arr) | (dsm_arr < -100), 0, dsm_arr)
        dtm_arr = np.where(np.isnan(dtm_arr) | (dtm_arr < -100), 0, dtm_arr)
        if dsm_arr.shape != dtm_arr.shape:
            return {
                "tile_id": tile_id, "label": bundle["label"], "status": "shape_mismatch",
                "n_buildings": 0, "measured": 0, "fallback": 0,
                "height_updates": [], "elev_updates": [],
                "download_s": download_s, "sample_s": 0.0, "download_bytes": download_bytes,
            }
        ndsm = dsm_arr - dtm_arr
        ndsm[ndsm < 0] = 0
        transform = dsm_ds.transform
        bounds = dsm_ds.bounds  # OSGB
    finally:
        dtm_ds.close()
        dsm_ds.close()
        dtm_mem.close()
        dsm_mem.close()

    # Filter pubs to those whose buffered bbox overlaps this 5km bundle.
    # Only buildings near these pubs are worth measuring.
    pubs_local = [
        (e, n) for (e, n) in all_pubs_osgb
        if bounds.left - SHADOW_RADIUS_M <= e <= bounds.right + SHADOW_RADIUS_M
        and bounds.bottom - SHADOW_RADIUS_M <= n <= bounds.top + SHADOW_RADIUS_M
    ]
    if not pubs_local:
        # 5km square has no pubs nearby — nothing useful to do.
        return {
            "tile_id": tile_id, "label": bundle["label"], "status": "no_buildings",
            "n_buildings": 0, "measured": 0, "fallback": 0,
            "height_updates": [], "elev_updates": [],
            "download_s": download_s, "sample_s": 0.0, "download_bytes": download_bytes,
        }

    # Load buildings whose centroid sits inside this 5km bbox AND don't
    # already have a height. Per-worker read-only sqlite connection.
    conn = sqlite3.connect(f"file:{gpkg_path}?mode=ro", uri=True, timeout=60.0)
    conn.execute("PRAGMA busy_timeout=60000")
    try:
        # Convert OSGB bounds to WGS84 for the R-tree query.
        lng1, lat1 = to_wgs.transform(bounds.left, bounds.bottom)
        lng2, lat2 = to_wgs.transform(bounds.right, bounds.top)
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
            rows = conn.execute(
                "SELECT fid, geom, height, levels FROM buildings"
            ).fetchall()
    finally:
        conn.close()

    tile_buildings: list[tuple[int, Polygon, str, str]] = []
    for fid, blob, osm_h, levels in rows:
        if fid in existing_fids:
            continue
        try:
            hl = gpkg_header_len(blob)
            geom = wkb.loads(blob[hl:])
            if geom.is_empty or not geom.is_valid:
                continue
            osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
            poly = Polygon(osgb_coords)
            if not poly.is_valid or poly.is_empty:
                continue
            cx, cy = poly.centroid.x, poly.centroid.y
            # Centroid-in-bbox: each building belongs to exactly one bundle.
            if not (bounds.left <= cx < bounds.right and bounds.bottom <= cy < bounds.top):
                continue
            # 300m-from-any-pub filter — building must be close enough to
            # actually cast a shadow on a pub. ~50× speedup over baking
            # every building in every populated 5km square.
            near_pub = False
            for pe, pn in pubs_local:
                dx = cx - pe
                dy = cy - pn
                if dx * dx + dy * dy <= SHADOW_RADIUS_SQ:
                    near_pub = True
                    break
            if not near_pub:
                continue
            tile_buildings.append((fid, poly, osm_h, levels))
        except Exception:
            continue

    if not tile_buildings:
        return {
            "tile_id": tile_id, "label": bundle["label"], "status": "no_buildings",
            "n_buildings": 0, "measured": 0, "fallback": 0,
            "height_updates": [], "elev_updates": [],
            "download_s": download_s, "sample_s": 0.0, "download_bytes": download_bytes,
        }

    sample_t0 = time.time()
    osgb_polys = [b[1] for b in tile_buildings]
    results = sample_heights(ndsm, dtm_arr, transform, osgb_polys)
    sample_s = time.time() - sample_t0

    height_updates: list[tuple[float, int]] = []
    elev_updates: list[tuple[float, int]] = []
    measured = 0
    fallback = 0
    for (fid, _, osm_h, levels), (h, ground) in zip(tile_buildings, results):
        if h is not None and h >= MIN_HEIGHT_M:
            height_updates.append((round(h, 1), fid))
            measured += 1
        else:
            height_updates.append((round(fallback_height(osm_h, levels), 1), fid))
            fallback += 1
        if ground is not None:
            elev_updates.append((round(ground, 1), fid))

    return {
        "tile_id": tile_id, "label": bundle["label"], "status": "ok",
        "n_buildings": len(tile_buildings),
        "measured": measured, "fallback": fallback,
        "height_updates": height_updates, "elev_updates": elev_updates,
        "download_s": download_s, "sample_s": sample_s,
        "download_bytes": download_bytes,
    }


# ── Main: tile-first iteration ────────────────────────────────────────────


def find_pub_tiles(area: Area, tile_size=TILE_SIZE_M) -> set[tuple[int, int]]:
    """Find which OSGB tiles have pubs nearby. Returns set of (tile_e, tile_n)."""
    pubs_path = Path(__file__).resolve().parent.parent / "data" / "pubs_merged.json"
    if not pubs_path.exists():
        print(f"  WARNING: {pubs_path} not found, processing all buildings")
        return set()

    with open(pubs_path) as f:
        pubs = json.load(f)

    # Buffer: 300m around each pub (shadow reach distance).
    buf = 300
    tiles = set()
    for p in pubs:
        lat, lng = p["lat"], p["lng"]
        if not in_bbox(lat, lng, area.bbox):
            continue
        cx, cy = to_osgb.transform(lng, lat)
        # Add all tiles within buffer.
        for dx in range(-buf, buf + tile_size, tile_size):
            for dy in range(-buf, buf + tile_size, tile_size):
                key = (int((cx + dx) // tile_size) * tile_size,
                       int((cy + dy) // tile_size) * tile_size)
                tiles.add(key)

    print(f"  {len(pubs)} pubs → {len(tiles)} {tile_size}m tiles to process")
    return tiles


def load_buildings_for_tile(conn: sqlite3.Connection, tile_e: int, tile_n: int,
                            tile_size=TILE_SIZE_M) -> list:
    """Load buildings from GeoPackage that fall within a 1km OSGB tile.

    Uses the R-tree spatial index for fast bbox queries. Returns list of
    (fid, osgb_poly, osm_height, levels).
    """
    # Convert OSGB tile corners back to WGS84 for the GeoPackage query.
    from pyproj import Transformer
    to_wgs = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    lng1, lat1 = to_wgs.transform(tile_e, tile_n)
    lng2, lat2 = to_wgs.transform(tile_e + tile_size, tile_n + tile_size)
    min_lng, max_lng = min(lng1, lng2), max(lng1, lng2)
    min_lat, max_lat = min(lat1, lat2), max(lat1, lat2)

    # Use R-tree spatial index if available, otherwise bbox filter in Python.
    try:
        rows = conn.execute(
            "SELECT b.fid, b.geom, b.height, b.levels FROM buildings b "
            "JOIN rtree_buildings_geom r ON b.fid = r.id "
            "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
            (min_lng, max_lng, min_lat, max_lat),
        ).fetchall()
    except sqlite3.OperationalError:
        # No R-tree index — fall back to full scan with bbox filter.
        rows = conn.execute(
            "SELECT fid, geom, height, levels FROM buildings"
        ).fetchall()

    buildings = []
    for fid, blob, osm_height, levels in rows:
        try:
            hl = gpkg_header_len(blob)
            geom = wkb.loads(blob[hl:])
            if geom.is_empty or not geom.is_valid:
                continue
            osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
            osgb_poly = Polygon(osgb_coords)
            if osgb_poly.is_valid and not osgb_poly.is_empty:
                buildings.append((fid, osgb_poly, osm_height, levels))
        except Exception:
            continue
    return buildings


# ── Progress monitoring ───────────────────────────────────────────────────

PROGRESS_PATH = DATA_DIR / "heights_progress.json"


def _write_progress(state: dict):
    """Atomically write the live progress dict so external `cat`/`jq` can read."""
    try:
        tmp = PROGRESS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2, default=str))
        tmp.replace(PROGRESS_PATH)
    except Exception:
        pass


def _eta_str(done: int, total: int, started: float) -> str:
    elapsed = time.time() - started
    if done == 0:
        return "ETA --"
    rate = done / elapsed
    remaining = (total - done) / rate if rate else 0
    if remaining < 90:
        return f"ETA {remaining:.0f}s"
    if remaining < 5400:
        return f"ETA {remaining/60:.0f}min"
    return f"ETA {remaining/3600:.1f}h"


# ── Phase runners ─────────────────────────────────────────────────────────


def run_bundle_phase(conn: sqlite3.Connection, area: Area, gpkg_path_str: str) -> dict:
    """Phase 1: fetch 5km LZW bundles from the Defra survey catalogue.

    Returns a stats dict for the run summary.
    """
    print("=" * 60)
    print("Phase 1: bundle path (Defra survey catalogue, England)")
    print("=" * 60)

    bundles = discover_bundles(area)
    print(f"  {len(bundles)} candidate 5km bundles from search")

    # Pre-project all pubs to OSGB once. Workers receive this list by
    # reference (no pickling) and use it to skip buildings that are too far
    # from any pub to ever cast a useful shadow.
    pubs = _load_pubs(area)
    all_pubs_osgb = [to_osgb.transform(p["lng"], p["lat"]) for p in pubs]

    # Drop bundles whose 5km bbox doesn't contain any pub (within shadow
    # radius). The catalogue search is generous — a 10km cell with one pub
    # in the corner returns ~16 surrounding 5km tiles, most of which are
    # nowhere near a pub. Skipping them here avoids ~70% of downloads.
    nearby_bundles: dict[str, dict] = {}
    for tid, b in bundles.items():
        bbox = os_label_to_bbox(b["label"])
        if bbox is None:
            # Can't decode label — keep it, the worker will figure it out.
            nearby_bundles[tid] = b
            continue
        emin, nmin, emax, nmax = bbox
        for pe, pn in all_pubs_osgb:
            if (emin - SHADOW_RADIUS_M <= pe <= emax + SHADOW_RADIUS_M
                and nmin - SHADOW_RADIUS_M <= pn <= nmax + SHADOW_RADIUS_M):
                nearby_bundles[tid] = b
                break

    skipped_far = len(bundles) - len(nearby_bundles)
    print(f"  {skipped_far} skipped (no pubs within {SHADOW_RADIUS_M}m of bbox)")
    bundles = nearby_bundles

    # Second pre-filter: drop bundles whose buildings are all already heighted.
    # Avoids re-downloading for resumed runs. Cheap R-tree count per bundle.
    existing_fids = {
        r[0] for r in conn.execute(
            "SELECT fid FROM buildings WHERE lidar_height IS NOT NULL"
        ).fetchall()
    }
    pending_bundles: dict[str, dict] = {}
    for tid, b in bundles.items():
        bbox = os_label_to_bbox(b["label"])
        if bbox is None:
            pending_bundles[tid] = b
            continue
        emin, nmin, emax, nmax = bbox
        # Convert OSGB bbox to WGS84 for R-tree query.
        lng1, lat1 = to_wgs.transform(emin, nmin)
        lng2, lat2 = to_wgs.transform(emax, nmax)
        try:
            rows = conn.execute(
                "SELECT id FROM rtree_buildings_geom "
                "WHERE maxx >= ? AND minx <= ? AND maxy >= ? AND miny <= ?",
                (min(lng1, lng2), max(lng1, lng2), min(lat1, lat2), max(lat1, lat2)),
            ).fetchall()
        except sqlite3.OperationalError:
            pending_bundles[tid] = b
            continue
        if any(r[0] not in existing_fids for r in rows):
            pending_bundles[tid] = b

    skipped_done = len(bundles) - len(pending_bundles)
    print(f"  {skipped_done} skipped (all candidate buildings already heighted)")
    print(f"  {len(pending_bundles)} bundles to download + process")
    print()
    bundles = pending_bundles

    if not bundles:
        return {"completed": 0, "measured": 0, "fallback": 0, "failed": 0, "bytes": 0}

    print(f"  {len(existing_fids)} buildings already have heights (will be skipped)")
    print()

    stats = {
        "phase": "bundle",
        "started_at": time.time(),
        "total_bundles": len(bundles),
        "completed": 0,
        "failed": 0,
        "ok": 0,
        "no_buildings": 0,
        "measured": 0,
        "fallback": 0,
        "bytes": 0,
    }
    items = sorted(bundles.items())
    n_total = len(items)
    t0 = stats["started_at"]

    with ThreadPoolExecutor(max_workers=WCS_WORKERS) as ex:
        futures = {
            ex.submit(process_bundle, tid, b, gpkg_path_str, existing_fids, all_pubs_osgb): tid
            for tid, b in items
        }
        for future in as_completed(futures):
            stats["completed"] += 1
            done = stats["completed"]
            try:
                r = future.result()
            except Exception as exc:
                tid = futures[future]
                stats["failed"] += 1
                print(f"  [{done}/{n_total}] {tid:<8} EXC: {exc}")
                continue

            if r["status"] in ("fetch_failed", "decode_failed", "shape_mismatch"):
                stats["failed"] += 1
                print(f"  [{done}/{n_total}] {r['label']:<8} ✗ {r['status']}")
                continue
            if r["status"] == "no_buildings":
                stats["no_buildings"] += 1
                stats["bytes"] += r["download_bytes"]
                elapsed = time.time() - t0
                mb_s = stats["bytes"] / 1e6 / elapsed if elapsed else 0
                print(
                    f"  [{done}/{n_total}] {r['label']:<8} (empty) "
                    f"dl {r['download_s']:>4.0f}s {mb_s:>4.1f}MB/s "
                    f"{_eta_str(done, n_total, t0)}"
                )
                if done % 20 == 0:
                    _write_progress(stats)
                continue

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

            stats["ok"] += 1
            stats["measured"] += r["measured"]
            stats["fallback"] += r["fallback"]
            stats["bytes"] += r["download_bytes"]
            elapsed = time.time() - t0
            mb_s = stats["bytes"] / 1e6 / elapsed if elapsed else 0
            rate = done / elapsed if elapsed else 0
            print(
                f"  [{done}/{n_total}] {r['label']:<8} "
                f"{r['n_buildings']:>5}b {r['measured']:>4}m/{r['fallback']:>3}f "
                f"dl {r['download_s']:>4.0f}s samp {r['sample_s']:>4.1f}s "
                f"{mb_s:>4.1f}MB/s {rate:>4.2f}/s {_eta_str(done, n_total, t0)}"
            )
            if done % 5 == 0:
                _write_progress(stats)

    conn.commit()
    _write_progress(stats)
    print()
    print(
        f"Phase 1 done: {stats['ok']} ok, {stats['no_buildings']} empty, "
        f"{stats['failed']} failed, {stats['measured']} measured, "
        f"{stats['fallback']} fallback, {stats['bytes']/1e9:.1f} GB downloaded"
    )
    print()
    return stats


def run_wcs_phase(conn: sqlite3.Connection, area: Area, gpkg_path_str: str) -> dict:
    """Phase 2: legacy WCS path for buildings the bundle phase couldn't reach.

    Used for Wales (NRW COG), Scotland (JNCC WCS), and any English gaps where
    the survey catalogue had no 2022 1m composite. Iterates 1km OSGB tiles.
    """
    print("=" * 60)
    print("Phase 2: WCS path (Wales/Scotland/gaps)")
    print("=" * 60)

    # Pre-project pubs to OSGB for the 300m filter (same as bundle phase).
    pubs = _load_pubs(area)
    all_pubs_osgb = [to_osgb.transform(p["lng"], p["lat"]) for p in pubs]

    print("Finding tiles near pubs that still need heights...", flush=True)
    pub_tiles = find_pub_tiles(area)
    if not pub_tiles:
        print("  No pub tiles to process.")
        return {"completed": 0, "measured": 0, "fallback": 0, "failed": 0}

    index = _get_tile_index()
    if index:
        print(f"  {len(index)} local LiDAR tiles indexed")

    existing_fids = {
        r[0] for r in conn.execute(
            "SELECT fid FROM buildings WHERE lidar_height IS NOT NULL"
        ).fetchall()
    }
    print(f"  {len(existing_fids)} buildings already have heights (will be skipped)")

    # Pre-compute per-tile pub lists for the 300m filter.
    # Each tile gets only pubs whose OSGB centroid is within (tile + 300m).
    tile_pubs: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for te, tn in pub_tiles:
        local = [
            (pe, pn) for (pe, pn) in all_pubs_osgb
            if te - SHADOW_RADIUS_M <= pe <= te + TILE_SIZE_M + SHADOW_RADIUS_M
            and tn - SHADOW_RADIUS_M <= pn <= tn + TILE_SIZE_M + SHADOW_RADIUS_M
        ]
        tile_pubs[(te, tn)] = local
    # Drop tiles with zero nearby pubs (can happen due to tile grid rounding).
    pub_tiles = {k for k in pub_tiles if tile_pubs.get(k)}
    print(f"  {len(pub_tiles)} tiles have pubs within {SHADOW_RADIUS_M}m")
    print()

    stats = {
        "phase": "wcs",
        "started_at": time.time(),
        "total_tiles": len(pub_tiles),
        "completed": 0,
        "failed": 0,
        "skipped": 0,
        "measured": 0,
        "fallback": 0,
    }
    sorted_tiles = sorted(pub_tiles)
    n_total = len(sorted_tiles)
    t0 = stats["started_at"]

    print(f"Processing {n_total} tiles ({TILE_SIZE_M}m) with {WCS_WORKERS} workers...")
    print()

    with ThreadPoolExecutor(max_workers=WCS_WORKERS) as ex:
        futures = {
            ex.submit(process_tile, te, tn, gpkg_path_str, existing_fids, tile_pubs[(te, tn)]): (te, tn)
            for te, tn in sorted_tiles
        }
        for future in as_completed(futures):
            stats["completed"] += 1
            done = stats["completed"]
            try:
                r = future.result()
            except Exception as exc:
                te, tn = futures[future]
                stats["failed"] += 1
                print(f"  [{done}/{n_total}] ({te},{tn}) EXC: {exc}")
                continue

            if r["status"] == "empty":
                stats["skipped"] += 1
                continue

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

            stats["measured"] += r["measured"]
            stats["fallback"] += r["fallback"]

            elapsed = time.time() - t0
            rate = done / elapsed if elapsed else 0
            tag = "no LiDAR" if r["status"] == "no_lidar" else f"{r['measured']}m/{r['fallback']}f"
            print(
                f"  [{done}/{n_total}] ({r['te']},{r['tn']}) "
                f"{r['n_buildings']}b {tag}  "
                f"{rate:.2f}/s {_eta_str(done, n_total, t0)}"
            )
            if done % 5 == 0:
                _write_progress(stats)

    conn.commit()
    _write_progress(stats)
    print()
    print(
        f"Phase 2 done: {stats['measured']} measured, {stats['fallback']} fallback, "
        f"{stats['skipped']} tiles skipped, {stats['failed']} failed"
    )
    print()
    return stats


def main():
    area = parse_area()
    print(f"Measuring building heights for {area.name}")
    print(f"  GeoPackage: {GPKG_PATH}")
    print(f"  LiDAR dir:  {LIDAR_DIR}")
    print(f"  Progress:   {PROGRESS_PATH}")
    print()

    if not GPKG_PATH.exists():
        print("ERROR: buildings.gpkg not found. Run build_gpkg.py first.")
        return

    conn = sqlite3.connect(str(GPKG_PATH), timeout=60.0)
    # WAL lets reader workers proceed concurrently with the main-thread writer
    # without locking the file. busy_timeout is a belt-and-braces fallback.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")
    conn.execute("PRAGMA synchronous=NORMAL")
    register_gpkg_functions(conn)
    ensure_lidar_columns(conn)
    gpkg_path_str = str(GPKG_PATH)

    overall_t0 = time.time()
    bundle_stats = run_bundle_phase(conn, area, gpkg_path_str)
    wcs_stats = run_wcs_phase(conn, area, gpkg_path_str)

    elapsed = time.time() - overall_t0
    print("=" * 60)
    print(f"All phases done in {elapsed/60:.1f} minutes")
    print("=" * 60)

    row = conn.execute(
        "SELECT count(*), avg(lidar_height), min(lidar_height), max(lidar_height) "
        "FROM buildings WHERE lidar_height IS NOT NULL"
    ).fetchone()
    if row[0]:
        print(f"  Heights total: {row[0]}, avg {row[1]:.1f}m, min {row[2]:.1f}m, max {row[3]:.1f}m")

    final = {
        "phase": "done",
        "elapsed_s": round(elapsed, 1),
        "bundle": bundle_stats,
        "wcs": wcs_stats,
    }
    _write_progress(final)
    conn.close()


if __name__ == "__main__":
    main()
