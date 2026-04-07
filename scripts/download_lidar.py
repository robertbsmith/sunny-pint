"""Download EA LiDAR Composite DSM 1m tiles for Norwich via WCS."""

import urllib.request
from pathlib import Path

WCS_BASE = (
    "https://environment.data.gov.uk/spatialdata/"
    "lidar-composite-digital-surface-model-last-return-dsm-1m/wcs"
)
COVERAGE_ID = (
    "9ba4d5ac-d596-445a-9056-dae3ddec0178__Lidar_Composite_Elevation_LZ_DSM_1m"
)

# Norwich urban area in OSGB (easting, northing).
# Covers roughly 10x10 km centred on the city.
EASTING_MIN = 618000
EASTING_MAX = 628000
NORTHING_MIN = 303000
NORTHING_MAX = 313000

TILE_SIZE = 1000  # 1 km tiles

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "lidar"


def tile_url(e_min, n_min, e_max, n_max):
    return (
        f"{WCS_BASE}?service=WCS&version=2.0.1&request=GetCoverage"
        f"&CoverageId={COVERAGE_ID}"
        f"&format=image/tiff"
        f"&subset=E({e_min},{e_max})"
        f"&subset=N({n_min},{n_max})"
        f"&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/27700"
    )


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    tiles = []
    for e in range(EASTING_MIN, EASTING_MAX, TILE_SIZE):
        for n in range(NORTHING_MIN, NORTHING_MAX, TILE_SIZE):
            tiles.append((e, n, e + TILE_SIZE, n + TILE_SIZE))

    total = len(tiles)
    print(f"Downloading {total} tiles ({TILE_SIZE}m) for Norwich area...")
    print(f"  Easting  {EASTING_MIN} – {EASTING_MAX}")
    print(f"  Northing {NORTHING_MIN} – {NORTHING_MAX}")
    print(f"  Output: {OUT_DIR}\n")

    downloaded = 0
    skipped = 0

    for i, (e0, n0, e1, n1) in enumerate(tiles, 1):
        fname = f"dsm_1m_{e0}_{n0}.tif"
        out_path = OUT_DIR / fname

        if out_path.exists() and out_path.stat().st_size > 1000:
            skipped += 1
            continue

        url = tile_url(e0, n0, e1, n1)
        print(f"  [{i}/{total}] {fname} ... ", end="", flush=True)
        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "SunPub/0.1")
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            # Check it's a valid TIFF (starts with TIFF magic bytes).
            if data[:2] in (b"II", b"MM") and len(data) > 1000:
                out_path.write_bytes(data)
                downloaded += 1
                print(f"{len(data) / 1e6:.1f} MB")
            else:
                # Likely an XML error or empty coverage.
                print("no data (outside coverage?)")
        except Exception as exc:
            print(f"error: {exc}")

    if skipped:
        print(f"\nSkipped {skipped} already-downloaded tiles")
    print(f"Downloaded {downloaded} new tiles")
    print(f"Total tiles in {OUT_DIR}: {len(list(OUT_DIR.glob('*.tif')))}")


if __name__ == "__main__":
    main()
