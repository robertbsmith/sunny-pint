"""Basemap extraction — OSM .pbfs → per-layer GeoJSON near pubs.

Replaces the Mapbox raster basemap. The porthole only ever shows ~74 m
around a pub, so instead of tiling the whole country we keep just the
roads, water, green space, car parks, hedges and trees that fall within
KEEP_RADIUS_M of any pub, clipped to that radius. That is a tiny fraction
of the UK's OSM data and packs into the same PMTiles archive as the
buildings (see stages/tiles.py) — so the SPA gets the basemap for free
in the tile request it already makes for building shadows.

Output: data/basemap/<layer>.geojsonl (newline-delimited GeoJSON,
tippecanoe reads it directly). Layers:

    roads      LineString  c = mw|pri|sec|ter|res|svc|ped|path
    rail       LineString
    waterways  LineString  k = river|canal|stream
    water      Polygon
    land       Polygon     k = green|wood|farm|parking|ped|sand
    lines      LineString  k = hedge|trees|wall
    trees      Point

Rebuilt automatically by the tiles stage when missing or when any .pbf is
newer than the stamp file.
"""

import json
import math
import time
from pathlib import Path

import osmium
from shapely import make_valid
from shapely.affinity import scale, translate
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.strtree import STRtree

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
PBF_PATHS = sorted(DATA_DIR.glob("*-latest.osm.pbf"))
BASEMAP_DIR = DATA_DIR / "basemap"
STAMP_PATH = BASEMAP_DIR / ".stamp"

LAYERS = ("roads", "rail", "waterways", "water", "land", "lines", "trees")

# Everything within this distance of a pub is kept. The porthole radius is
# 74 m and pan is bounded by the garden extent, so 300 m is comfortably
# more than a user can ever scroll to.
KEEP_RADIUS_M = 300

M_PER_DEG_LAT = 111_320.0

# ── Tag classification ────────────────────────────────────────────────────

ROAD_CLASS = {
    "motorway": "mw", "motorway_link": "mw", "trunk": "mw", "trunk_link": "mw",
    "primary": "pri", "primary_link": "pri",
    "secondary": "sec", "secondary_link": "sec",
    "tertiary": "ter", "tertiary_link": "ter",
    "residential": "res", "unclassified": "res", "living_street": "res", "road": "res",
    "service": "svc",
    "pedestrian": "ped",
    "footway": "path", "path": "path", "cycleway": "path", "bridleway": "path",
    "steps": "path", "track": "path",
}

RAIL_TYPES = {"rail", "light_rail", "tram", "narrow_gauge"}

WATERWAY_CLASS = {
    "river": "river", "canal": "canal",
    "stream": "stream", "ditch": "stream", "drain": "stream",
}

LINE_KIND = {
    ("barrier", "hedge"): "hedge",
    ("barrier", "wall"): "wall",
    ("barrier", "city_wall"): "wall",
    ("natural", "tree_row"): "trees",
}

# (key, value) → land kind. Checked in order so the more specific wins.
LAND_KIND = {
    ("amenity", "parking"): "parking",
    ("leisure", "park"): "green",
    ("leisure", "garden"): "green",
    ("leisure", "pitch"): "green",
    ("leisure", "playground"): "green",
    ("leisure", "recreation_ground"): "green",
    ("leisure", "dog_park"): "green",
    ("leisure", "common"): "green",
    ("leisure", "golf_course"): "green",
    ("landuse", "grass"): "green",
    ("landuse", "village_green"): "green",
    ("landuse", "recreation_ground"): "green",
    ("landuse", "cemetery"): "green",
    ("landuse", "allotments"): "green",
    ("landuse", "greenfield"): "green",
    ("natural", "grassland"): "green",
    ("natural", "heath"): "green",
    ("natural", "wetland"): "green",
    ("natural", "wood"): "wood",
    ("natural", "scrub"): "wood",
    ("landuse", "forest"): "wood",
    ("landuse", "farmland"): "farm",
    ("landuse", "meadow"): "farm",
    ("landuse", "farmyard"): "farm",
    ("landuse", "orchard"): "farm",
    ("landuse", "vineyard"): "farm",
    ("natural", "beach"): "sand",
    ("natural", "sand"): "sand",
    ("highway", "pedestrian"): "ped",
    ("place", "square"): "ped",
}

WATER_TAGS = {
    ("natural", "water"),
    ("landuse", "reservoir"),
    ("landuse", "basin"),
    ("waterway", "riverbank"),
    ("waterway", "dock"),
    ("leisure", "swimming_pool"),
}

# Keys the C++ pre-filter lets through to Python. Anything without one of
# these keys is dropped before we ever see it.
INTEREST_KEYS = (
    "highway", "railway", "waterway", "natural", "landuse",
    "leisure", "amenity", "barrier", "place",
)


