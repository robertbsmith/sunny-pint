"""Match pubs to Land Registry INSPIRE plots and compute outdoor areas.

For each pub, finds the cadastral parcel containing it, then subtracts
all building footprints (from OSM GeoPackage) to get the outdoor area polygon.

Also derives locality data (town, country, slug) for each pub. The town is
sourced from OSM addr tags first, then from the matched parcel's local
authority as a fallback. Slugs are stable across pipeline runs via a lock
file (data/slug_lock.json) so SEO URLs never change once published.

Runs after merge_pubs.py — enriches data/pubs_merged.json with plot/outdoor
fields, then writes result to public/data/pubs.json.

Usage:
    uv run python scripts/match_plots.py --area norwich
"""

import json
import re
import sqlite3
from pathlib import Path

import fiona
from areas import in_bbox, parse_area
from localities import la_to_country, la_to_town_fallback
from pyproj import Transformer
from shapely import prepare, wkb
from shapely.geometry import Point, Polygon, shape
from shapely.geometry import Point as ShapelyPoint
from shapely.ops import unary_union
from shapely.strtree import STRtree

DATA = Path(__file__).resolve().parent.parent / "data"
PUBS_IN = DATA / "pubs_merged.json"
PUBLIC_DATA = Path(__file__).resolve().parent.parent / "public" / "data"
PUBS_OUT = PUBLIC_DATA / "pubs.json"
PUBS_INDEX_OUT = PUBLIC_DATA / "pubs-index.json"
DETAIL_DIR = PUBLIC_DATA / "detail"
SLUG_LOCK = DATA / "slug_lock.json"
INSPIRE_DIR = DATA / "inspire"
INSPIRE_GPKG = DATA / "inspire.gpkg"
SCOTLAND_GPKG = DATA / "scotland_parcels.gpkg"
GPKG_PATH = DATA / "buildings.gpkg"

to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
to_wgs = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def gpkg_header_len(blob: bytes) -> int:
    if len(blob) < 8:
        return 0
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_type, 0)


class BuildingsStore:
    """Streaming building loader — queries the buildings GeoPackage R-tree
    on a per-parcel basis instead of loading the whole bbox into Python
    memory at once.

    The previous implementation called fetchall() across the whole area
    bbox and held ~200k Polygon objects in memory (~10 GB RAM for Norwich,
    OOM-territory at full UK scale). This version opens the connection
    once, then for every parcel does a tight bbox query that returns ~10
    buildings, decodes them on the fly, and lets them be garbage-collected
    as soon as the matching loop moves on.

    Trade-off: 142 small queries vs 1 large query. SQLite handles indexed
    queries in sub-millisecond time so the wall clock is comparable, while
    peak memory drops from ~10 GB to ~50 MB.
    """

    def __init__(self):
        self._conn: sqlite3.Connection | None = None
        if GPKG_PATH.exists():
            self._conn = sqlite3.connect(str(GPKG_PATH))
        else:
            print(f"  WARNING: {GPKG_PATH} not found — can't subtract buildings from plots")

    def is_open(self) -> bool:
        return self._conn is not None

    def near_parcel(self, parcel, buf_m: float = 8.0) -> list[Polygon]:
        """Return building polygons (in OSGB metres) whose bbox intersects
        the given parcel's bbox + buffer.

        The parcel is in OSGB metres; we convert its bounds back to WGS84
        for the R-tree query because buildings.gpkg stores its R-tree in
        WGS84 (EPSG:4326).
        """
        if self._conn is None:
            return []

        # Parcel bbox in OSGB metres
        minx, miny, maxx, maxy = parcel.bounds
        minx -= buf_m
        miny -= buf_m
        maxx += buf_m
        maxy += buf_m

        # Convert to WGS84 for the R-tree query
        sw_lng, sw_lat = to_wgs.transform(minx, miny)
        ne_lng, ne_lat = to_wgs.transform(maxx, maxy)

        try:
            rows = self._conn.execute(
                "SELECT b.geom FROM buildings b "
                "JOIN rtree_buildings_geom r ON b.fid = r.id "
                "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
                (sw_lng, ne_lng, sw_lat, ne_lat),
            )
        except sqlite3.OperationalError:
            # No R-tree index — would be a full scan; bail out rather than
            # do something stupid in the matching loop.
            return []

        out: list[Polygon] = []
        for (blob,) in rows:
            try:
                hl = gpkg_header_len(blob)
                geom = wkb.loads(blob[hl:])
                if geom.is_empty or not geom.is_valid:
                    continue
                osgb_coords = [to_osgb.transform(x, y) for x, y in geom.exterior.coords]
                poly = Polygon(osgb_coords)
                if poly.is_valid and not poly.is_empty:
                    out.append(poly)
            except Exception:
                continue
        return out

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None


