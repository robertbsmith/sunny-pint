"""OS Terrain 50 loader — coarse (50m) DTM for long-range horizon ray-casting.

Provides elevation lookups for any OSGB coordinate by loading the relevant
10km × 10km ASCII grid tile. Tiles are cached in memory after first load.

Data source: Ordnance Survey Terrain 50 (free open data, OGL3).
Download: https://api.os.uk/downloads/v1/products/Terrain50/downloads

The extracted .asc files live in data/terrain50/ (2,858 tiles, ~570MB).
If missing, download_terrain50() fetches and extracts them automatically.
"""

import io
import os
import shutil
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
TERRAIN50_DIR = DATA_DIR / "terrain50"
TERRAIN50_ZIP = DATA_DIR / "terr50_gb.zip"

DOWNLOAD_URL = (
    "https://api.os.uk/downloads/v1/products/Terrain50/downloads"
    "?area=GB&format=ASCII+Grid+and+GML+%28Grid%29&redirect"
)

# OSGB 100km grid square letters (bottom-left origin).
# Row 0 (S*): V W X Y Z,  Row 1: Q R S T U, etc.
_GRID_ROWS = ["VWXYZ", "QRSTU", "LMNOP", "FGHJK", "ABCDE"]


def _osgb_to_tile_name(easting: float, northing: float) -> str:
    """Convert OSGB coordinate to OS Terrain 50 tile name (e.g. 'sd92')."""
    # Major 500km grid square
    maj_e = int(easting) // 500000
    maj_n = int(northing) // 500000
    # First letter: S=0, N=1, T=0(east), H=1(east) etc.
    # Simplified for GB: maj_e=0,maj_n=0 → S; maj_e=0,maj_n=1 → N;
    # maj_e=1,maj_n=0 → T; maj_e=1,maj_n=1 → H (but H is maj_n=2 in full grid)
    first_letters = {(0, 0): "S", (1, 0): "T", (0, 1): "N", (1, 1): "O",
                     (0, 2): "H"}
    first = first_letters.get((maj_e, maj_n), "S")

    # Minor 100km grid square within the 500km block
    min_e = (int(easting) % 500000) // 100000
    min_n = (int(northing) % 500000) // 100000
    second = _GRID_ROWS[min_n][min_e]

    # 10km sub-tile indices
    sub_e = (int(easting) % 100000) // 10000
    sub_n = (int(northing) % 100000) // 10000

    return f"{first}{second}{sub_e}{sub_n}".lower()


