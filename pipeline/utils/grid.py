"""OS National Grid label encoding/decoding."""

from pyproj import Transformer

to_osgb = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
to_wgs = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def _letter_to_pos(c: str) -> tuple[int, int]:
    """Returns (col, row) for an OS grid letter, with row 0 = bottom."""
    idx = ord(c.upper()) - ord("A")
    if idx > 7:
        idx -= 1
    return idx % 5, 4 - idx // 5


def label_to_bbox(label: str) -> tuple[int, int, int, int] | None:
    """Decode '   TG10nw' → OSGB (e_min, n_min, e_max, n_max)."""
    if len(label) != 6:
        return None
    try:
        c1, r1 = _letter_to_pos(label[0])
        c2, r2 = _letter_to_pos(label[1])
        digit_e = int(label[2])
        digit_n = int(label[3])
    except (ValueError, IndexError):
        return None
    quarter = label[4:6].lower()
    if quarter not in ("nw", "ne", "sw", "se"):
        return None
    e500 = (c1 - 2) * 500000
    n500 = (r1 - 1) * 500000
    e100 = c2 * 100000
    n100 = r2 * 100000
    e_min = e500 + e100 + digit_e * 10000 + (5000 if "e" in quarter else 0)
    n_min = n500 + n100 + digit_n * 10000 + (5000 if "n" in quarter else 0)
    return e_min, n_min, e_min + 5000, n_min + 5000


def osgb_cell_to_geojson(e: int, n: int, size_m: int = 10000) -> dict:
    """Convert an OSGB cell (bottom-left + size) to a WGS84 GeoJSON polygon."""
    corners = [
        (e, n),
        (e + size_m, n),
        (e + size_m, n + size_m),
        (e, n + size_m),
        (e, n),
    ]
    coords = [list(to_wgs.transform(x, y)) for x, y in corners]
    return {"type": "Polygon", "coordinates": [coords]}


def pub_search_cells(
    pubs: list[dict],
    cell_size_m: int = 10000,
    buf_m: int = 500,
) -> list[tuple[int, int]]:
    """Group pubs into OSGB cells for catalogue search queries."""
    cells: set[tuple[int, int]] = set()
    for p in pubs:
        e, n = to_osgb.transform(p["lng"], p["lat"])
        for dx in (-buf_m, 0, buf_m):
            for dy in (-buf_m, 0, buf_m):
                cells.add((
                    int((e + dx) // cell_size_m) * cell_size_m,
                    int((n + dy) // cell_size_m) * cell_size_m,
                ))
    return sorted(cells)