def _is_tunnel(tags) -> bool:
    t = tags.get("tunnel")
    return t is not None and t != "no"


def classify_way(tags) -> tuple[str, str | None] | None:
    """Classify a (non-area) way. Returns (layer, kind) or None."""
    if tags.get("area") == "yes":
        return None
    if _is_tunnel(tags):
        return None
    hw = tags.get("highway")
    if hw:
        cls = ROAD_CLASS.get(hw)
        return ("roads", cls) if cls else None
    rw = tags.get("railway")
    if rw in RAIL_TYPES:
        return ("rail", None)
    ww = tags.get("waterway")
    if ww:
        cls = WATERWAY_CLASS.get(ww)
        return ("waterways", cls) if cls else None
    for key in ("barrier", "natural"):
        val = tags.get(key)
        if val:
            kind = LINE_KIND.get((key, val))
            if kind:
                return ("lines", kind)
    return None


def classify_area(tags) -> tuple[str, str | None] | None:
    """Classify an area (closed way or multipolygon). Returns (layer, kind) or None."""
    if tags.get("parking") == "underground":
        return None
    # highway=pedestrian only counts as a plaza when explicitly area=yes;
    # a closed pedestrian loop is otherwise just a path.
    if tags.get("highway") == "pedestrian" and tags.get("area") != "yes":
        return None
    for key in ("natural", "landuse", "waterway", "leisure"):
        val = tags.get(key)
        if val and (key, val) in WATER_TAGS:
            return ("water", None)
    for key in ("amenity", "leisure", "landuse", "natural", "highway", "place"):
        val = tags.get(key)
        if val:
            kind = LAND_KIND.get((key, val))
            if kind:
                return ("land", kind)
    return None


# ── Pub proximity index ───────────────────────────────────────────────────


def pub_discs(pubs: list[dict]) -> list[BaseGeometry]:
    """One disc per pub: KEEP_RADIUS_M in metres, expressed in degrees so
    it's a true circle on the ground rather than in lat/lng space."""
    unit = Point(0, 0).buffer(1.0, quad_segs=6)
    discs = []
    for p in pubs:
        lat, lng = p["lat"], p["lng"]
        dlat = KEEP_RADIUS_M / M_PER_DEG_LAT
        dlng = KEEP_RADIUS_M / (M_PER_DEG_LAT * max(math.cos(math.radians(lat)), 0.1))
        disc = scale(unit, xfact=dlng, yfact=dlat, origin=(0, 0))
        discs.append(translate(disc, xoff=lng, yoff=lat))
    return discs


class Clipper:
    """Keeps only geometry within KEEP_RADIUS_M of a pub, clipped to that."""

    def __init__(self, pubs: list[dict]):
        self.discs = pub_discs(pubs)
        self.tree = STRtree(self.discs)

    def clip(self, geom: BaseGeometry) -> BaseGeometry | None:
        if geom.is_empty:
            return None
        idxs = self.tree.query(geom, predicate="intersects")
        if len(idxs) == 0:
            return None
        if len(idxs) == 1:
            disc = self.discs[idxs[0]]
        else:
            disc = unary_union([self.discs[i] for i in idxs])
        out = geom.intersection(disc)
        return None if out.is_empty else out


# ── Extraction ────────────────────────────────────────────────────────────


class LayerWriter:
    def __init__(self, tmp_dir: Path):
        self.files = {name: open(tmp_dir / f"{name}.geojsonl", "w") for name in LAYERS}
        self.counts = dict.fromkeys(LAYERS, 0)

    def write(self, layer: str, geom: BaseGeometry, props: dict) -> None:
        # Explode multi-geometries so tippecanoe gets simple features.
        parts = getattr(geom, "geoms", None)
        for g in parts if parts is not None else (geom,):
            if g.is_empty or g.geom_type == "GeometryCollection":
                continue
            # Intersection can yield stray points/lines from polygon
            # inputs — drop anything whose dimension changed.
            feature = {"type": "Feature", "properties": props, "geometry": g.__geo_interface__}
            self.files[layer].write(json.dumps(feature, separators=(",", ":")) + "\n")
            self.counts[layer] += 1

    def close(self) -> None:
        for f in self.files.values():
            f.close()


def _ring_coords(ring) -> list[tuple[float, float]]:
    return [(n.lon, n.lat) for n in ring]


