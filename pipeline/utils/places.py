"""OS Open Names place lookup for town derivation.

Given a pub's OSGB coordinates, finds the nearest named populated place
(City, Town, Village, Hamlet) from the OS Open Names dataset. Used as a
fallback when the pub lacks OSM addr:city/addr:town tags.

Data source: OS Open Names (free, OGL3). Download ~100MB CSV.
Extracted to data/os_places.json (~6MB, 43k places).
"""

import json
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
PLACES_PATH = DATA_DIR / "os_places.json"

# Priority: prefer larger settlements when equidistant.
TYPE_PRIORITY = {"City": 0, "Town": 1, "Suburban Area": 2, "Village": 3, "Hamlet": 4, "Other Settlement": 5}

# Maximum distance (metres) to consider a place match.
MAX_DIST_M = 5000


class PlaceLookup:
    """Fast nearest-place lookup using a KD-tree."""

    def __init__(self, places_path: Path | None = None):
        path = places_path or PLACES_PATH
        if not path.exists():
            self._available = False
            return

        data = json.loads(path.read_text())
        self._names = [p["name"] for p in data]
        self._types = [p.get("type", "") for p in data]
        self._districts = [p.get("district") for p in data]
        self._counties = [p.get("county") for p in data]
        self._coords = np.array([[p["e"], p["n"]] for p in data], dtype=np.float64)
        self._available = True

        # Build KD-tree.
        from scipy.spatial import cKDTree
        self._tree = cKDTree(self._coords)

    @property
    def available(self) -> bool:
        return self._available

    def nearest(self, easting: float, northing: float) -> dict | None:
        """Find the nearest populated place. Returns {name, type, district, county, dist_m} or None."""
        if not self._available:
            return None

        dist, idx = self._tree.query([easting, northing])
        if dist > MAX_DIST_M:
            return None

        return {
            "name": self._names[idx],
            "type": self._types[idx],
            "district": self._districts[idx],
            "county": self._counties[idx],
            "dist_m": round(dist),
        }

    def nearest_town(self, easting: float, northing: float) -> str | None:
        """Find the nearest place name suitable for use as a 'town'. Returns name or None."""
        if not self._available:
            return None

        # Query several nearest places and pick the best one.
        dists, idxs = self._tree.query([easting, northing], k=5)

        best_name = None
        best_score = float("inf")

        for dist, idx in zip(dists, idxs):
            if dist > MAX_DIST_M:
                break
            ptype = self._types[idx]
            priority = TYPE_PRIORITY.get(ptype, 10)
            # Score: distance + penalty for smaller settlements.
            # A town 2km away beats a hamlet 500m away.
            score = dist + priority * 500
            if score < best_score:
                best_score = score
                best_name = self._names[idx]

        return best_name
