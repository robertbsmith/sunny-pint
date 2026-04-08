"""Merge pub data from FSA, VOA, and OSM into a unified pub list.

FSA provides the primary geocoded list (lat/lng).
VOA provides an authoritative England+Wales list with postcodes.
OSM .pbf provides building polygons and tags (outdoor_seating, beer_garden, opening_hours).

Usage:
    uv run python scripts/merge_pubs.py --area norwich
"""

import json
import math
from pathlib import Path

import osmium

from areas import parse_area, in_bbox, Area

# ── Paths ──────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FSA_PATH = DATA_DIR / "fsa" / "pubs_uk.json"
VOA_PATH = DATA_DIR / "voa" / "pubs_england_wales.json"
PBF_PATH = DATA_DIR / "england-latest.osm.pbf"
OUTPUT_PATH = DATA_DIR / "pubs_merged.json"

# ── Distance utils ─────────────────────────────────────────────────────────

MATCH_RADIUS_M = 75  # max distance for proximity matching


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres between two WGS84 points."""
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
        * math.sin(dlng / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ── OSM pub extraction from .pbf ──────────────────────────────────────────


class PubHandler(osmium.SimpleHandler):
    """Extract amenity=pub from OSM .pbf file."""

    def __init__(self, filter_area: Area):
        super().__init__()
        self._filter_area = filter_area
        self.pubs: list[dict] = []

    def node(self, n):
        if "amenity" in n.tags and n.tags["amenity"] == "pub":
            lat, lng = n.location.lat, n.location.lon
            if in_bbox(lat, lng, self._filter_area.bbox):
                self.pubs.append(self._make_pub(n.tags, lat, lng, f"node_{n.id}", None))

    def way(self, w):
        if "amenity" in w.tags and w.tags["amenity"] == "pub":
            try:
                coords = [(n.lat, n.lon) for n in w.nodes]
                if not coords:
                    return
                lat = sum(c[0] for c in coords) / len(coords)
                lng = sum(c[1] for c in coords) / len(coords)
                if in_bbox(lat, lng, self._filter_area.bbox):
                    polygon = [[c[0], c[1]] for c in coords]
                    self.pubs.append(self._make_pub(w.tags, lat, lng, f"way_{w.id}", polygon))
            except osmium.InvalidLocationError:
                pass

    def _make_pub(self, tags, lat, lng, osm_id, polygon):
        return {
            "osm_id": osm_id,
            "name": tags.get("name", ""),
            "lat": lat,
            "lng": lng,
            "polygon": polygon,
            "beer_garden": tags.get("beer_garden", ""),
            "outdoor_seating": tags.get("outdoor_seating", ""),
            "opening_hours": tags.get("opening_hours", ""),
        }


def extract_osm_pubs(area: Area) -> list[dict]:
    """Extract pubs from OSM .pbf file for the given area."""
    if not PBF_PATH.exists():
        print(f"  WARNING: {PBF_PATH} not found, skipping OSM extraction")
        return []

    print(f"  Extracting pubs from {PBF_PATH.name}...", flush=True)
    handler = PubHandler(area)
    handler.apply_file(str(PBF_PATH), locations=True)
    print(f"  Found {len(handler.pubs)} OSM pubs in {area.name}")
    return handler.pubs


# ── Loading FSA and VOA ───────────────────────────────────────────────────


def load_fsa(area: Area) -> list[dict]:
    """Load FSA pubs, filtered by area."""
    if not FSA_PATH.exists():
        print(f"  WARNING: {FSA_PATH} not found, skipping FSA")
        return []

    with open(FSA_PATH) as f:
        raw = json.load(f)

    pubs = []
    for p in raw:
        lat, lng = p.get("lat"), p.get("lng")
        if lat is None or lng is None:
            continue
        if not in_bbox(lat, lng, area.bbox):
            continue
        pubs.append(p)

    print(f"  {len(pubs)} FSA pubs in {area.name}")
    return pubs


def load_voa(area: Area) -> list[dict]:
    """Load VOA pubs. Since VOA has no geocodes, we can only filter by postcode area later."""
    if not VOA_PATH.exists():
        print(f"  WARNING: {VOA_PATH} not found, skipping VOA")
        return []

    with open(VOA_PATH) as f:
        raw = json.load(f)

    # VOA has no lat/lng so we can't bbox filter directly.
    # We'll match by postcode against FSA pubs instead.
    print(f"  {len(raw)} VOA pubs loaded (no bbox filter — matched by postcode)")
    return raw


# ── Matching ──────────────────────────────────────────────────────────────


def match_osm_to_fsa(fsa_pubs: list[dict], osm_pubs: list[dict]) -> dict[int, dict]:
    """Match OSM pubs to FSA by proximity. Returns {fsa_index: osm_pub}."""
    matches = {}
    for osm_pub in osm_pubs:
        best_dist = MATCH_RADIUS_M
        best_idx = None
        for i, fsa_pub in enumerate(fsa_pubs):
            if i in matches:
                continue
            d = haversine_m(
                osm_pub["lat"], osm_pub["lng"],
                fsa_pub["lat"], fsa_pub["lng"],
            )
            if d < best_dist:
                best_dist = d
                best_idx = i
        if best_idx is not None:
            matches[best_idx] = osm_pub
    return matches


def match_voa_to_fsa(fsa_pubs: list[dict], voa_pubs: list[dict]) -> dict[int, dict]:
    """Match VOA pubs to FSA by postcode. Returns {fsa_index: voa_pub}."""
    # Build postcode index for FSA.
    pc_index: dict[str, list[int]] = {}
    for i, p in enumerate(fsa_pubs):
        pc = p.get("postcode", "").strip().upper()
        if pc:
            pc_index.setdefault(pc, []).append(i)

    matches = {}
    for voa_pub in voa_pubs:
        pc = voa_pub.get("postcode", "").strip().upper()
        if not pc or pc not in pc_index:
            continue
        # Match to first unmatched FSA pub at this postcode.
        for i in pc_index[pc]:
            if i not in matches:
                matches[i] = voa_pub
                break

    return matches


# ── Main ──────────────────────────────────────────────────────────────────


def main():
    area = parse_area()
    print(f"Merging pub data for {area.name}")
    print()

    # Load all sources.
    print("Loading data sources:")
    fsa_pubs = load_fsa(area)
    voa_pubs = load_voa(area)
    osm_pubs = extract_osm_pubs(area)
    print()

    if not fsa_pubs and not osm_pubs:
        print("No pubs found. Check data files and --area.")
        return

    # Use FSA as primary list.
    print("Matching sources...")
    osm_matches = match_osm_to_fsa(fsa_pubs, osm_pubs) if osm_pubs else {}
    voa_matches = match_voa_to_fsa(fsa_pubs, voa_pubs) if voa_pubs else {}
    print(f"  {len(osm_matches)} FSA pubs matched to OSM (of {len(osm_pubs)} OSM pubs)")
    print(f"  {len(voa_matches)} FSA pubs matched to VOA")
    print()

    # Build merged list.
    merged = []
    for i, fsa_pub in enumerate(fsa_pubs):
        pub = {
            "id": f"fsa_{fsa_pub['fhrs_id']}",
            "name": fsa_pub["name"],
            "lat": fsa_pub["lat"],
            "lng": fsa_pub["lng"],
            "postcode": fsa_pub.get("postcode", ""),
            "in_fsa": True,
            "in_osm": i in osm_matches,
            "in_voa": i in voa_matches,
        }

        # Enrich from OSM.
        if i in osm_matches:
            osm = osm_matches[i]
            pub["osm_id"] = osm["osm_id"]
            if osm.get("polygon"):
                pub["polygon"] = osm["polygon"]
            if osm.get("beer_garden"):
                pub["beer_garden"] = osm["beer_garden"]
            if osm.get("outdoor_seating"):
                pub["outdoor_seating"] = osm["outdoor_seating"]
            if osm.get("opening_hours"):
                pub["opening_hours"] = osm["opening_hours"]
            # Prefer OSM name if FSA name looks like a business code.
            if osm.get("name") and (len(fsa_pub["name"]) <= 3 or fsa_pub["name"].isupper()):
                pub["name"] = osm["name"]

        # Enrich from VOA.
        if i in voa_matches:
            voa = voa_matches[i]
            if voa.get("rateable_value"):
                pub["rateable_value"] = voa["rateable_value"]

        merged.append(pub)

    # Add unmatched OSM pubs (FSA might miss some).
    matched_osm_ids = {osm_matches[i]["osm_id"] for i in osm_matches}
    unmatched_osm = [p for p in osm_pubs if p["osm_id"] not in matched_osm_ids]
    for osm_pub in unmatched_osm:
        pub = {
            "id": osm_pub["osm_id"],
            "name": osm_pub.get("name", "Unnamed pub"),
            "lat": osm_pub["lat"],
            "lng": osm_pub["lng"],
            "postcode": "",
            "in_fsa": False,
            "in_osm": True,
            "in_voa": False,
        }
        if osm_pub.get("polygon"):
            pub["polygon"] = osm_pub["polygon"]
        if osm_pub.get("beer_garden"):
            pub["beer_garden"] = osm_pub["beer_garden"]
        if osm_pub.get("outdoor_seating"):
            pub["outdoor_seating"] = osm_pub["outdoor_seating"]
        if osm_pub.get("opening_hours"):
            pub["opening_hours"] = osm_pub["opening_hours"]
        merged.append(pub)

    # Sort by name.
    merged.sort(key=lambda p: p.get("name", ""))

    # Stats.
    print(f"Merged pub list: {len(merged)} pubs")
    print(f"  From FSA: {sum(1 for p in merged if p['in_fsa'])}")
    print(f"  From OSM only: {sum(1 for p in merged if not p['in_fsa'] and p['in_osm'])}")
    print(f"  With OSM data: {sum(1 for p in merged if p['in_osm'])}")
    print(f"  With VOA data: {sum(1 for p in merged if p['in_voa'])}")
    print(f"  With polygons: {sum(1 for p in merged if 'polygon' in p)}")
    print(f"  With outdoor tags: {sum(1 for p in merged if p.get('outdoor_seating') or p.get('beer_garden'))}")
    print(f"  With opening hours: {sum(1 for p in merged if p.get('opening_hours'))}")

    # Save.
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(merged, f, indent=2)

    size_mb = OUTPUT_PATH.stat().st_size / 1e6
    print(f"\nSaved to {OUTPUT_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