def extract_pbf(pbf: Path, clipper: Clipper, out: LayerWriter) -> None:
    """Single FileProcessor pass (two reads: area candidates, then objects)."""
    key_filter = osmium.filter.KeyFilter(*INTEREST_KEYS)
    fp = (
        osmium.FileProcessor(str(pbf))
        .with_locations()
        .with_areas(osmium.filter.KeyFilter("natural", "landuse", "leisure", "amenity", "waterway", "place", "highway"))
        .with_filter(key_filter)
    )

    seen = 0
    t0 = time.time()
    for obj in fp:
        seen += 1
        if seen % 500_000 == 0:
            print(f"    {seen:,} objects  {time.time() - t0:.0f}s", flush=True)

        if obj.is_node():
            if obj.tags.get("natural") != "tree":
                continue
            g = clipper.clip(Point(obj.location.lon, obj.location.lat))
            if g is not None:
                out.write("trees", g, {})

        elif obj.is_way():
            cls = classify_way(obj.tags)
            if cls is None:
                continue
            try:
                coords = _ring_coords(obj.nodes)
            except osmium.InvalidLocationError:
                continue
            if len(coords) < 2:
                continue
            g = clipper.clip(LineString(coords))
            if g is None:
                continue
            layer, kind = cls
            props = {"c": kind} if layer == "roads" else ({"k": kind} if kind else {})
            out.write(layer, g, props)

        elif obj.is_area():
            cls = classify_area(obj.tags)
            if cls is None:
                continue
            layer, kind = cls
            props = {"k": kind} if kind else {}
            try:
                for outer in obj.outer_rings():
                    shell = _ring_coords(outer)
                    if len(shell) < 4:
                        continue
                    holes = [_ring_coords(h) for h in obj.inner_rings(outer)]
                    poly = Polygon(shell, [h for h in holes if len(h) >= 4])
                    if not poly.is_valid:
                        poly = make_valid(poly)
                    g = clipper.clip(poly)
                    if g is None:
                        continue
                    # Keep only the polygonal part of a repaired geometry.
                    if g.geom_type == "GeometryCollection":
                        polys = [p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
                        if not polys:
                            continue
                        g = unary_union(polys)
                    out.write(layer, g, props)
            except osmium.InvalidLocationError:
                continue


def _inputs_signature(pubs: list[dict]) -> dict:
    """What the output depends on: the .pbf files and the pub locations."""
    return {
        "pbfs": {p.name: p.stat().st_mtime for p in PBF_PATHS},
        "pubs": len(pubs),
        "pub_sum": round(sum(p["lat"] + p["lng"] for p in pubs), 3),
        "radius_m": KEEP_RADIUS_M,
    }


def is_stale(pubs: list[dict]) -> bool:
    if not STAMP_PATH.exists():
        return True
    try:
        stamp = json.loads(STAMP_PATH.read_text())
    except json.JSONDecodeError:
        return True
    if stamp.get("inputs") != _inputs_signature(pubs):
        return True
    return not all((BASEMAP_DIR / f"{name}.geojsonl").exists() for name in LAYERS)


def build(pubs: list[dict], force: bool = False) -> dict[str, int]:
    """Extract basemap layers near `pubs` from every .pbf. Returns counts."""
    if not PBF_PATHS:
        raise FileNotFoundError(f"No *-latest.osm.pbf files in {DATA_DIR}")
    if not force and not is_stale(pubs):
        print("  Basemap up to date.")
        return {}

    print(f"  Building basemap within {KEEP_RADIUS_M} m of {len(pubs):,} pubs")
    clipper = Clipper(pubs)

    tmp_dir = BASEMAP_DIR.with_name("basemap_tmp")
    if tmp_dir.exists():
        for f in tmp_dir.iterdir():
            f.unlink()
    tmp_dir.mkdir(parents=True, exist_ok=True)

    out = LayerWriter(tmp_dir)
    try:
        for pbf in PBF_PATHS:
            print(f"  Processing {pbf.name}...", flush=True)
            t0 = time.time()
            extract_pbf(pbf, clipper, out)
            print(f"    done in {time.time() - t0:.0f}s", flush=True)
    finally:
        out.close()

    # Swap into place atomically-ish: old dir out, new dir in.
    if BASEMAP_DIR.exists():
        for f in BASEMAP_DIR.iterdir():
            f.unlink()
        BASEMAP_DIR.rmdir()
    tmp_dir.rename(BASEMAP_DIR)
    STAMP_PATH.write_text(
        json.dumps({"inputs": _inputs_signature(pubs), "counts": out.counts}, indent=2) + "\n"
    )

    for layer, n in out.counts.items():
        size = (BASEMAP_DIR / f"{layer}.geojsonl").stat().st_size / 1e6
        print(f"    {layer:10s} {n:>9,} features  {size:6.1f} MB")
    return out.counts


def layer_paths() -> dict[str, Path]:
    return {name: BASEMAP_DIR / f"{name}.geojsonl" for name in LAYERS}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Rebuild even if up to date")
    parser.add_argument(
        "--pubs",
        default=str(DATA_DIR.parent / "public" / "data" / "pubs.json"),
        help="pubs.json to take pub locations from",
    )
    args = parser.parse_args()
    pubs = json.loads(Path(args.pubs).read_text())
    build(pubs, force=args.force)
