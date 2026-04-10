"""Stage 5: SCORE — compute Sunny Ratings via TypeScript worker pool.

Shells out to `pnpm tsx scripts/precompute_sun.ts`. The TypeScript code
uses the same shadow.ts as the browser — single source of truth.

Adds per-pub skip logic: pubs whose outdoor polygon hash hasn't changed
since the last scoring run keep their existing sun field.
"""

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PUBS_JSON = ROOT / "public" / "data" / "pubs.json"


def _outdoor_hash(pub: dict) -> str | None:
    """Hash a pub's outdoor polygon. Returns None if no outdoor."""
    outdoor = pub.get("outdoor")
    if not outdoor:
        return None
    return hashlib.md5(json.dumps(outdoor, sort_keys=True).encode()).hexdigest()[:12]


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
        ["pnpm", "tsx", str(ROOT / "scripts" / "precompute_sun.ts")],
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
    return {"scored": scored, "needs_scoring": needs_scoring}
