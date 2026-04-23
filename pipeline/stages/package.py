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
from pathlib import Path

from pipeline.utils.localities import la_to_country, la_to_county, la_to_town_fallback

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
PUBLIC_DATA = Path(__file__).resolve().parent.parent.parent / "public" / "data"
PUBS_ENRICHED = DATA_DIR / "pubs_enriched.json"
PUBS_OUT = PUBLIC_DATA / "pubs.json"
PUBS_INDEX_OUT = PUBLIC_DATA / "pubs-index.json"
DETAIL_DIR = PUBLIC_DATA / "detail"
SLUG_LOCK = DATA_DIR / "slug_lock.json"

# Fields for the slim index (everything the pub list + search needs, plus
# the small string fields schema.org BarOrPub structured data references on
# every pub page — phone, postal address, website, brand. Including them
# here avoids a second R2 fetch per Pages Function cold start. Adds roughly
# 1.6 MB uncompressed to a 9 MB index; edge-cached so bandwidth impact is
# negligible).
INDEX_FIELDS = {
    "id", "name", "lat", "lng", "slug", "town", "county", "country",
    "opening_hours", "outdoor_area_m2", "outdoor_seating", "beer_garden",
    # Schema.org BarOrPub fields:
    "phone", "website", "brand", "brewery",
    "addr_street", "addr_housenumber", "addr_postcode",
}

# Heavy fields that go in detail chunks (loaded on pub selection).
DETAIL_FIELDS = {
    "outdoor", "elev", "horizon", "horizon_dist", "clat", "clng",
    "real_ale", "food", "wheelchair", "dog", "wifi",
    "local_authority",
}


# ── Locality + slug derivation ───────────────────────────────────────────


def derive_town(pub: dict, place_lookup=None, to_osgb=None) -> str | None:
    """Derive town name for a pub.

    Priority:
    1. OSM addr tags (most accurate)
    2. OS Open Names nearest populated place (geocoded from coordinates)
    3. LA name fallback (stripped suffix, last resort)
    """
    for key in ("addr_city", "addr_town", "addr_village", "addr_hamlet", "addr_place"):
        val = pub.get(key)
        if val:
            return val.strip()
    # Geocode from coordinates via OS Open Names.
    if place_lookup and place_lookup.available and to_osgb:
        e, n = to_osgb.transform(pub["lng"], pub["lat"])
        name = place_lookup.nearest_town(e, n)
        if name:
            return name
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


def _dedup_pubs(pubs: list[dict]) -> list[dict]:
    """Remove duplicate pubs from border overlap and OSM node+way duplication.

    Two dedup rules:
    1. Same OSM ID: keep first occurrence (border overlap between .pbf extracts)
    2. Same name + same coords (within ~10m): prefer the entry with a polygon
       (way/relation over node, since it has the building outline)
    """
    # Pass 1: deduplicate by exact ID.
    seen_ids: set[str] = set()
    deduped: list[dict] = []
    id_dupes = 0
    for pub in pubs:
        pid = pub.get("id", "")
        if pid in seen_ids:
            id_dupes += 1
            continue
        seen_ids.add(pid)
        deduped.append(pub)

    # Pass 2: deduplicate by name + rounded coords (node+way for same pub).
    # Group by (name, lat_rounded, lng_rounded). If multiple, keep the one
    # with a polygon (building outline), or the first if none have one.
    from collections import defaultdict
    groups: dict[str, list[int]] = defaultdict(list)
    for i, pub in enumerate(deduped):
        key = f"{pub.get('name', '')}|{round(pub['lat'], 4)}|{round(pub['lng'], 4)}"
        groups[key].append(i)

    keep: set[int] = set()
    coord_dupes = 0
    for indices in groups.values():
        if len(indices) == 1:
            keep.add(indices[0])
            continue
        # Prefer the entry with a polygon (way > node).
        best = indices[0]
        for idx in indices:
            if deduped[idx].get("polygon"):
                best = idx
                break
        keep.add(best)
        coord_dupes += len(indices) - 1

    result = [deduped[i] for i in sorted(keep)]
    if id_dupes or coord_dupes:
        print(f"  Deduplication: removed {id_dupes} ID dupes + {coord_dupes} coord dupes "
              f"({len(pubs)} → {len(result)})")
    return result


def assemble_outputs(pubs: list[dict]) -> dict:
    """Derive localities, assign slugs, write pubs.json + index + detail chunks."""
    # Deduplicate before processing.
    pubs = _dedup_pubs(pubs)

    # Carry forward sun scores from existing pubs.json so PACKAGE reruns
    # don't wipe out scores computed by SCORE. Scores live in pubs.json
    # (written by precompute_sun) but not in pubs_enriched.json.
    if PUBS_OUT.exists():
        try:
            existing = json.loads(PUBS_OUT.read_text())
            sun_by_slug = {p["slug"]: p["sun"] for p in existing if p.get("sun") and p.get("slug")}
            if sun_by_slug:
                carried = 0
                for pub in pubs:
                    if not pub.get("sun") and pub.get("slug") in sun_by_slug:
                        pub["sun"] = sun_by_slug[pub["slug"]]
                        carried += 1
                if carried:
                    print(f"  Carried forward {carried} sun scores from existing pubs.json")
        except (json.JSONDecodeError, KeyError):
            pass

    # Initialize OS Open Names place lookup for town derivation.
    from pipeline.utils.places import PlaceLookup
    from pyproj import Transformer
    place_lookup = PlaceLookup()
    to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True) if place_lookup.available else None
    if place_lookup.available:
        print("  OS Open Names loaded for town derivation")

    # Derive town/country for every pub.
    geocoded = 0
    for pub in pubs:
        if not pub.get("town"):
            town = derive_town(pub, place_lookup, to_osgb)
            if town:
                pub["town"] = town
                geocoded += 1
        if not pub.get("country"):
            pub["country"] = la_to_country(pub.get("local_authority"))
        if not pub.get("county"):
            county = la_to_county(pub.get("local_authority"))
            if county:
                pub["county"] = county

    # Generate stable slugs.
    new_slugs = assign_slugs(pubs)
    print(f"  {new_slugs} new slugs assigned")

    with_town = sum(1 for p in pubs if p.get("town"))
    with_county = sum(1 for p in pubs if p.get("county"))
    print(f"  {with_town}/{len(pubs)} pubs have a town ({geocoded} geocoded from OS Open Names)")
    print(f"  {with_county}/{len(pubs)} pubs have a county")

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
            idx["sun"] = {
                "score": out["sun"]["score"],
                "label": out["sun"]["label"],
                "best_window": out["sun"].get("best_window"),
                "evening_sun": out["sun"].get("evening_sun"),
                "all_day_sun": out["sun"].get("all_day_sun"),
            }
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
    """Generate PMTiles from buildings GeoPackage."""
    from pipeline.stages.tiles import main as tiles_main
    print("  Generating building tiles...", flush=True)
    tiles_main(area)
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
