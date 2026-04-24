"""Auto-download pipeline data sources if not already present.

Downloads:
- OSM .pbf extracts from Geofabrik (england, scotland, wales)
- OS Terrain 50 from OS Open Data API (for long-range horizon rays)

All downloads are idempotent — skip if the file already exists.
"""

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


OPNAMES_URL = (
    "https://api.os.uk/downloads/v1/products/OpenNames/downloads"
    "?area=GB&format=CSV&redirect"
)


def download_os_places() -> None:
    """Download and extract OS Open Names populated places if not present."""
    places_path = DATA_DIR / "os_places.json"
    if places_path.exists():
        return

    zip_path = DATA_DIR / "opnames_gb.zip"
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not zip_path.exists():
        print("Downloading OS Open Names (100 MB)...")
        _download_with_progress(OPNAMES_URL, zip_path, "opnames_gb.zip")

    # Extract populated places to compact JSON.
    import csv
    import io
    import json
    import zipfile

    print("Extracting populated places...", flush=True)
    PLACE_TYPES = {"City", "Town", "Village", "Hamlet", "Suburban Area", "Other Settlement"}

    zf = zipfile.ZipFile(zip_path)
    csvs = [n for n in zf.namelist() if n.endswith(".csv")]
    places = []
    for name in csvs:
        with zf.open(name) as f:
            text = io.TextIOWrapper(f, encoding="utf-8-sig")
            reader = csv.reader(text)
            for row in reader:
                if len(row) < 30:
                    continue
                if row[7] not in PLACE_TYPES:
                    continue
                try:
                    places.append({
                        "name": row[2],
                        "type": row[7],
                        "e": int(row[8]),
                        "n": int(row[9]),
                        "district": row[21] or None,
                        "county": row[24] or None,
                        "country": row[29] or None,
                    })
                except (ValueError, IndexError):
                    continue
    zf.close()

    with open(places_path, "w") as f:
        json.dump(places, f)
    print(f"  {len(places)} populated places → {places_path.name}")


def ensure_data_sources(area: str = "uk") -> None:
    """Ensure all required data sources are downloaded."""
    from pipeline.utils.terrain50 import download_terrain50

    download_osm_extracts(area)
    download_terrain50()
    download_os_places()