def osgb_to_wgs_rings(geom):
    """Convert a shapely polygon from OSGB to WGS84 as [exterior, ...holes].

    Each ring is [[lat,lng], ...]. First ring is exterior, rest are holes.
    """
    rings = []
    # Exterior ring.
    exterior = []
    for x, y in geom.exterior.coords:
        lng, lat = to_wgs.transform(x, y)
        exterior.append([round(lat, 6), round(lng, 6)])
    rings.append(exterior)
    # Interior rings (holes from subtracted buildings).
    for interior in geom.interiors:
        hole = []
        for x, y in interior.coords:
            lng, lat = to_wgs.transform(x, y)
            hole.append([round(lat, 6), round(lng, 6)])
        rings.append(hole)
    return rings


# Map area names to their primary INSPIRE GML filenames for fast loading.
# Used as a shortcut when the full inspire.gpkg isn't built yet.
AREA_GML_MAP = {
    "norwich": ["Norwich_City_Council.gml", "Broadland_District_Council.gml", "South_Norfolk_Council.gml"],
    "bristol": ["Bristol_City_Council.gml"],
    "london": [],  # too many boroughs — needs the GeoPackage
    "edinburgh": [],  # Scotland — not in INSPIRE
    "cardiff": ["Cardiff_Council.gml"],
}


def load_parcels_near_pubs(pubs: list[dict], area_name: str | None = None) -> tuple | None:
    """Load INSPIRE parcels near pubs.

    Strategy:
    1. If inspire.gpkg exists, use it (fast R-tree, works for any area).
    2. Otherwise if area has a known GML mapping, load those files directly.
    3. Otherwise warn and skip.
    Returns (STRtree, parcels_list) or None.
    """
    # Build pub points in OSGB.
    pub_points_osgb = []
    for pub in pubs:
        if pub.get("polygon") and len(pub["polygon"]) > 2:
            clat = sum(c[0] for c in pub["polygon"]) / len(pub["polygon"])
            clng = sum(c[1] for c in pub["polygon"]) / len(pub["polygon"])
        else:
            clat, clng = pub["lat"], pub["lng"]
        x, y = to_osgb.transform(clng, clat)
        pub_points_osgb.append(ShapelyPoint(x, y))

    pub_tree = STRtree(pub_points_osgb)
    BUF = 50

    if INSPIRE_GPKG.exists() or SCOTLAND_GPKG.exists():
        # Load from both INSPIRE (England+Wales) and Scotland GPKGs.
        result = _load_from_gpkg(pub_points_osgb, pub_tree, BUF) if INSPIRE_GPKG.exists() else None
        scot_result = _load_from_gpkg(pub_points_osgb, pub_tree, BUF, gpkg_path=SCOTLAND_GPKG) if SCOTLAND_GPKG.exists() else None

        if result and scot_result:
            # Merge both parcel sets.
            parcels = list(result[1]) + list(scot_result[1])
            parcel_las = list(result[2]) + list(scot_result[2])
            print(f"  Merged: {len(result[1]):,} INSPIRE + {len(scot_result[1]):,} Scotland = {len(parcels):,} parcels")
            return STRtree(parcels), parcels, parcel_las
        return result or scot_result

    # Fast path: load specific GML files for known areas.
    area_key = (area_name or "").lower()
    if area_key in AREA_GML_MAP and AREA_GML_MAP[area_key]:
        gml_names = AREA_GML_MAP[area_key]
        print(f"  Fast path: loading {len(gml_names)} GML files for {area_name}")
        return _load_from_gml_files(gml_names, pub_tree, BUF)

    print(f"  WARNING: {INSPIRE_GPKG} not found. Run: uv run python scripts/build_inspire_gpkg.py")
    return None


