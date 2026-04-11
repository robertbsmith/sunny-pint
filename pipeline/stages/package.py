"""Stage 4: PACKAGE — assemble public outputs + generate PMTiles.

Reads pubs_enriched.json (from ENRICH) and produces:
  - public/data/pubs.json         — full data (local pipeline use + precompute_sun)
  - public/data/pubs-index.json   — slim index for browser startup (~1.2 MB gz)
  - public/data/detail/*.json     — per-grid-cell chunks for on-demand loading
  - public/data/buildings.pmtiles — building vector tiles

Also derives town/country from OSM tags + local authority and generates
stable slugs via data/slug_lock.json.
"""

import json
import math
import re
import subprocess
import sys
from pathlib import Path

# Add scripts/ to path for shared modules.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from localities import la_to_country, la_to_town_fallback

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
PUBLIC_DATA = Path(__file__).resolve().parent.parent.parent / "public" / "data"
PUBS_ENRICHED = DATA_DIR / "pubs_enriched.json"
PUBS_OUT = PUBLIC_DATA / "pubs.json"
PUBS_INDEX_OUT = PUBLIC_DATA / "pubs-index.json"
DETAIL_DIR = PUBLIC_DATA / "detail"
SLUG_LOCK = DATA_DIR / "slug_lock.json"

# Fields for the slim index (everything the pub list + search needs).
INDEX_FIELDS = {
    "id", "name", "lat", "lng", "slug", "town", "country",
    "opening_hours", "outdoor_area_m2", "outdoor_seating", "beer_garden",
}

# Heavy fields that go in detail chunks (loaded on pub selection).
DETAIL_FIELDS = {
    "outdoor", "elev", "horizon", "horizon_dist", "clat", "clng",
    "real_ale", "food", "wheelchair", "dog", "wifi",
    "phone", "website", "brand", "brewery",
    "local_authority", "addr_postcode", "addr_street", "addr_housenumber",
}


# ── Locality + slug derivation ───────────────────────────────────────────


def derive_town(pub: dict) -> str | None:
    for key in ("addr_city", "addr_town", "addr_village", "addr_hamlet", "addr_place"):
        val = pub.get(key)
        if val:
            return val.strip()
    return la_to_town_fallback(pub.get("local_authority"))


def slugify(text: str) -> str:
    text = text.lower()
    text = text.replace("&", " and ")
    text = text.replace("'", "").replace("\u2019", "")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")


def lock_key(pub: dict) -> str:
    name = pub.get("name") or "unnamed"
    return f"{name}|{round(pub['lat'], 4)}|{round(pub['lng'], 4)}"


def assign_slugs(pubs: list[dict]) -> int:
    """Assign stable slugs to pubs. Returns count of new slugs."""
    if SLUG_LOCK.exists():
        try:
            lock = json.loads(SLUG_LOCK.read_text())
        except json.JSONDecodeError:
            print("  WARNING: slug_lock.json corrupted, starting fresh")
            lock = {}
    else:
        lock = {}

    used: set[str] = set(lock.values())
    new_count = 0

    for pub in pubs:
        key = lock_key(pub)
        if key in lock:
            pub["slug"] = lock[key]
            continue

        name_slug = slugify(pub.get("name") or "unnamed-pub")
        town = pub.get("town")
        base = f"{name_slug}-{slugify(town)}" if town else name_slug
        candidate = base
        n = 2
        while candidate in used:
            candidate = f"{base}-{n}"
            n += 1
        used.add(candidate)
        pub["slug"] = candidate
        lock[key] = candidate
        new_count += 1

    if new_count:
        SLUG_LOCK.parent.mkdir(parents=True, exist_ok=True)
        SLUG_LOCK.write_text(json.dumps(lock, indent=2, sort_keys=True))

    return new_count


# ── Output assembly ──────────────────────────────────────────────────────


