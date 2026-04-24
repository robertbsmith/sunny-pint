"""Download all INSPIRE Index Polygon files from HM Land Registry.

Downloads one GML ZIP per local authority, extracts, and merges into a single
GML file for use by match_plots.py.

Displays progress with counts, sizes, and ETA.

Usage:
    uv run python scripts/download_inspire.py
"""

import http.cookiejar
import io
import re
import time
import urllib.request
import zipfile
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "inspire"

BASE_URL = "https://use-land-property-data.service.gov.uk"
LIST_URL = f"{BASE_URL}/datasets/inspire/download"

USER_AGENT = "Mozilla/5.0 (compatible; SunnyPint/0.1; +https://sunny-pint.co.uk)"

# Cookie jar for session handling.
_cookie_jar = http.cookiejar.CookieJar()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Capture 302 redirects instead of following them."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _RedirectCaptured(newurl)


class _RedirectCaptured(Exception):
    def __init__(self, url: str):
        self.url = url


_opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(_cookie_jar),
    urllib.request.HTTPRedirectHandler(),
)

_opener_no_redirect = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(_cookie_jar),
    _NoRedirect(),
)


def _fetch(url: str, timeout: int = 60) -> bytes:
    """Fetch a URL with cookie handling."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with _opener.open(req, timeout=timeout) as resp:
        return resp.read()


def _fetch_with_redirect(url: str, timeout: int = 60) -> bytes:
    """Fetch a URL that redirects to a signed S3 URL.

    The Land Registry returns a 302 to a signed S3 URL. We capture the redirect
    and fetch the S3 URL directly (without cookies, which confuse S3).
    """
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        _opener_no_redirect.open(req, timeout=timeout)
        # Shouldn't get here — expect a redirect.
        raise Exception("Expected redirect, got 200")
    except _RedirectCaptured as e:
        # Fetch the S3 URL directly without cookies.
        s3_req = urllib.request.Request(e.url)
        with urllib.request.urlopen(s3_req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 302:
            s3_url = e.headers.get("Location")
            if s3_url:
                s3_req = urllib.request.Request(s3_url)
                with urllib.request.urlopen(s3_req, timeout=timeout) as resp:
                    return resp.read()
        raise


def get_authority_urls() -> list[str]:
    """Scrape the download page for all local authority ZIP URLs."""
    html = _fetch(LIST_URL, timeout=30).decode()
    paths = re.findall(r'href="(/datasets/inspire/download/[^"]+\.zip)"', html)
    return [f"{BASE_URL}{p}" for p in sorted(set(paths))]


def validate_gml(path: Path) -> bool:
    """Quick integrity check for an INSPIRE GML file.

    Catches the failure mode we've actually seen in the wild: a botched
    download leaves a file that ends with the right close tag but has a
    region of NULL bytes (and sometimes garbage continuation) in the
    middle. NULL bytes are illegal in XML 1.0, so any occurrence means
    corruption. Streams through in 16 MB chunks — fast enough that
    re-validating the whole INSPIRE corpus (~10 GB) takes seconds.
    """
    if not path.exists() or path.stat().st_size < 1024:
        return False
    with open(path, "rb") as f:
        f.seek(-256, 2)
        if b"</wfs:FeatureCollection>" not in f.read():
            return False
        f.seek(0)
        while True:
            chunk = f.read(16 * 1024 * 1024)
            if not chunk:
                break
            if b"\x00" in chunk:
                return False
    return True


def download_and_extract(url: str, output_dir: Path) -> tuple[Path | None, int]:
    """Download a ZIP and extract the GML file. Returns (path, bytes) or (None, 0).

    Cached files are revalidated before being trusted. Corrupt cached
    files are deleted and re-fetched. Newly downloaded files are
    extracted to a `.tmp` path, validated, then atomically renamed so
    a half-extracted file never lands at the canonical path.
    """
    name = url.split("/")[-1].replace(".zip", "")
    gml_path = output_dir / f"{name}.gml"

    if gml_path.exists():
        if validate_gml(gml_path):
            return gml_path, gml_path.stat().st_size
        print(f" CACHED FILE CORRUPT, re-downloading: {gml_path.name}", flush=True)
        gml_path.unlink()

    try:
        data = _fetch_with_redirect(url)

        tmp_path = gml_path.with_suffix(".gml.tmp")
        if tmp_path.exists():
            tmp_path.unlink()

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            gml_files = [f for f in zf.namelist() if f.endswith(".gml")]
            if not gml_files:
                return None, 0
            with zf.open(gml_files[0]) as src, open(tmp_path, "wb") as dst:
                while True:
                    buf = src.read(1024 * 1024)
                    if not buf:
                        break
                    dst.write(buf)

        if not validate_gml(tmp_path):
            print(f" DOWNLOADED FILE INVALID: {gml_path.name}")
            tmp_path.unlink(missing_ok=True)
            return None, 0

        tmp_path.rename(gml_path)
        return gml_path, gml_path.stat().st_size

    except Exception as e:
        print(f" ERROR: {e}")
        return None, 0



def format_time(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m {seconds % 60:.0f}s"
    return f"{seconds / 3600:.0f}h {(seconds % 3600) / 60:.0f}m"


def format_size(bytes: int) -> str:
    if bytes < 1e6:
        return f"{bytes / 1024:.0f} KB"
    if bytes < 1e9:
        return f"{bytes / 1e6:.1f} MB"
    return f"{bytes / 1e9:.2f} GB"


def validate_existing(data_dir: Path) -> list[Path]:
    """Scan all cached GML files and return the list of corrupt ones."""
    files = sorted(data_dir.glob("*.gml"))
    print(f"Validating {len(files)} cached GML files...")
    bad: list[Path] = []
    for i, p in enumerate(files, 1):
        ok = validate_gml(p)
        if not ok:
            bad.append(p)
            print(f"  [{i}/{len(files)}] CORRUPT {p.name} ({format_size(p.stat().st_size)})")
        elif i % 50 == 0:
            print(f"  [{i}/{len(files)}] ok so far", flush=True)
    print(f"\n  {len(bad)} corrupt / {len(files)} total")
    return bad


def main():
    import sys

    if "--validate" in sys.argv:
        validate_existing(DATA_DIR)
        return

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("Fetching local authority list...", flush=True)
    urls = get_authority_urls()
    print(f"  {len(urls)} local authorities found\n")

    # Download all ZIPs.
    print("Downloading INSPIRE data...", flush=True)
    gml_files = []
    total_bytes = 0
    failed = 0
    start_time = time.time()

    for i, url in enumerate(urls, 1):
        name = url.split("/")[-1].replace(".zip", "").replace("_", " ")

        gml_path, size = download_and_extract(url, DATA_DIR)

        if gml_path:
            gml_files.append(gml_path)
            total_bytes += size
        else:
            failed += 1

        # Progress line.
        elapsed = time.time() - start_time
        rate = i / elapsed if elapsed > 0 else 0
        remaining = (len(urls) - i) / rate if rate > 0 else 0

        print(
            f"  [{i}/{len(urls)}] {name[:40]:40s} "
            f"{format_size(size):>8s}  "
            f"total: {format_size(total_bytes):>8s}  "
            f"ETA: {format_time(remaining)}",
            flush=True,
        )

        # Be polite.
        if i % 10 == 0:
            time.sleep(0.3)

    elapsed = time.time() - start_time
    print(f"\n  Done in {format_time(elapsed)}")
    print(f"  {len(gml_files)} downloaded, {failed} failed")
    print(f"  Total: {format_size(total_bytes)}\n")

    if not gml_files:
        print("ERROR: no GML files downloaded")
        return

    print(f"\n  {len(gml_files)} GML files ready in {DATA_DIR}")


if __name__ == "__main__":
    main()
