"""Sample building heights from LiDAR DSM/DTM and bake into GeoPackage.

Uses DSM (surface) minus DTM (bare ground) to get building heights directly,
avoiding expensive ground-level estimation. Iterates tile-first so each
LiDAR area is read once for all buildings within it.

Supports local tiles (Norwich) and on-demand WCS/COG requests (England,
Scotland, Wales).

Usage:
    uv run python scripts/measure_heights.py --area norwich
"""

import math
import sqlite3
import time
import urllib.request
from io import BytesIO
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.windows import from_bounds
from pyproj import Transformer
from shapely.geometry import Polygon
from shapely import wkb

from areas import parse_area, in_bbox, Area

# ── Paths ──────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GPKG_PATH = DATA_DIR / "buildings.gpkg"
LIDAR_DIR = DATA_DIR / "lidar"

# ── Coordinate transforms ─────────────────────────────────────────────────

to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

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

# ── Constants ─────────────────────────────────────────────────────────────

MIN_HEIGHT_M = 3.0   # buildings shorter than this are filtered
DEFAULT_HEIGHT_M = 8.0
TILE_SIZE_M = 1000    # iterate by 1km tiles (matches EA LiDAR grid)


# ── Height sampling ───────────────────────────────────────────────────────


def sample_heights(
    ndsm: np.ndarray,
    transform,
    osgb_polys: list[Polygon],
) -> list[float | None]:
    """Sample 90th-percentile height per building from a normalised DSM.

    ndsm = DSM - DTM (height above ground, not above sea level).
    Rasterizes ALL buildings at once, then extracts per-label heights.
    """
    if ndsm is None or ndsm.size == 0:
        return [None] * len(osgb_polys)

    # Rasterize all buildings with unique IDs.
    shapes = [(poly, i + 1) for i, poly in enumerate(osgb_polys)]
    labels = rasterize(
        shapes,
        out_shape=ndsm.shape,
        transform=transform,
        fill=0,
        dtype=np.int32,
    )

    heights: list[float | None] = []
    for i in range(len(osgb_polys)):
        mask = labels == (i + 1)
        if not mask.any():
            heights.append(None)
            continue

        vals = ndsm[mask]
        above = vals[vals > MIN_HEIGHT_M]
        if len(above) > 0:
            heights.append(float(np.percentile(above, 90)))
        else:
            # Try lower threshold for short buildings.
            above = vals[vals > 2.0]
            if len(above) > 0:
                h = float(np.percentile(above, 90))
                heights.append(h if h >= MIN_HEIGHT_M else None)
            else:
                heights.append(None)

    return heights


# ── LiDAR fetching ────────────────────────────────────────────────────────


def _fetch_tiff_bytes(url: str, timeout: int = 120) -> bytes | None:
    """Fetch a GeoTIFF from a URL. Returns bytes or None on failure."""
    try:
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "SunPub/0.1")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        if data[:2] in (b"II", b"MM") and len(data) > 1000:
            return data
        return None
    except Exception as exc:
        print(f"WCS error: {exc}")
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
    """Fetch DSM and DTM from local tiles. Returns (ndsm, transform) or (None, None).

    Local tiles are named dsm_1m_EASTING_NORTHING.tif. We also look for
    dtm_1m_EASTING_NORTHING.tif in the same directory.
    """
    index = _get_tile_index()
    if not index:
        return None, None

    matching_dsm = [
        p for p, b in index
        if b.right > w and b.left < e and b.top > s and b.bottom < n
    ]
    if not matching_dsm:
        return None, None

    dsm, tfm = _read_mosaic(matching_dsm, w, s, e, n)
    if dsm is None:
        return None, None

    # Try to find matching DTM tiles.
    matching_dtm = [
        Path(str(p).replace("dsm_", "dtm_")) for p in matching_dsm
    ]
    matching_dtm = [p for p in matching_dtm if p.exists()]

    if matching_dtm:
        dtm, _ = _read_mosaic(matching_dtm, w, s, e, n)
        if dtm is not None:
            ndsm = dsm - dtm
            ndsm[ndsm < 0] = 0
            return ndsm, tfm

    # No local DTM — try EA WCS for DTM only.
    dtm_data = _fetch_tiff_bytes(_ea_wcs_url(EA_DTM_WCS, EA_DTM_COV, w, s, e, n))
    if dtm_data is not None:
        dtm, dtm_tfm = _read_tiff_bytes(dtm_data)
        # Resample DTM to match DSM grid if shapes differ.
        if dtm.shape == dsm.shape:
            ndsm = dsm - dtm
            ndsm[ndsm < 0] = 0
            return ndsm, tfm

    # Fallback: estimate ground from DSM (slow path).
    return _dsm_with_ground_estimate(dsm, tfm)