def assemble_outputs(pubs: list[dict]) -> dict:
    """Derive localities, assign slugs, write pubs.json + index + detail chunks."""
    # Derive town/country for every pub.
    for pub in pubs:
        if not pub.get("town"):
            town = derive_town(pub)
            if town:
                pub["town"] = town
        if not pub.get("country"):
            pub["country"] = la_to_country(pub.get("local_authority"))

    # Generate stable slugs.
    new_slugs = assign_slugs(pubs)
    print(f"  {new_slugs} new slugs assigned")

    with_town = sum(1 for p in pubs if p.get("town"))
    print(f"  {with_town}/{len(pubs)} pubs have a town")

    # Build output files.
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

    output_pubs = []
    index_pubs = []
    detail_chunks: dict[str, dict] = {}

    for pub in pubs:
        out = dict(pub)
        # Compute centroid from polygon.
        if "polygon" in out and out["polygon"] and len(out["polygon"]) > 2:
            out["clat"] = round(sum(c[0] for c in out["polygon"]) / len(out["polygon"]), 6)
            out["clng"] = round(sum(c[1] for c in out["polygon"]) / len(out["polygon"]), 6)
        # Strip internal fields.
        out.pop("polygon", None)
        out.pop("plot", None)
        out.pop("_enrich_hash", None)
        output_pubs.append(out)

        # Slim index entry.
        idx = {}
        for k in INDEX_FIELDS:
            if k in out and out[k]:
                idx[k] = out[k]
        idx["lat"] = out["lat"]
        idx["lng"] = out["lng"]
        if out.get("sun"):
            idx["sun"] = {"score": out["sun"]["score"], "label": out["sun"]["label"]}
        index_pubs.append(idx)

        # Detail chunk entry.
        slug = out.get("slug")
        if slug:
            cell_lat = math.floor(out["lat"] * 10) / 10
            cell_lng = math.floor(out["lng"] * 10) / 10
            cell_key = f"{cell_lat}_{cell_lng}"
            detail = {}
            for k in DETAIL_FIELDS:
                if k in out and out[k] is not None:
                    detail[k] = out[k]
            if out.get("sun"):
                detail["sun"] = out["sun"]
            if detail:
                detail_chunks.setdefault(cell_key, {})[slug] = detail

    # Write full pubs.json.
    PUBS_OUT.write_text(json.dumps(output_pubs))
    pubs_size = PUBS_OUT.stat().st_size / 1e6
    print(f"  pubs.json: {pubs_size:.1f} MB")

    # Write slim index.
    PUBS_INDEX_OUT.write_text(json.dumps(index_pubs))
    index_size = PUBS_INDEX_OUT.stat().st_size / 1e6
    print(f"  pubs-index.json: {index_size:.1f} MB")

    # Write detail chunks.
    DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    for old in DETAIL_DIR.glob("*.json"):
        old.unlink()
    for cell_key, slugs in detail_chunks.items():
        (DETAIL_DIR / f"{cell_key}.json").write_text(json.dumps(slugs))
    total_detail = sum(f.stat().st_size for f in DETAIL_DIR.glob("*.json"))
    print(f"  detail/: {len(detail_chunks)} chunks, {total_detail / 1e6:.1f} MB")

    return {
        "pubs": len(output_pubs),
        "with_town": with_town,
        "new_slugs": new_slugs,
        "detail_chunks": len(detail_chunks),
    }


def generate_tiles(area) -> dict:
    """Run generate_tiles.py for PMTiles output."""
    script = SCRIPTS_DIR / "generate_tiles.py"
    print("  Running generate_tiles.py...", flush=True)
    result = subprocess.run(
        ["uv", "run", "--project", str(SCRIPTS_DIR), "python", str(script),
         "--area", area.name.lower()],
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"generate_tiles.py failed: {result.returncode}")
    return {}


def run(area) -> dict:
    """Run the PACKAGE stage. Returns stats dict."""
    if not PUBS_ENRICHED.exists():
        raise FileNotFoundError(
            f"{PUBS_ENRICHED} not found. Run ENRICH stage first."
        )

    pubs = json.loads(PUBS_ENRICHED.read_text())
    print(f"  {len(pubs)} pubs loaded from pubs_enriched.json")

    # Field coverage summary.
    fields = ["horizon", "elev", "outdoor", "local_authority"]
    for f in fields:
        count = sum(1 for p in pubs if p.get(f))
        print(f"    {f}: {count} ({count * 100 // len(pubs)}%)")

    # Assemble outputs (town, country, slugs, index, chunks).
    stats = assemble_outputs(pubs)

    # Generate PMTiles.
    generate_tiles(area)

    stats["status"] = "completed"
    return stats
