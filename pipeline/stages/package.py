"""Stage 4: PACKAGE — generate PMTiles + assemble public pubs.json.

Reads buildings.gpkg + pubs_enriched.json, outputs:
  - public/data/buildings.pmtiles (via tippecanoe)
  - public/data/pubs.json (stripped for public consumption)
"""

import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"


def run(area) -> dict:
    """Run tile generation. Returns stats dict."""
    script = SCRIPTS_DIR / "generate_tiles.py"

    print("  Running generate_tiles.py...", flush=True)
    result = subprocess.run(
        ["uv", "run", "--project", str(SCRIPTS_DIR), "python", str(script),
         "--area", area.name.lower()],
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"generate_tiles.py failed: {result.returncode}")

    return {"status": "completed"}
