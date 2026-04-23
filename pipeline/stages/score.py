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

# Import rather than re-declare — these two lists drifting is a silent
# footgun: SCORE regenerates pubs-index.json and detail chunks, and any
# mismatch with PACKAGE's field sets strips fields PACKAGE added (lost
# the BarOrPub address/phone/website fields once this way).
from pipeline.stages.package import INDEX_FIELDS, DETAIL_FIELDS  # noqa: E402


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
            idx["sun"] = {
                "score": pub["sun"]["score"],
                "label": pub["sun"]["label"],
                "best_window": pub["sun"].get("best_window"),
                "evening_sun": pub["sun"].get("evening_sun"),
                "all_day_sun": pub["sun"].get("all_day_sun"),
            }
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

    # Re-read pubs.json after the scorer ran. _outdoor_hash is deliberately
    # kept in this file — it's an internal field but pubs.json is the
    # intermediate full file (pubs-index.json is the slim public one, and
    # it already strips _outdoor_hash via INDEX_FIELDS). Keeping the hash
    # lets PACKAGE carry it forward on the next run so SCORE's skip-
    # unchanged-pubs check actually takes effect — otherwise every
    # package+score cycle pointlessly re-scores ~28k unchanged pubs.
    pubs = json.loads(PUBS_JSON.read_text())

    scored = sum(1 for p in pubs if p.get("sun"))
    print(f"  {scored}/{len(pubs)} pubs now have sun scores")

    # Write sun scores back to pubs_enriched.json so they survive PACKAGE reruns.
    ENRICHED_PATH = ROOT / "data" / "pubs_enriched.json"
    if ENRICHED_PATH.exists():
        enriched = json.loads(ENRICHED_PATH.read_text())
        sun_by_id = {p.get("id"): p["sun"] for p in pubs if p.get("sun") and p.get("id")}
        backfilled = 0
        for ep in enriched:
            sun = sun_by_id.get(ep.get("id"))
            if sun:
                ep["sun"] = sun
                backfilled += 1
        ENRICHED_PATH.write_text(json.dumps(enriched, indent=2))
        print(f"  Backfilled {backfilled} sun scores to pubs_enriched.json")

    # Regenerate index + detail chunks with sun data.
    print("  Regenerating splits...")
    _regenerate_splits(pubs)

    return {"scored": scored, "needs_scoring": needs_scoring}