def _load_from_gml_files(gml_names: list[str], pub_tree, buf):
    """Load parcels from a small set of named GML files (fast path).

    Returns (STRtree, parcels, parcel_las) where parcel_las is parallel to
    parcels and contains the local authority name (derived from the GML
    filename) for each parcel.
    """

    parcels = []
    parcel_las: list[str] = []
    for name in gml_names:
        path = INSPIRE_DIR / name
        if not path.exists():
            print(f"    {name}: not found, skipping")
            continue
        # "Norwich_City_Council.gml" → "Norwich City Council"
        la_name = path.stem.replace("_", " ")
        try:
            with fiona.open(str(path)) as src:
                for feat in src:
                    geom = shape(feat["geometry"])
                    if geom.is_empty or not geom.is_valid:
                        continue
                    nearby = pub_tree.query(geom.buffer(buf))
                    if len(nearby) == 0:
                        continue
                    prepare(geom)
                    parcels.append(geom)
                    parcel_las.append(la_name)
            print(f"    {name}: ok ({len(parcels)} parcels so far)", flush=True)
        except Exception as e:
            print(f"    {name}: ERROR {e}")

    print(f"  {len(parcels)} parcels near pubs from {len(gml_names)} files")
    if not parcels:
        return None
    return STRtree(parcels), parcels, parcel_las


def _load_from_gpkg(pub_points_osgb, pub_tree, buf, gpkg_path=None):
    """Load parcels from a GeoPackage (INSPIRE or Scotland) using R-tree.

    Returns (STRtree, parcels, parcel_las) where parcel_las is parallel to
    parcels and contains the local_authority value from each parcel row.
    """
    gpkg_path = gpkg_path or INSPIRE_GPKG
    import sqlite3 as _sqlite3

    # Query parcels near each pub using the GeoPackage R-tree index.
    # Compute the union bbox of all pubs (with buffer) for a single query.
    pub_xs = [p.x for p in pub_points_osgb]
    pub_ys = [p.y for p in pub_points_osgb]
    min_x, max_x = min(pub_xs) - buf, max(pub_xs) + buf
    min_y, max_y = min(pub_ys) - buf, max(pub_ys) + buf
    print("  Querying INSPIRE GeoPackage for parcels in pub area...", flush=True)

    print(f"  Loading parcels from {gpkg_path.name}...")
    conn = _sqlite3.connect(str(gpkg_path))

    # Detect whether this gpkg has the local_authority column. Older builds
    # (before build_inspire_gpkg.py started recording it) won't have it.
    cur = conn.execute("PRAGMA table_info(parcels)")
    col_names = [r[1] for r in cur.fetchall()]
    has_la_column = "local_authority" in col_names
    if not has_la_column:
        print(
            "  WARNING: inspire.gpkg has no local_authority column. "
            "Locality data will be missing — re-run `just build-inspire-gpkg` to fix."
        )

    la_select = "p.local_authority" if has_la_column else "NULL AS local_authority"

    import time as _time

    # Use R-tree spatial index for fast bbox query. Stream via cursor
    # instead of fetchall() to show progress on large result sets.
    BATCH = 50000
    try:
        cursor = conn.execute(
            f"SELECT p.fid, p.geom, {la_select} FROM parcels p "
            "JOIN rtree_parcels_geom r ON p.fid = r.id "
            "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
            (min_x, max_x, min_y, max_y),
        )
    except _sqlite3.OperationalError:
        # No R-tree — fall back to full scan (slow).
        print("  WARNING: no R-tree index, falling back to full scan")
        cursor = conn.execute(f"SELECT fid, geom, {la_select} FROM parcels")

    # Parse geometries and filter to those actually near a pub.
    parcels = []
    parcel_las: list[str | None] = []
    scanned = 0
    t0 = _time.time()
    while True:
        batch = cursor.fetchmany(BATCH)
        if not batch:
            break
        for fid, blob, la in batch:
            scanned += 1
            try:
                hl = gpkg_header_len(blob)
                geom = wkb.loads(blob[hl:])
                if geom.is_empty or not geom.is_valid:
                    continue

                nearby = pub_tree.query(geom.buffer(buf))
                if len(nearby) == 0:
                    continue

                prepare(geom)
                parcels.append(geom)
                parcel_las.append(la)
            except Exception:
                continue
        elapsed = _time.time() - t0
        rate = scanned / elapsed if elapsed else 0
        print(
            f"  parcels: {scanned:,} scanned, {len(parcels):,} kept  "
            f"{rate:,.0f}/s",
            flush=True,
        )
    conn.close()

    print(f"  {len(parcels)} parcels near pubs (from {scanned:,} scanned)")
    if not parcels:
        return None

    return STRtree(parcels), parcels, parcel_las


