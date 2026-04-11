"""Stage 5: SCORE — compute Sunny Ratings via TypeScript worker pool.

Shells out to `pnpm tsx pipeline/ts/precompute_sun.ts`. The TypeScript code
uses the same shadow.ts as the browser — single source of truth.

After scoring, regenerates pubs-index.json and detail chunks so they
include sun data.
"""

import hashlib
import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PUBS_JSON = ROOT / "public" / "data" / "pubs.json"
PUBS_INDEX_OUT = ROOT / "public" / "data" / "pubs-index.json"
DETAIL_DIR = ROOT / "public" / "data" / "detail"

# Must match the field sets in package.py.
INDEX_FIELDS = {
    "id", "name", "lat", "lng", "slug", "town", "country",
    "opening_hours", "outdoor_area_m2", "outdoor_seating", "beer_garden",
}
DETAIL_FIELDS = {
    "outdoor", "elev", "horizon", "horizon_dist", "clat", "clng",
    "real_ale", "food", "wheelchair", "dog", "wifi",
    "phone", "website", "brand", "brewery",
    "local_authority", "addr_postcode", "addr_street", "addr_housenumber",
}


def _outdoor_hash(pub: dict) -> str | None:
    outdoor = pub.get("outdoor")
    if not outdoor:
        return None
    return hashlib.md5(json.dumps(outdoor, sort_keys=True).encode()).hexdigest()[:12]


def _regenerate_splits(pubs: list[dict]) -> None:
    """Regenerate pubs-index.json and detail chunks with sun data."""
    index_pubs = []
    detail_chunks: dict[str, dict] = {}

    for pub in pubs:
        idx = {}
        for k in INDEX_FIELDS:
            if k in pub and pub[k]:
                idx[k] = pub[k]
        idx["lat"] = pub["lat"]
        idx["lng"] = pub["lng"]
        if pub.get("sun"):
            idx["sun"] = {"score": pub["sun"]["score"], "label": pub["sun"]["label"]}
        index_pubs.append(idx)

        slug = pub.get("slug")
        if slug:
            cell_lat = math.floor(pub["lat"] * 10) / 10
            cell_lng = math.floor(pub["lng"] * 10) / 10
            cell_key = f"{cell_lat}_{cell_lng}"
            detail = {}
            for k in DETAIL_FIELDS:
                if k in pub and pub[k] is not None:
                    detail[k] = pub[k]
            if pub.get("sun"):
                detail["sun"] = pub["sun"]
            if detail:
                detail_chunks.setdefault(cell_key, {})[slug] = detail

    PUBS_INDEX_OUT.write_text(json.dumps(index_pubs))
    idx_size = PUBS_INDEX_OUT.stat().st_size / 1e6
    with_sun = sum(1 for p in index_pubs if "sun" in p)
    print(f"  pubs-index.json: {idx_size:.1f} MB ({with_sun} with sun)")

    DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    for old in DETAIL_DIR.glob("*.json"):
        old.unlink()
    for cell_key, slugs in detail_chunks.items():
        (DETAIL_DIR / f"{cell_key}.json").write_text(json.dumps(slugs))
    total_detail = sum(f.stat().st_size for f in DETAIL_DIR.glob("*.json"))
    print(f"  detail/: {len(detail_chunks)} chunks, {total_detail / 1e6:.1f} MB")


def run(area) -> dict:
    """Run sun scoring. Returns stats dict."""
    if not PUBS_JSON.exists():
        raise FileNotFoundError(f"{PUBS_JSON} not found")

    # Pre-check: how many pubs already have sun scores with unchanged outdoor?
    pubs = json.loads(PUBS_JSON.read_text())
    already_scored = 0
    needs_scoring = 0
    for pub in pubs:
        if pub.get("sun") and pub.get("_outdoor_hash") == _outdoor_hash(pub):
            already_scored += 1
        elif pub.get("outdoor"):
            needs_scoring += 1

    print(f"  {already_scored} pubs already scored (outdoor unchanged)")
    print(f"  {needs_scoring} pubs need scoring")

    if needs_scoring == 0 and already_scored > 0:
        print("  All pubs already scored — skipping")
        return {"scored": already_scored, "skipped_unchanged": already_scored, "recomputed": 0}

    # Stamp outdoor hashes before scoring so the worker can skip unchanged pubs.
    for pub in pubs:
        oh = _outdoor_hash(pub)
        if oh:
            pub["_outdoor_hash"] = oh
    PUBS_JSON.write_text(json.dumps(pubs))

    # Run precompute_sun.ts.
    print("  Running precompute_sun.ts...", flush=True)
    result = subprocess.run(
        ["pnpm", "tsx", str(ROOT / "pipeline" / "ts" / "precompute_sun.ts")],
        cwd=str(ROOT),
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"precompute_sun.ts failed: {result.returncode}")

    # Strip internal _outdoor_hash from the public file.
    pubs = json.loads(PUBS_JSON.read_text())
    for pub in pubs:
        pub.pop("_outdoor_hash", None)
    PUBS_JSON.write_text(json.dumps(pubs))

    scored = sum(1 for p in pubs if p.get("sun"))
    print(f"  {scored}/{len(pubs)} pubs now have sun scores")

    # Regenerate index + detail chunks with sun data.
    print("  Regenerating splits...")
    _regenerate_splits(pubs)

    return {"scored": scored, "needs_scoring": needs_scoring}
