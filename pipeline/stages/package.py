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
PUB_DIR = PUBLIC_DATA / "pub"
SLUG_LOCK = DATA_DIR / "slug_lock.json"

# Fields for the slim index — JUST what the SPA needs at startup for
# list rendering, search, distance sort, the open-now filter, and the
# explore page's sort-by-garden-size. Everything else (BarOrPub schema
# fields, outdoor_seating tags, heavy outdoor/horizon/elev) lives in
# the per-pub files at /data/pub/{slug}.json so the slim index stays
# small enough for fast SPA startup parsing — and the /pub/ Pages
# Function never has to parse it at all.
INDEX_FIELDS = {
    "id", "name", "lat", "lng", "slug", "town", "county", "country",
    "opening_hours", "outdoor_area_m2",
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
        except json.JSONDecodeError as e:
            # Silent reset re-slugs every pub and breaks every Google-indexed
            # URL. Fail hard so an operator sees the problem and can restore
            # from git (the lock is tracked).
            raise RuntimeError(
                f"slug_lock.json is corrupted ({e}). Restore from git or "
                "the last-known-good backup — a silent reset would rename "
                "every pub slug and break every indexed URL."
            ) from e
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
        _atomic_write(SLUG_LOCK, json.dumps(lock, indent=2, sort_keys=True))

    return new_count


def _atomic_write(path: Path, text: str) -> None:
    """tmp + rename so a crash mid-write can't truncate the target file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


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

    # Carry forward sun scores + outdoor hashes from existing pubs.json so
    # PACKAGE reruns don't wipe out work done by SCORE. Both live only in
    # pubs.json (written by SCORE) not in pubs_enriched.json. Without the
    # _outdoor_hash carry-forward, SCORE's skip-unchanged-pubs check fails
    # every run — so every package+score cycle re-scored all 28k pubs
    # instead of the handful with changed outdoor polygons.
    if PUBS_OUT.exists():
        try:
            existing = json.loads(PUBS_OUT.read_text())
            by_slug = {
                p["slug"]: p
                for p in existing
                if p.get("slug") and (p.get("sun") or p.get("_outdoor_hash"))
            }
            if by_slug:
                carried_sun = 0
                carried_hash = 0
                for pub in pubs:
                    prev = by_slug.get(pub.get("slug") or "")
                    if not prev:
                        continue
                    if not pub.get("sun") and prev.get("sun"):
                        pub["sun"] = prev["sun"]
                        carried_sun += 1
                    if not pub.get("_outdoor_hash") and prev.get("_outdoor_hash"):
                        pub["_outdoor_hash"] = prev["_outdoor_hash"]
                        carried_hash += 1
                if carried_sun:
                    print(f"  Carried forward {carried_sun} sun scores from existing pubs.json")
                if carried_hash:
                    print(f"  Carried forward {carried_hash} outdoor hashes (SCORE skip state)")
        except (json.JSONDecodeError, KeyError):
            pass

    # Initialize OS Open Names place lookup for town derivation.
    from pyproj import Transformer

    from pipeline.utils.places import PlaceLookup
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

    # tmp + rename so a crash mid-write can't leave a truncated pubs.json.
    _atomic_write(PUBS_OUT, json.dumps(output_pubs))
    pubs_size = PUBS_OUT.stat().st_size / 1e6
    print(f"  pubs.json: {pubs_size:.1f} MB")

    splits = write_outputs(output_pubs)

    return {
        "pubs": len(output_pubs),
        "with_town": with_town,
        "new_slugs": new_slugs,
        **splits,
    }


def write_outputs(pubs: list[dict]) -> dict:
    """Write the slim index, detail chunks, and per-pub JSON files.

    Called by both PACKAGE (initial assembly) and SCORE (regeneration after
    sun scoring). Each per-pub file at /data/pub/{slug}.json contains the
    full pub data plus a `nearby` array of the 10 nearest pubs — the
    /pub/[slug] Pages Function fetches one such file per request instead
    of parsing the multi-MB index, which collapsed cold-start CPU time
    from "503 timeout" to "sub-100 ms".
    """
    import numpy as np
    from scipy.spatial import cKDTree

    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

    # Slim index — just the fields the SPA needs at startup for list,
    # search, distance sort, the open-now filter, and the explore page's
    # sort-by-garden-size. Everything else is in /data/pub/{slug}.json.
    index_pubs = []
    for pub in pubs:
        idx = {}
        for k in INDEX_FIELDS:
            if k in pub and pub[k]:
                idx[k] = pub[k]
        idx["lat"] = pub["lat"]
        idx["lng"] = pub["lng"]
        if pub.get("sun"):
            # Slim-index sun: just the fields the SPA needs in the list +
            # explore views. The full sun object (morning/midday/sample_day)
            # lives in the per-pub file, only loaded on pub selection.
            idx["sun"] = {
                "score": pub["sun"]["score"],
                "label": pub["sun"]["label"],
                "best_window": pub["sun"].get("best_window"),
                "evening_sun": pub["sun"].get("evening_sun"),
                "all_day_sun": pub["sun"].get("all_day_sun"),
            }
        index_pubs.append(idx)

    _atomic_write(PUBS_INDEX_OUT, json.dumps(index_pubs))
    idx_size = PUBS_INDEX_OUT.stat().st_size / 1e6
    with_sun = sum(1 for p in index_pubs if "sun" in p)
    print(f"  pubs-index.json: {idx_size:.1f} MB ({with_sun} with sun)")

    # Per-pub files. Compute the 10 nearest pubs for each via cKDTree on
    # locally-projected coordinates (cosine-corrected for UK latitudes).
    print("  Computing nearest neighbours...")
    mid_lat = sum(p["lat"] for p in pubs) / len(pubs)
    m_per_deg_lng = 111320.0 * math.cos(math.radians(mid_lat))
    xy = np.array([[p["lat"] * 111320.0, p["lng"] * m_per_deg_lng] for p in pubs])
    tree = cKDTree(xy)
    # k=11 gives self + 10 neighbours; the self entry is index 0 (distance 0).
    _, neighbour_idxs = tree.query(xy, k=11)

    staging_pub = PUBLIC_DATA / "pub.tmp"
    if staging_pub.exists():
        for f in staging_pub.glob("*.json"):
            f.unlink()
    else:
        staging_pub.mkdir(parents=True)

    pub_count = 0
    for i, pub in enumerate(pubs):
        slug = pub.get("slug")
        if not slug:
            continue
        pub_data = {k: v for k, v in pub.items() if v is not None and not k.startswith("_")}
        nearby = []
        for j in neighbour_idxs[i][1:]:
            n = pubs[j]
            if not n.get("slug"):
                continue
            nearby.append({
                "slug": n["slug"],
                "name": n.get("name"),
                "lat": n["lat"],
                "lng": n["lng"],
                "town": n.get("town"),
                "sun_score": (n.get("sun") or {}).get("score"),
            })
        pub_data["nearby"] = nearby
        (staging_pub / f"{slug}.json").write_text(json.dumps(pub_data))
        pub_count += 1

    PUB_DIR.mkdir(parents=True, exist_ok=True)
    for old in PUB_DIR.glob("*.json"):
        old.unlink()
    for f in staging_pub.glob("*.json"):
        f.rename(PUB_DIR / f.name)
    staging_pub.rmdir()
    pub_total = sum(f.stat().st_size for f in PUB_DIR.glob("*.json"))
    print(f"  pub/: {pub_count} files, {pub_total / 1e6:.1f} MB")

    return {"per_pub_files": pub_count}


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