def building_polygon_osgb(pub):
    """Convert a pub's OSM building polygon to OSGB shapely geometry."""
    if not pub.get("polygon"):
        return None
    coords = []
    for lat, lng in pub["polygon"]:
        x, y = to_osgb.transform(lng, lat)
        coords.append((x, y))
    poly = Polygon(coords)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly


# ── Locality + slug derivation ─────────────────────────────────────────────


def derive_town(pub: dict) -> str | None:
    """Pick the best town for a pub.

    Precedence: OSM addr tags (most specific first), then a fallback derived
    from the matched parcel's local authority. Returns None if neither source
    has anything usable — those pubs won't appear on city landing pages.
    """
    for key in ("addr_city", "addr_town", "addr_village", "addr_hamlet", "addr_place"):
        val = pub.get(key)
        if val:
            return val.strip()
    return la_to_town_fallback(pub.get("local_authority"))


def slugify(text: str) -> str:
    """Lowercase ASCII kebab-case slug.

    Handles ampersands ("Fox & Hound" → "fox-and-hound"), apostrophes
    ("King's Head" → "kings-head"), and any other punctuation.
    """
    text = text.lower()
    text = text.replace("&", " and ")
    # Strip apostrophes (curly and straight) without leaving a hyphen.
    text = text.replace("'", "").replace("\u2019", "")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")


def lock_key(pub: dict) -> str:
    """Stable identifier for the slug lock file.

    Keyed on name + rounded coordinates so OSM ID changes (way → relation,
    re-ingested with a new ID) don't cause a slug to be re-issued under a
    different name. ~11m of resolution at lat=52, fine for distinguishing
    pubs.
    """
    name = pub.get("name") or "unnamed"
    return f"{name}|{round(pub['lat'], 4)}|{round(pub['lng'], 4)}"


def load_slug_lock() -> dict[str, str]:
    if SLUG_LOCK.exists():
        try:
            return json.loads(SLUG_LOCK.read_text())
        except json.JSONDecodeError:
            print(f"  WARNING: {SLUG_LOCK} is corrupted, starting fresh")
    return {}


def save_slug_lock(lock: dict[str, str]) -> None:
    SLUG_LOCK.parent.mkdir(parents=True, exist_ok=True)
    SLUG_LOCK.write_text(json.dumps(lock, indent=2, sort_keys=True))


def assign_slugs(pubs: list[dict]) -> None:
    """Mutate pubs in place to add a stable, collision-free `slug` field.

    Uses data/slug_lock.json to preserve historical slugs across pipeline
    runs. New pubs get a freshly minted slug; previously seen pubs reuse
    their locked slug even if the name or town changes slightly.
    """
    lock = load_slug_lock()
    used: set[str] = set(lock.values())
    new_locks: dict[str, str] = {}

    for pub in pubs:
        key = lock_key(pub)
        if key in lock:
            pub["slug"] = lock[key]
            continue

        # Build a fresh slug.
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
        new_locks[key] = candidate

    if new_locks:
        lock.update(new_locks)
        save_slug_lock(lock)
        print(f"  {len(new_locks)} new slugs locked (total: {len(lock)})")


