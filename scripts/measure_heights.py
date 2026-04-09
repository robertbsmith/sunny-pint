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
    dtm: np.ndarray | None,
    transform,
    osgb_polys: list[Polygon],
) -> list[tuple[float | None, float | None]]:
    """Sample 90th-percentile height and ground elevation per building.

    ndsm = DSM - DTM (height above ground).
    dtm = bare ground elevation (above sea level), or None.
    Returns list of (height, ground_elev) tuples.
    """
    if ndsm is None or ndsm.size == 0:
        return [(None, None)] * len(osgb_polys)

    # Rasterize all buildings with unique IDs.
    shapes = [(poly, i + 1) for i, poly in enumerate(osgb_polys)]
    labels = rasterize(
        shapes,
        out_shape=ndsm.shape,
        transform=transform,
        fill=0,
        dtype=np.int32,
    )

    results: list[tuple[float | None, float | None]] = []
    for i in range(len(osgb_polys)):
        mask = labels == (i + 1)
        if not mask.any():
            results.append((None, None))
            continue

        # Ground elevation from DTM (median within footprint).
        ground = None
        if dtm is not None:
            dtm_vals = dtm[mask]
            valid_dtm = dtm_vals[dtm_vals > -100]
            if len(valid_dtm) > 0:
                ground = float(np.median(valid_dtm))

        vals = ndsm[mask]
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
WCS_DELAY_S = 0.3  # minimum seconds between WCS requests
WCS_MAX_RETRIES = 3


def _fetch_tiff_bytes(url: str, timeout: int = 120) -> bytes | None:
    """Fetch a GeoTIFF from a URL with rate limiting and retry.

    Returns bytes or None on failure.
    """
    global _last_wcs_time

    for attempt in range(WCS_MAX_RETRIES):
        # Rate limit: wait between requests.
        elapsed = time.time() - _last_wcs_time
        if elapsed < WCS_DELAY_S:
            time.sleep(WCS_DELAY_S - elapsed)

        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "SunnyPint/0.1 (+https://sunny-pint.co.uk)")
            _last_wcs_time = time.time()
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

    Tries local tiles first, then APIs by country.
    Returns (ndsm_array, dtm_array_or_None, transform) or (None, None, None).
    """
    arr, dtm, tfm = fetch_local(w, s, e, n)
    if arr is not None:
        return arr, dtm, tfm

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


# ── Main: tile-first iteration ────────────────────────────────────────────


def find_pub_tiles(area: Area, tile_size=TILE_SIZE_M) -> set[tuple[int, int]]:
    """Find which 1km OSGB tiles have pubs nearby. Returns set of (tile_e, tile_n)."""
    import json
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

    print(f"  {len(pubs)} pubs → {len(tiles)} 1km tiles to process")
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
    ensure_lidar_columns(conn)

    # Find which 1km tiles have pubs nearby — only process those.
    print("Finding tiles near pubs...", flush=True)
    pub_tiles = find_pub_tiles(area)
    if not pub_tiles:
        print("  No pub tiles found (will process all buildings).")

    # Index local tiles once.
    index = _get_tile_index()
    if index:
        print(f"  {len(index)} local LiDAR tiles indexed")
    print()

    # Skip tiles where all buildings already have heights.
    existing_fids = {r[0] for r in conn.execute(
        "SELECT fid FROM buildings WHERE lidar_height IS NOT NULL"
    ).fetchall()}
    print(f"  {len(existing_fids)} buildings already have heights")
    print()

    total_measured = 0
    total_fallback = 0
    total_skipped = 0
    t0 = time.time()
    sorted_tiles = sorted(pub_tiles)

    print(f"Processing {len(sorted_tiles)} tiles near pubs...")
    print()

    for i, (te, tn) in enumerate(sorted_tiles, 1):
        # Load buildings for this tile (lazy, per-tile — no bulk load).
        tile_buildings = load_buildings_for_tile(conn, te, tn)

        # Skip buildings that already have heights.
        tile_buildings = [b for b in tile_buildings if b[0] not in existing_fids]
        if not tile_buildings:
            total_skipped += 1
            continue

        w, s = te, tn
        e, n = te + TILE_SIZE_M, tn + TILE_SIZE_M

        print(
            f"  [{i}/{len(sorted_tiles)}] OSGB ({w},{s})–({e},{n}) "
            f"({len(tile_buildings)} buildings) ... ",
            end="", flush=True,
        )

        # Fetch normalised DSM + DTM for this tile.
        ndsm, dtm, tfm = fetch_ndsm(w, s, e, n)

        height_updates = []
        elev_updates = []
        if ndsm is not None:
            osgb_polys = [b[1] for b in tile_buildings]
            results = sample_heights(ndsm, dtm, tfm, osgb_polys)

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

            print(f"{measured} measured, {fallback} fallback")
            total_measured += measured
            total_fallback += fallback
        else:
            for fid, _, osm_h, levels in tile_buildings:
                height_updates.append((round(fallback_height(osm_h, levels), 1), fid))
            print(f"no LiDAR, {len(tile_buildings)} fallback")
            total_fallback += len(tile_buildings)

        conn.executemany(
            "UPDATE buildings SET lidar_height = ? WHERE fid = ?", height_updates
        )
        if elev_updates:
            conn.executemany(
                "UPDATE buildings SET ground_elev = ? WHERE fid = ?", elev_updates
            )
        conn.commit()

    elapsed = time.time() - t0
    print()
    print(f"Done in {elapsed:.0f}s! {total_measured} measured, {total_fallback} fallback, {total_skipped} tiles skipped")

    row = conn.execute(
        "SELECT count(*), avg(lidar_height), min(lidar_height), max(lidar_height) "
        "FROM buildings WHERE lidar_height IS NOT NULL"
    ).fetchone()
    print(f"  Total: {row[0]}, Avg: {row[1]:.1f}m, Min: {row[2]:.1f}m, Max: {row[3]:.1f}m")
    conn.close()


if __name__ == "__main__":
    main()
