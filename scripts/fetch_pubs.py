"""Fetch all pubs in Norwich from OpenStreetMap via Overpass API."""

import json
import urllib.request
import urllib.parse
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

QUERY = """
[out:json][timeout:60];
area["name"="Norwich"]["boundary"="administrative"]["admin_level"~"8|10"]->.norwich;
(
  nwr["amenity"="pub"](area.norwich);
);
out body geom;
"""

OUT = Path(__file__).resolve().parent.parent / "data" / "pubs.json"


def fetch():
    print("Querying Overpass API for Norwich pubs...")
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data)
    req.add_header("User-Agent", "SunPub/0.1 (beer-garden-sun-tracker)")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def parse(raw):
    pubs = []
    for el in raw["elements"]:
        tags = el.get("tags", {})
        pub = {
            "id": f"{el['type']}_{el['id']}",
            "name": tags.get("name", "Unnamed pub"),
            "beer_garden": tags.get("beer_garden") == "yes",
            "outdoor_seating": tags.get("outdoor_seating") == "yes",
            "polygon": None,
            "lat": None,
            "lng": None,
        }

        if el["type"] == "node":
            pub["lat"] = el["lat"]
            pub["lng"] = el["lon"]

        elif el["type"] == "way" and "geometry" in el:
            coords = [[p["lat"], p["lon"]] for p in el["geometry"]]
            pub["polygon"] = coords
            pub["lat"] = sum(c[0] for c in coords) / len(coords)
            pub["lng"] = sum(c[1] for c in coords) / len(coords)

        elif el["type"] == "relation":
            # Use member geometry if available, otherwise bounds.
            if "bounds" in el:
                b = el["bounds"]
                pub["lat"] = (b["minlat"] + b["maxlat"]) / 2
                pub["lng"] = (b["minlon"] + b["maxlon"]) / 2
            # Try to extract outer polygon from members.
            if "members" in el:
                for m in el["members"]:
                    if m.get("role") == "outer" and "geometry" in m:
                        coords = [[p["lat"], p["lon"]] for p in m["geometry"]]
                        pub["polygon"] = coords
                        pub["lat"] = sum(c[0] for c in coords) / len(coords)
                        pub["lng"] = sum(c[1] for c in coords) / len(coords)
                        break

        if pub["lat"] is not None:
            pubs.append(pub)

    return pubs


def main():
    raw = fetch()
    pubs = parse(raw)
    pubs.sort(key=lambda p: p["name"])

    with_garden = sum(1 for p in pubs if p["beer_garden"] or p["outdoor_seating"])
    with_poly = sum(1 for p in pubs if p["polygon"])

    print(f"Found {len(pubs)} pubs in Norwich")
    print(f"  {with_garden} tagged with beer garden or outdoor seating")
    print(f"  {with_poly} with building polygons")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(pubs, indent=2))
    print(f"Saved to {OUT}")


if __name__ == "__main__":
    main()
