"""Auto-download pipeline data sources if not already present.

Downloads:
- OSM .pbf extracts from Geofabrik (england, scotland, wales)
- OS Terrain 50 from OS Open Data API (for long-range horizon rays)

All downloads are idempotent — skip if the file already exists.
"""

import os
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"

GEOFABRIK_BASE = "https://download.geofabrik.de/europe/united-kingdom"
OSM_EXTRACTS = {
    "england-latest.osm.pbf": f"{GEOFABRIK_BASE}/england-latest.osm.pbf",
    "scotland-latest.osm.pbf": f"{GEOFABRIK_BASE}/scotland-latest.osm.pbf",
    "wales-latest.osm.pbf": f"{GEOFABRIK_BASE}/wales-latest.osm.pbf",
}


def _download_with_progress(url: str, dest: Path, label: str) -> None:
    """Download a URL to dest with progress reporting."""
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "SunnyPint-Pipeline/1.0")

    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded * 100 // total
                        mb = downloaded / 1e6
                        total_mb = total / 1e6
                        print(f"\r  {label}: {mb:.0f}/{total_mb:.0f} MB ({pct}%)",
                              end="", flush=True)
            print()
        tmp.rename(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def download_osm_extracts(area: str = "uk") -> list[Path]:
    """Download OSM .pbf extracts if not present. Returns list of paths."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Determine which extracts to download based on area.
    if area.lower() in ("uk", "gb", "all"):
        needed = OSM_EXTRACTS
    elif area.lower() == "england":
        needed = {"england-latest.osm.pbf": OSM_EXTRACTS["england-latest.osm.pbf"]}
    elif area.lower() == "scotland":
        needed = {"scotland-latest.osm.pbf": OSM_EXTRACTS["scotland-latest.osm.pbf"]}
    elif area.lower() == "wales":
        needed = {"wales-latest.osm.pbf": OSM_EXTRACTS["wales-latest.osm.pbf"]}
    else:
        # For smaller areas (norwich, bristol etc), just need england
        needed = {"england-latest.osm.pbf": OSM_EXTRACTS["england-latest.osm.pbf"]}

    paths = []
    for filename, url in needed.items():
        dest = DATA_DIR / filename
        if dest.exists():
            paths.append(dest)
            continue
        print(f"Downloading {filename} from Geofabrik...")
        _download_with_progress(url, dest, filename)
        paths.append(dest)

    return paths


def ensure_data_sources(area: str = "uk") -> None:
    """Ensure all required data sources are downloaded."""
    from pipeline.utils.terrain50 import download_terrain50

    download_osm_extracts(area)
    download_terrain50()
