"""Shared area definitions and --area argument parsing for pipeline scripts."""

import argparse
from typing import NamedTuple


class Area(NamedTuple):
    name: str
    bbox: tuple[float, float, float, float] | None  # (south, west, north, east) in WGS84


AREAS: dict[str, Area] = {
    "norwich": Area("Norwich", (52.55, 1.15, 52.70, 1.40)),
    "bristol": Area("Bristol", (51.40, -2.70, 51.50, -2.50)),
    "london": Area("London", (51.35, -0.25, 51.60, 0.10)),
    "edinburgh": Area("Edinburgh", (55.90, -3.30, 55.98, -3.10)),
    "cardiff": Area("Cardiff", (51.45, -3.25, 51.52, -3.10)),
    "uk": Area("UK", None),
}

DEFAULT_AREA = "norwich"


def parse_area_name(name: str) -> Area:
    """Look up an area by name string. Used by the v2 orchestrator."""
    key = name.lower()
    if key not in AREAS:
        raise ValueError(f"Unknown area: {name}. Available: {', '.join(AREAS.keys())}")
    return AREAS[key]


def parse_area() -> Area:
    """Parse --area argument from command line. Returns the selected Area."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--area",
        choices=AREAS.keys(),
        default=DEFAULT_AREA,
        help=f"Area to process (default: {DEFAULT_AREA})",
    )
    args, _ = parser.parse_known_args()
    return AREAS[args.area]


def in_bbox(lat: float, lng: float, bbox: tuple[float, float, float, float] | None) -> bool:
    """Check if a point is within a WGS84 bbox. Returns True if bbox is None (uk-wide)."""
    if bbox is None:
        return True
    south, west, north, east = bbox
    return south <= lat <= north and west <= lng <= east
