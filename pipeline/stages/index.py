"""Stage 2: INDEX — build INSPIRE GeoPackage from downloaded GML files.

Calls build_inspire.main() directly (no subprocess).
Change detection is handled by the orchestrator via manifest.
"""

from pipeline.stages.build_inspire import main as build_inspire_main


def run(area) -> dict:
    """Run the INSPIRE indexing. Returns stats dict."""
    print("  Building INSPIRE GeoPackage...", flush=True)
    build_inspire_main()
    return {"status": "completed"}