def main():
    area = parse_area()
    print(f"Matching plots for {area.name}")

    if not PUBS_IN.exists():
        print(f"ERROR: {PUBS_IN} not found. Run merge_pubs.py first.")
        return

    pubs = json.loads(PUBS_IN.read_text())
    print(f"  {len(pubs)} pubs loaded")

    # Merge enrichment fields from pubs_enriched.json (horizon, elev, etc.)
    # that were computed by v2 enrich or compute_horizons/measure_heights.
    ENRICHED_PATH = DATA / "pubs_enriched.json"
    ENRICH_FIELDS = {"horizon", "horizon_dist", "elev", "outdoor", "local_authority", "outdoor_area_m2"}
    if ENRICHED_PATH.exists():
        enriched = json.loads(ENRICHED_PATH.read_text())
        enriched_by_id = {p["id"]: p for p in enriched if "id" in p}
        merged_count = 0
        for pub in pubs:
            ep = enriched_by_id.get(pub.get("id"))
            if ep:
                for field in ENRICH_FIELDS:
                    if field in ep and ep[field] and field not in pub:
                        pub[field] = ep[field]
                        merged_count += 1
        print(f"  Merged {merged_count} enrichment fields from pubs_enriched.json ({len(enriched_by_id)} enriched pubs)")

    # Filter to the requested area BEFORE computing the parcel-load bbox.
    # Otherwise, when pubs_merged.json is the full UK dataset (~33k pubs),
    # the bbox would span the whole country and the GeoPackage R-tree query
    # would return all 24M parcels — OOM and 30+ minute load.
    if area.bbox is not None:
        before = len(pubs)
        pubs = [p for p in pubs if in_bbox(p["lat"], p["lng"], area.bbox)]
        print(f"  {len(pubs)}/{before} pubs in {area.name} bbox")

    result = load_parcels_near_pubs(pubs, area_name=area.name.lower())

    if result:
        parcel_tree, all_parcels, all_parcel_las = result

        # Streaming building loader — opens the GPKG once and queries
        # buildings on a per-parcel basis. Replaces the previous bulk load
        # which held ~200k Polygon objects in ~10 GB of Python memory.
        buildings_store = BuildingsStore()

        import time as _time
        matched = 0
        outdoor_computed = 0
        skipped_done = 0
        last_save = _time.time()
        t0 = last_save
        SAVE_INTERVAL = 300  # incremental save every 5 min

        for pi, pub in enumerate(pubs):
            if not in_bbox(pub["lat"], pub["lng"], area.bbox):
                continue

            # Skip pubs already processed in a previous run.
            if pub.get("outdoor") and pub.get("local_authority"):
                skipped_done += 1
                matched += 1
                outdoor_computed += 1
                continue

            if pub.get("polygon") and len(pub["polygon"]) > 2:
                clat = sum(c[0] for c in pub["polygon"]) / len(pub["polygon"])
                clng = sum(c[1] for c in pub["polygon"]) / len(pub["polygon"])
                px, py = to_osgb.transform(clng, clat)
            else:
                px, py = to_osgb.transform(pub["lng"], pub["lat"])
            pt = Point(px, py)

            # Find containing parcel via spatial index. Track which one matched
            # so we can stamp its local_authority onto the pub.
            candidates = parcel_tree.query(pt)
            parcel = None
            parcel_la: str | None = None
            for idx in candidates:
                if all_parcels[idx].contains(pt):
                    parcel = all_parcels[idx]
                    parcel_la = all_parcel_las[idx]
                    break

            if parcel is None:
                continue

            matched += 1
            pub["plot"] = osgb_to_wgs_rings(parcel)[0]
            if parcel_la:
                pub["local_authority"] = parcel_la

            # Subtract ALL buildings that intersect this parcel — streamed
            # via the per-parcel R-tree query. Typical result: ~5–20 buildings.
            nearby_buildings = buildings_store.near_parcel(parcel)
            overlapping = [b for b in nearby_buildings if b.intersects(parcel)]

            if not overlapping:
                b = building_polygon_osgb(pub)
                if b and b.is_valid and not b.is_empty:
                    overlapping = [b]

            if not overlapping:
                continue

            buildings_union = unary_union(overlapping)
            outdoor = parcel.difference(buildings_union)
            if not outdoor.is_empty:
                if outdoor.geom_type == "MultiPolygon":
                    outdoor = max(outdoor.geoms, key=lambda g: g.area)
                pub["outdoor"] = osgb_to_wgs_rings(outdoor)
                pub["outdoor_area_m2"] = round(outdoor.area, 1)
                outdoor_computed += 1

            if (pi + 1) % 1000 == 0:
                elapsed = _time.time() - t0
                rate = (pi + 1) / elapsed if elapsed else 0
                eta = (len(pubs) - pi - 1) / rate if rate else 0
                print(
                    f"  [{pi + 1}/{len(pubs)}] {matched} matched, {outdoor_computed} outdoor  "
                    f"{rate:.1f}/s  ETA {eta:.0f}s",
                    flush=True,
                )

            # Incremental save every 5 minutes.
            if _time.time() - last_save > SAVE_INTERVAL:
                tmp = PUBS_IN.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(pubs, indent=2))
                tmp.replace(PUBS_IN)
                print(f"  ** incremental save ({matched} matched) **", flush=True)
                last_save = _time.time()

        buildings_store.close()
        if skipped_done:
            print(f"\n  {skipped_done} pubs skipped (already had outdoor data)")
        print(f"  {matched}/{len(pubs)} pubs matched to a plot")
        print(f"  {outdoor_computed} outdoor areas computed (plot minus all buildings)")
    else:
        print("  No parcels — skipping plot matching")

    # Derive locality (town, country) for every pub from OSM addr tags + the
    # local authority of the matched parcel. This drives SEO landing-page
    # generation downstream.
    for pub in pubs:
        town = derive_town(pub)
        if town:
            pub["town"] = town
        pub["country"] = la_to_country(pub.get("local_authority"))

    # Generate stable slugs (locked across pipeline runs).
    assign_slugs(pubs)

    # Stats on locality coverage so we know how good downstream pages will be.
    with_town = sum(1 for p in pubs if p.get("town"))
    with_la = sum(1 for p in pubs if p.get("local_authority"))
    print(f"\n  {with_la}/{len(pubs)} pubs have a local authority")
    print(f"  {with_town}/{len(pubs)} pubs have a town")

    # ── Output: three files ──────────────────────────────────────────
    #
    # 1. pubs.json        — full data (local pipeline use + precompute_sun)
    # 2. pubs-index.json  — slim (~1.2 MB gz) for browser startup
    # 3. detail/*.json    — per-grid-cell chunks (~7 KB gz avg) for on-demand load
    #
    # pubs-index.json goes in dist/ (CF Pages). Detail chunks go on R2.
    # pubs.json stays local (too big for Pages, only used by scripts).

    import math

    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

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

    output_pubs = []
    index_pubs = []
    detail_chunks: dict[str, dict] = {}

    for pub in pubs:
        out = dict(pub)
        # Compute centroid from polygon.
        if "polygon" in out and out["polygon"] and len(out["polygon"]) > 2:
            out["clat"] = round(sum(c[0] for c in out["polygon"]) / len(out["polygon"]), 6)
            out["clng"] = round(sum(c[1] for c in out["polygon"]) / len(out["polygon"]), 6)
        out.pop("polygon", None)
        out.pop("plot", None)
        out.pop("_enrich_hash", None)
        output_pubs.append(out)

        # Slim index entry.
        idx = {}
        for k in INDEX_FIELDS:
            if k in out and out[k]:
                idx[k] = out[k]
        # Always include lat/lng even if somehow falsy.
        idx["lat"] = out["lat"]
        idx["lng"] = out["lng"]
        # Sun: only score + label for the list badge.
        if out.get("sun"):
            idx["sun"] = {"score": out["sun"]["score"], "label": out["sun"]["label"]}
        index_pubs.append(idx)

        # Detail chunk entry (keyed by slug, grouped by 0.1° grid cell).
        slug = out.get("slug")
        if slug:
            cell_lat = math.floor(out["lat"] * 10) / 10
            cell_lng = math.floor(out["lng"] * 10) / 10
            cell_key = f"{cell_lat}_{cell_lng}"
            detail = {}
            for k in DETAIL_FIELDS:
                if k in out and out[k] is not None:
                    detail[k] = out[k]
            # Include full sun metrics in detail (best_window, morning/evening etc).
            if out.get("sun"):
                detail["sun"] = out["sun"]
            if detail:
                detail_chunks.setdefault(cell_key, {})[slug] = detail

    # 1. Full pubs.json (local use).
    PUBS_OUT.write_text(json.dumps(output_pubs))
    print(f"  pubs.json:       {PUBS_OUT.stat().st_size / 1e6:.1f} MB (local pipeline use)")

    # 2. Slim index (deployed to dist/).
    PUBS_INDEX_OUT.write_text(json.dumps(index_pubs))
    print(f"  pubs-index.json: {PUBS_INDEX_OUT.stat().st_size / 1e6:.1f} MB (browser startup)")

    # 3. Detail chunks (deployed to R2).
    DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    # Clean old chunks.
    for old in DETAIL_DIR.glob("*.json"):
        old.unlink()
    for cell_key, slugs in detail_chunks.items():
        (DETAIL_DIR / f"{cell_key}.json").write_text(json.dumps(slugs))
    total_detail = sum(f.stat().st_size for f in DETAIL_DIR.glob("*.json"))
    print(f"  detail/:         {len(detail_chunks)} chunks, {total_detail / 1e6:.1f} MB total (R2)")


if __name__ == "__main__":
    main()
