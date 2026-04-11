"""Static reference data for UK locality derivation.

The pipeline derives `town`, `country`, and `slug` for each pub from a
combination of:

  1. OSM addr:city / addr:town / addr:village / addr:hamlet / addr:place tags
     (preferred — most accurate, since they describe the pub's actual address)
  2. The local authority of the matched INSPIRE parcel (fallback — useful when
     the LA name happens to match a town like "Norwich City Council" → Norwich)
  3. Geometric defaults (last resort)

This file holds the small static maps needed for steps (2) and the country
classification for (3). It is reference data, not generated code — when local
authorities change (e.g. the 2023 Cumbria reorganisation) this file is the
single source of truth that needs updating.

Sources:
- ONS local authority list (England + Wales)
- London boroughs collapse to "London" because that's how everyone searches
"""


# ── Welsh local authorities ────────────────────────────────────────────────
# 22 principal areas. INSPIRE GML files are named exactly like this with
# underscores instead of spaces. Used by `la_to_country()`.

WELSH_LAS: frozenset[str] = frozenset({
    "Anglesey County Council",
    "Blaenau Gwent County Borough Council",
    "Bridgend County Borough Council",
    "Caerphilly County Borough Council",
    "Cardiff Council",
    "Carmarthenshire County Council",
    "Ceredigion County Council",
    "Conwy County Borough Council",
    "Denbighshire County Council",
    "Flintshire County Council",
    "Gwynedd Council",
    "Isle of Anglesey County Council",  # alternate name
    "Merthyr Tydfil County Borough Council",
    "Monmouthshire County Council",
    "Neath Port Talbot Council",
    "Neath Port Talbot County Borough Council",  # alternate name
    "Newport City Council",
    "Pembrokeshire County Council",
    "Powys County Council",
    "Rhondda Cynon Taf County Borough Council",
    "Swansea Council",
    "City and County of Swansea Council",  # alternate name
    "Torfaen County Borough Council",
    "Vale of Glamorgan Council",
    "The Vale of Glamorgan Council",  # alternate name
    "Wrexham County Borough Council",
})


# ── London boroughs ────────────────────────────────────────────────────────
# All 33 London boroughs collapse to a single "London" town because that's how
# users search. The borough name is preserved in `local_authority` for context.

LONDON_BOROUGHS: frozenset[str] = frozenset({
    "City of London",
    "City of London Corporation",
    "Westminster City Council",
    "Camden London Borough Council",
    "Greenwich London Borough Council",
    "Royal Borough of Greenwich",
    "Hackney London Borough Council",
    "Hammersmith and Fulham London Borough Council",
    "Islington London Borough Council",
    "Kensington and Chelsea Royal Borough Council",
    "Royal Borough of Kensington and Chelsea",
    "Lambeth London Borough Council",
    "Lewisham London Borough Council",
    "Southwark London Borough Council",
    "Tower Hamlets London Borough Council",
    "Wandsworth London Borough Council",
    "Barking and Dagenham London Borough Council",
    "Barnet London Borough Council",
    "Bexley London Borough Council",
    "Brent London Borough Council",
    "Bromley London Borough Council",
    "Croydon London Borough Council",
    "Ealing London Borough Council",
    "Enfield London Borough Council",
    "Haringey London Borough Council",
    "Harrow London Borough Council",
    "Havering London Borough Council",
    "Hillingdon London Borough Council",
    "Hounslow London Borough Council",
    "Kingston upon Thames Royal Borough Council",
    "Royal Borough of Kingston upon Thames",
    "Merton London Borough Council",
    "Newham London Borough Council",
    "Redbridge London Borough Council",
    "Richmond upon Thames London Borough Council",
    "Sutton London Borough Council",
    "Waltham Forest London Borough Council",
})


# Council-name suffixes to strip when guessing a town from an LA name.
# Order matters — longer first so "County Borough Council" is consumed before
# "Borough Council" or "Council".
_LA_SUFFIXES: tuple[str, ...] = (
    " County Borough Council",
    " Metropolitan Borough Council",
    " London Borough Council",
    " Borough Council",
    " District Council",
    " City Council",
    " County Council",
    " Council",
    " Corporation",
)

# Prefixes to strip ("City of Bristol Council" → "Bristol"). Applied after
# suffix stripping.
_LA_PREFIXES: tuple[str, ...] = (
    "City of ",
    "Borough of ",
    "The ",
)


def _load_county_map() -> dict[str, dict]:
    """Load the LA → county mapping from county_map.json."""
    import json
    from pathlib import Path
    path = Path(__file__).resolve().parent.parent.parent / "data" / "county_map.json"
    if path.exists():
        return json.loads(path.read_text())
    return {}


_county_map: dict[str, dict] | None = None


def _get_county_map() -> dict[str, dict]:
    global _county_map
    if _county_map is None:
        _county_map = _load_county_map()
    return _county_map


def la_to_country(local_authority: str | None) -> str:
    """Classify a local authority as England, Wales, or Scotland."""
    if not local_authority:
        return "England"
    if local_authority in WELSH_LAS:
        return "Wales"
    # Check county_map for Scottish (3-letter codes) and any other entries.
    cm = _get_county_map()
    entry = cm.get(local_authority)
    if entry:
        return entry.get("country", "England")
    return "England"


def la_to_county(local_authority: str | None) -> str | None:
    """Look up the county for a local authority. Returns None if not mapped."""
    if not local_authority:
        return None
    cm = _get_county_map()
    entry = cm.get(local_authority)
    if entry:
        return entry.get("county")
    return None


def la_to_town_fallback(local_authority: str | None) -> str | None:
    """Strip the council suffix from an LA name to guess its primary town.

    Used only as a fallback when the pub has no OSM addr:city / addr:town
    tag. Works well for city councils ("Norwich City Council" → "Norwich",
    "Bristol City Council" → "Bristol") but returns None for rural districts
    and ambiguous multi-place names ("Hammersmith and Fulham" → None) so the
    caller can decide whether to skip the pub from landing-page generation.
    """
    if not local_authority:
        return None
    if local_authority in LONDON_BOROUGHS:
        return "London"

    name = local_authority
    for suffix in _LA_SUFFIXES:
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break

    for prefix in _LA_PREFIXES:
        if name.startswith(prefix):
            name = name[len(prefix):]
            break

    name = name.strip()

    # Multi-place names are too ambiguous to use as a town.
    if " and " in name or " & " in name:
        return None

    return name or None