def fetch_ea_wcs(w, s, e, n):
    """Fetch DSM and DTM from EA WCS (England). Returns (ndsm, transform)."""
    dsm_data = _fetch_tiff_bytes(_ea_wcs_url(EA_DSM_WCS, EA_DSM_COV, w, s, e, n))
    if dsm_data is None:
        return None, None
    dsm, tfm = _read_tiff_bytes(dsm_data)

    dtm_data = _fetch_tiff_bytes(_ea_wcs_url(EA_DTM_WCS, EA_DTM_COV, w, s, e, n))
    if dtm_data is not None:
        dtm, _ = _read_tiff_bytes(dtm_data)
        if dtm.shape == dsm.shape:
            ndsm = dsm - dtm
            ndsm[ndsm < 0] = 0
            return ndsm, tfm

    return _dsm_with_ground_estimate(dsm, tfm)


def fetch_jncc_wcs(w, s, e, n):
    """Fetch from JNCC WCS (Scotland). Tries each phase."""
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
                return ndsm, tfm

        return _dsm_with_ground_estimate(dsm, tfm)

    return None, None


def fetch_nrw_cog(w, s, e, n):
    """Fetch from NRW COG (Wales). HTTP range requests."""
    try:
        with rasterio.open(NRW_DSM_COG) as src:
            win = from_bounds(w, s, e, n, src.transform)
            dsm = src.read(1, window=win).astype(np.float32)
            dsm = np.where(np.isnan(dsm) | (dsm < -100), 0, dsm)
            if dsm.max() < 1.0:
                return None, None
            tfm = rasterio.windows.transform(win, src.transform)
    except Exception:
        return None, None

    try:
        with rasterio.open(NRW_DTM_COG) as src:
            win = from_bounds(w, s, e, n, src.transform)
            dtm = src.read(1, window=win).astype(np.float32)
            dtm = np.where(np.isnan(dtm) | (dtm < -100), 0, dtm)
            if dtm.shape == dsm.shape:
                ndsm = dsm - dtm
                ndsm[ndsm < 0] = 0
                return ndsm, tfm
    except Exception:
        pass

    return _dsm_with_ground_estimate(dsm, tfm)


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
    """Fetch normalised DSM (height above ground) for an OSGB bbox.

    Tries local tiles first, then APIs by country.
    Returns (ndsm_array, transform) or (None, None).
    """
    # Local tiles first.
    arr, tfm = fetch_local(w, s, e, n)
    if arr is not None:
        return arr, tfm

    # Determine country from centre.
    cx, cy = (w + e) / 2, (s + n) / 2
    if cy > 530000:
        return fetch_jncc_wcs(w, s, e, n)
    elif cx < 340000 and cy < 380000:
        return fetch_nrw_cog(w, s, e, n)
    else:
        return fetch_ea_wcs(w, s, e, n)


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


def ensure_lidar_height_column(conn: sqlite3.Connection):
    cols = [row[1] for row in conn.execute("PRAGMA table_info(buildings)")]
    if "lidar_height" not in cols:
        conn.execute("ALTER TABLE buildings ADD COLUMN lidar_height REAL")
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


# ── Main: tile-first iteration ────────────────────────────────────────────


def load_buildings(conn: sqlite3.Connection, area: Area):
    """Load buildings from GeoPackage, convert to OSGB, filter by area."""
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
            centroid = geom.centroid
            clng, clat = centroid.x, centroid.y
            if not in_bbox(clat, clng, area.bbox):
                continue
            osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
            osgb_poly = Polygon(osgb_coords)
            if osgb_poly.is_valid and not osgb_poly.is_empty:
                buildings.append((fid, osgb_poly, osm_height, levels))
        except Exception:
            continue
    return buildings


