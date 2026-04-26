"""Stage 5: SCORE — compute Sunny Ratings via TypeScript worker pool.

Shells out to `pnpm tsx pipeline/ts/precompute_sun.ts`. The TypeScript code
uses the same shadow.ts as the browser — single source of truth.

After scoring, regenerates pubs-index.json and detail chunks so they
include sun data.
"""

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PUBS_JSON = ROOT / "public" / "data" / "pubs.json"

# Share the assembly logic with PACKAGE — the field sets and per-pub /
# detail-chunk / slim-index writers all live in package.py so SCORE
# regeneration can never drift from PACKAGE assembly.
from pipeline.stages.package import write_outputs  # noqa: E402


def _outdoor_hash(pub: dict) -> str | None:
    outdoor = pub.get("outdoor")
    if not outdoor:
        return None
    return hashlib.md5(json.dumps(outdoor, sort_keys=True).encode()).hexdigest()[:12]


def _atomic_write(path: Path, text: str) -> None:
    """Write to <path>.tmp then rename, so a crash mid-write can't truncate."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


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
    _atomic_write(PUBS_JSON, json.dumps(pubs))

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
        _atomic_write(ENRICHED_PATH, json.dumps(enriched, indent=2))
        print(f"  Backfilled {backfilled} sun scores to pubs_enriched.json")

    # Regenerate slim index, detail chunks, and per-pub files with sun data.
    print("  Regenerating outputs...")
    write_outputs(pubs)

    return {"scored": scored, "needs_scoring": needs_scoring}
