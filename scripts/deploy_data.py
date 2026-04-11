"""Upload pipeline output to Cloudflare R2 via S3 API.

Uses boto3 with ThreadPoolExecutor for parallel uploads (~80-90 files/s).

Required env vars (loaded from .env automatically):
    R2_ACCOUNT_ID        Cloudflare account ID
    R2_ACCESS_KEY_ID     R2 S3 API access key
    R2_SECRET_ACCESS_KEY R2 S3 API secret key

Usage:
    uv run python scripts/deploy_data.py [--dry-run]
"""

import argparse
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Load .env from project root if present.
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())

import boto3

BUCKET = "sunny-pint-data"
PUBLIC_DATA = Path(__file__).resolve().parent.parent / "public" / "data"
MAX_WORKERS = 16

# Files and directories to upload, with their R2 key prefixes.
UPLOADS = [
    # (local_path, r2_key, content_type)
    (PUBLIC_DATA / "pubs-index.json", "data/pubs-index.json", "application/json"),
    (PUBLIC_DATA / "buildings.pmtiles", "data/buildings.pmtiles", "application/octet-stream"),
]

# Directories to upload (all files within).
UPLOAD_DIRS = [
    # (local_dir, r2_prefix, content_type)
    (PUBLIC_DATA / "detail", "data/detail", "application/json"),
    (PUBLIC_DATA / "og", "data/og", "image/jpeg"),
]


def get_s3_client():
    account_id = os.environ.get("R2_ACCOUNT_ID")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")

    if not all([account_id, access_key, secret_key]):
        print("ERROR: Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY")
        sys.exit(1)

    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )


def main():
    parser = argparse.ArgumentParser(description="Upload pipeline data to R2")
    parser.add_argument("--dry-run", action="store_true", help="List files without uploading")
    args = parser.parse_args()

    # Build file list.
    files: list[tuple[Path, str, str]] = []

    for local_path, r2_key, content_type in UPLOADS:
        if local_path.exists():
            files.append((local_path, r2_key, content_type))
        else:
            print(f"  skip {r2_key} (not found)")

    for local_dir, r2_prefix, content_type in UPLOAD_DIRS:
        if not local_dir.is_dir():
            print(f"  skip {r2_prefix}/ (not found)")
            continue
        for f in sorted(local_dir.iterdir()):
            if f.is_file():
                files.append((f, f"{r2_prefix}/{f.name}", content_type))

    total_size = sum(f[0].stat().st_size for f in files)
    print(f"{len(files)} files to upload ({total_size / 1e6:.1f} MB)")

    if args.dry_run:
        for local, key, ct in files:
            size = local.stat().st_size
            print(f"  {key} ({size / 1e3:.1f} KB)")
        return

    # Each thread gets its own S3 client for connection reuse within the thread.
    thread_local = threading.local()

    def get_thread_client():
        if not hasattr(thread_local, "s3"):
            thread_local.s3 = get_s3_client()
        return thread_local.s3

    uploaded = 0
    failed = 0
    lock = threading.Lock()
    t0 = time.time()

    def upload_one(item):
        nonlocal uploaded, failed
        local_path, r2_key, content_type = item
        try:
            s3 = get_thread_client()
            s3.put_object(
                Bucket=BUCKET,
                Key=r2_key,
                Body=local_path.read_bytes(),
                ContentType=content_type,
            )
            with lock:
                uploaded += 1
                if uploaded % 200 == 0:
                    elapsed = time.time() - t0
                    rate = uploaded / elapsed if elapsed else 0
                    remaining = len(files) - uploaded - failed
                    eta = remaining / rate if rate else 0
                    print(f"  [{uploaded}/{len(files)}] {rate:.0f}/s ETA {eta:.0f}s", flush=True)
            return True
        except Exception as e:
            with lock:
                failed += 1
            print(f"  FAILED {r2_key}: {e}")
            return False

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = [pool.submit(upload_one, item) for item in files]
        for f in as_completed(futures):
            f.result()  # propagate exceptions

    elapsed = time.time() - t0
    rate = uploaded / elapsed if elapsed else 0
    print(f"\nDone: {uploaded} uploaded, {failed} failed in {elapsed:.0f}s ({rate:.0f}/s)")


if __name__ == "__main__":
    main()