def assign_to_tiles(buildings, tile_size=TILE_SIZE_M):
    """Assign each building to its 1km OSGB tile. Returns {(tile_e, tile_n): [buildings]}."""
    tiles = {}
    for b in buildings:
        fid, poly, osm_h, levels = b
        cx, cy = poly.centroid.x, poly.centroid.y
        key = (int(cx // tile_size) * tile_size, int(cy // tile_size) * tile_size)
        tiles.setdefault(key, []).append(b)
    return tiles


def main():
    area = parse_area()
    print(f"Measuring building heights for {area.name}")
    print(f"  GeoPackage: {GPKG_PATH}")
    print(f"  LiDAR dir:  {LIDAR_DIR}")
    print()

    if not GPKG_PATH.exists():
        print("ERROR: buildings.gpkg not found. Run build_gpkg.py first.")
        return

    conn = sqlite3.connect(str(GPKG_PATH))
    register_gpkg_functions(conn)
    ensure_lidar_height_column(conn)

    print("Loading buildings...", flush=True)
    buildings = load_buildings(conn, area)
    print(f"  {len(buildings)} buildings in {area.name}")

    # Skip buildings that already have heights.
    existing = {r[0] for r in conn.execute(
        "SELECT fid FROM buildings WHERE lidar_height IS NOT NULL"
    ).fetchall()}
    todo = [b for b in buildings if b[0] not in existing]
    print(f"  {len(existing)} already done, {len(todo)} to process")

    if not todo:
        print("Nothing to do.")
        conn.close()
        return

    # Index local tiles once.
    index = _get_tile_index()
    if index:
        print(f"  {len(index)} local LiDAR tiles indexed")
    print()

    # Assign buildings to 1km tiles.
    tiles = assign_to_tiles(todo)
    print(f"Processing {len(tiles)} tiles ({len(todo)} buildings)...")
    print()

    total_measured = 0
    total_fallback = 0
    t0 = time.time()

    for i, ((te, tn), tile_buildings) in enumerate(sorted(tiles.items()), 1):
        # Tile bbox in OSGB.
        w, s = te, tn
        e, n = te + TILE_SIZE_M, tn + TILE_SIZE_M

        print(
            f"  [{i}/{len(tiles)}] OSGB ({w},{s})–({e},{n}) "
            f"({len(tile_buildings)} buildings) ... ",
            end="", flush=True,
        )

        # Fetch normalised DSM for this tile.
        ndsm, tfm = fetch_ndsm(w, s, e, n)

        updates = []
        if ndsm is not None:
            osgb_polys = [b[1] for b in tile_buildings]
            heights = sample_heights(ndsm, tfm, osgb_polys)

            measured = 0
            fallback = 0
            for (fid, _, osm_h, levels), h in zip(tile_buildings, heights):
                if h is not None and h >= MIN_HEIGHT_M:
                    updates.append((round(h, 1), fid))
                    measured += 1
                else:
                    updates.append((round(fallback_height(osm_h, levels), 1), fid))
                    fallback += 1

            print(f"{measured} measured, {fallback} fallback")
            total_measured += measured
            total_fallback += fallback
        else:
            for fid, _, osm_h, levels in tile_buildings:
                updates.append((round(fallback_height(osm_h, levels), 1), fid))
            print(f"no LiDAR, {len(tile_buildings)} fallback")
            total_fallback += len(tile_buildings)

        conn.executemany(
            "UPDATE buildings SET lidar_height = ? WHERE fid = ?", updates
        )
        conn.commit()

    elapsed = time.time() - t0
    print()
    print(f"Done in {elapsed:.0f}s! {total_measured} measured, {total_fallback} fallback")

    row = conn.execute(
        "SELECT count(*), avg(lidar_height), min(lidar_height), max(lidar_height) "
        "FROM buildings WHERE lidar_height IS NOT NULL"
    ).fetchone()
    print(f"  Total: {row[0]}, Avg: {row[1]:.1f}m, Min: {row[2]:.1f}m, Max: {row[3]:.1f}m")
    conn.close()


if __name__ == "__main__":
    main()