class Terrain50:
    """Lazy-loading OS Terrain 50 elevation lookup."""

    def __init__(self, terrain_dir: Path | None = None):
        self._dir = terrain_dir or TERRAIN50_DIR
        self._cache: dict[str, tuple[np.ndarray, float, float, float, int, int]] = {}
        # (dtm_array, xll, yll, cellsize, nrows, ncols)

    def _load_tile(self, tile_name: str) -> tuple[np.ndarray, float, float, float, int, int] | None:
        """Load and cache a single .asc tile."""
        if tile_name in self._cache:
            return self._cache[tile_name]

        path = self._dir / f"{tile_name}.asc"
        if not path.exists():
            self._cache[tile_name] = None  # type: ignore
            return None

        with open(path) as f:
            ncols = int(f.readline().split()[1])
            nrows = int(f.readline().split()[1])
            xll = float(f.readline().split()[1])
            yll = float(f.readline().split()[1])
            cellsize = float(f.readline().split()[1])
            # Optional nodata line
            line = f.readline()
            if line.strip().startswith("NODATA") or line.strip().startswith("nodata"):
                data_start = f.tell()
            else:
                # That line was actually the first data row, re-parse
                data_start = None
                first_row = [float(v) for v in line.split()]

            dtm = np.zeros((nrows, ncols), dtype=np.float32)
            if data_start is not None:
                for i in range(nrows):
                    dtm[i] = [float(v) for v in f.readline().split()]
            else:
                dtm[0] = first_row
                for i in range(1, nrows):
                    dtm[i] = [float(v) for v in f.readline().split()]

        result = (dtm, xll, yll, cellsize, nrows, ncols)
        self._cache[tile_name] = result
        return result

    def elevation(self, easting: float, northing: float) -> float | None:
        """Get elevation at an OSGB coordinate. Returns None if no data."""
        tile_name = _osgb_to_tile_name(easting, northing)
        tile = self._load_tile(tile_name)
        if tile is None:
            return None

        dtm, xll, yll, cellsize, nrows, ncols = tile
        col = (easting - xll) / cellsize
        row = nrows - 1 - (northing - yll) / cellsize

        c, r = int(round(col)), int(round(row))
        if r < 0 or r >= nrows or c < 0 or c >= ncols:
            return None

        val = dtm[r, c]
        if val < -100:  # nodata
            return None
        return float(val)

    def elevation_array(self, eastings: np.ndarray, northings: np.ndarray) -> np.ndarray:
        """Get elevations for arrays of OSGB coordinates.

        Returns array of elevations (NaN where no data).
        Handles cross-tile queries by loading multiple tiles.
        """
        result = np.full(len(eastings), np.nan, dtype=np.float32)

        # Group by tile to minimize tile loads
        tile_names = np.array([_osgb_to_tile_name(e, n) for e, n in zip(eastings, northings)])
        unique_tiles = np.unique(tile_names)

        for tn in unique_tiles:
            mask = tile_names == tn
            tile = self._load_tile(tn)
            if tile is None:
                continue

            dtm, xll, yll, cellsize, nrows, ncols = tile
            cols = np.round((eastings[mask] - xll) / cellsize).astype(int)
            rows = np.round(nrows - 1 - (northings[mask] - yll) / cellsize).astype(int)

            valid = (rows >= 0) & (rows < nrows) & (cols >= 0) & (cols < ncols)
            rows_safe = np.clip(rows, 0, nrows - 1)
            cols_safe = np.clip(cols, 0, ncols - 1)

            vals = dtm[rows_safe, cols_safe]
            vals = np.where(valid & (vals > -100), vals, np.nan)

            indices = np.where(mask)[0]
            result[indices] = vals

        return result

    @property
    def available(self) -> bool:
        """Check if terrain50 data directory exists and has tiles."""
        return self._dir.is_dir() and any(self._dir.glob("*.asc"))


def download_terrain50(target_dir: Path | None = None) -> None:
    """Download and extract OS Terrain 50 if not already present."""
    target = target_dir or TERRAIN50_DIR
    if target.is_dir() and any(target.glob("*.asc")):
        return  # already extracted

    zip_path = target.parent / "terr50_gb.zip"
    target.mkdir(parents=True, exist_ok=True)

    # Download if zip doesn't exist
    if not zip_path.exists():
        print("Downloading OS Terrain 50 (155 MB)...")
        req = urllib.request.Request(DOWNLOAD_URL)
        req.add_header("User-Agent", "SunnyPint-Pipeline/1.0")
        with urllib.request.urlopen(req, timeout=300) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            with open(zip_path, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        print(f"\r  {downloaded * 100 // total}%", end="", flush=True)
            print()

    # Extract .asc tiles from nested zips
    print("Extracting terrain tiles...", flush=True)
    outer = zipfile.ZipFile(zip_path)
    inner_zips = [n for n in outer.namelist() if n.endswith(".zip")]
    extracted = 0
    for name in inner_zips:
        inner_data = outer.read(name)
        inner_zip = zipfile.ZipFile(io.BytesIO(inner_data))
        for f in inner_zip.namelist():
            if f.upper().endswith(".ASC"):
                tile_name = os.path.basename(f).lower()
                with inner_zip.open(f) as src, open(target / tile_name, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                extracted += 1
        inner_zip.close()
        if extracted % 500 == 0:
            print(f"  {extracted} tiles...", flush=True)
    outer.close()
    print(f"  {extracted} tiles extracted to {target}/")
