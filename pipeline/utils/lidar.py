"""LiDAR WCS/COG fetchers for Wales and Scotland.

Provides fallback elevation data for areas not covered by Defra bundles
(which are England-only). Used by the ENRICH stage for Phase 2 processing.

Sources:
- EA WCS: Environment Agency (England) — 1m DSM/DTM
- JNCC WCS: Joint Nature Conservation Committee (Scotland) — multi-phase LiDAR
- NRW COG: Natural Resources Wales — Cloud-Optimized GeoTIFF DSM/DTM
"""

import threading
import time
import urllib.request
from io import BytesIO

import numpy as np
import rasterio
from rasterio.windows import from_bounds

# ── LiDAR source URLs ────────────────────────────────────────────────────

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

# Rate limiting for WCS endpoints.
WCS_DELAY_S = 0.5
WCS_MAX_RETRIES = 3
_wcs_lock = threading.Lock()
_last_wcs_time = 0.0


# ── Helpers ──────────────────────────────────────────────────────────────


def _fetch_tiff_bytes(url: str, timeout: int = 120) -> bytes | None:
    """Fetch a GeoTIFF from a URL with rate limiting and retry."""
    global _last_wcs_time

    for attempt in range(WCS_MAX_RETRIES):
        with _wcs_lock:
            elapsed = time.time() - _last_wcs_time
            if elapsed < WCS_DELAY_S:
                time.sleep(WCS_DELAY_S - elapsed)
            _last_wcs_time = time.time()

        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "SunnyPint/1.0 (+https://sunny-pint.co.uk)")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if data[:2] in (b"II", b"MM") and len(data) > 1000:
                return data
            return None
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 503, 504) and attempt < WCS_MAX_RETRIES - 1:
                wait = (attempt + 1) * 5
                print(f"  (HTTP {exc.code}, retry in {wait}s)", end="", flush=True)
                time.sleep(wait)
                continue
            return None
        except Exception:
            return None

    return None


def _read_tiff_bytes(data: bytes):
    """Read a GeoTIFF from bytes. Returns (array, transform)."""
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


# ── Public API ───────────────────────────────────────────────────────────


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


def fetch_ndsm(w, s, e, n):
    """Fetch normalised DSM and DTM for an OSGB bbox.

    Routes by OSGB coordinates to the correct LiDAR source:
    - Scotland (northing > 540k) → JNCC WCS
    - Wales (easting < 340k) → NRW COG
    - England → EA WCS

    Returns (ndsm_array, dtm_array_or_None, transform) or (None, None, None).
    """
    cx, cy = (w + e) / 2, (s + n) / 2

    # Scotland
    if cy > 540000:
        return fetch_jncc_wcs(w, s, e, n)

    # Wales
    if cx < 340000:
        arr, dtm, tfm = fetch_nrw_cog(w, s, e, n)
        if arr is not None:
            return arr, dtm, tfm

    # England (EA WCS)
    arr, dtm, tfm = fetch_ea_wcs(w, s, e, n)
    if arr is not None:
        return arr, dtm, tfm

    # Border area fallbacks
    if cx < 400000 and cy < 540000:
        arr, dtm, tfm = fetch_nrw_cog(w, s, e, n)
        if arr is not None:
            return arr, dtm, tfm
    if cy > 500000:
        return fetch_jncc_wcs(w, s, e, n)

    return None, None, None
