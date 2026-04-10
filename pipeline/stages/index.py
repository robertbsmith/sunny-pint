"""Stage 2: INDEX — build INSPIRE GeoPackage from downloaded GML files.

Thin wrapper around the existing build_inspire_gpkg.py script.
Change detection is handled by the orchestrator via manifest.
"""

import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"


def run(area) -> dict:
    """Run the INSPIRE indexing. Returns stats dict."""
    script = SCRIPTS_DIR / "build_inspire_gpkg.py"
    if not script.exists():
        raise FileNotFoundError(f"{script} not found")

    print("  Running build_inspire_gpkg.py...", flush=True)
    result = subprocess.run(
        ["uv", "run", "--project", str(SCRIPTS_DIR), "python", str(script)],
        capture_output=True,
        text=True,
    )
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr)
        raise RuntimeError(f"build_inspire_gpkg.py failed: {result.returncode}")

    # Parse stats from output.
    for line in result.stdout.splitlines():
        if "features" in line.lower() and "parcels" not in line.lower():
            pass
    return {"status": "completed"}
