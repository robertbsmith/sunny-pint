"""Pipeline v2 orchestrator.

Usage:
    uv run python pipeline/run.py --area uk
    uv run python pipeline/run.py --area uk --stage enrich,package
    uv run python pipeline/run.py --area uk --force
    uv run python pipeline/run.py --area uk --dry-run
"""

import argparse
import sys
import time
from pathlib import Path

# Add scripts/ to path so we can import areas.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from areas import parse_area_name, Area
from pipeline.manifest import (
    hash_inputs,
    load_manifest,
    record_stage,
    save_manifest,
    stage_needs_run,
)
from pipeline.report import RunReport

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public" / "data"

# All available stages in execution order.
STAGES = ["extract", "index", "enrich", "package", "score"]


def get_stage_inputs(stage: str) -> list[Path]:
    """Return the input file paths that a stage depends on."""
    if stage == "extract":
        return sorted(DATA_DIR.glob("*-latest.osm.pbf"))
    if stage == "index":
        gmls = sorted((DATA_DIR / "inspire").glob("*.gml"))
        return gmls[:5] + gmls[-5:]  # sample for quick hash
    if stage == "enrich":
        # Accept v1 (pubs_merged.json) or v2 (pubs_extracted.json).
        pubs_file = DATA_DIR / "pubs_extracted.json"
        if not pubs_file.exists():
            pubs_file = DATA_DIR / "pubs_merged.json"
        return [
            pubs_file,
            DATA_DIR / "buildings.gpkg",
            DATA_DIR / "inspire.gpkg",
        ]
    if stage == "package":
        return [
            DATA_DIR / "pubs_enriched.json",
            DATA_DIR / "buildings.gpkg",
        ]
    if stage == "score":
        return [
            PUBLIC_DIR / "pubs.json",
            PUBLIC_DIR / "buildings.pmtiles",
        ]
    return []


def run_stage(stage: str, area: Area, manifest: dict, report: RunReport, force: bool) -> bool:
    """Run a single stage if needed. Returns True if it ran."""
    inputs = hash_inputs(get_stage_inputs(stage))
    needs_run, reason = stage_needs_run(manifest, stage, inputs, area.name)

    if not needs_run and not force:
        report.skip(stage, reason)
        return False

    report.start(stage)
    t0 = time.time()
    try:
        if stage == "extract":
            from pipeline.stages.extract import run
            stats = run(area)
        elif stage == "index":
            from pipeline.stages.index import run
            stats = run(area)
        elif stage == "enrich":
            from pipeline.stages.enrich import run
            stats = run(area)
        elif stage == "package":
            from pipeline.stages.package import run
            stats = run(area)
        elif stage == "score":
            from pipeline.stages.score import run
            stats = run(area)
        else:
            raise ValueError(f"Unknown stage: {stage}")

        duration = time.time() - t0
        record_stage(manifest, stage, inputs, stats, duration, area.name)
        report.complete(stage, stats)
        return True

    except Exception as exc:
        report.fail(stage, str(exc))
        raise


def main():
    parser = argparse.ArgumentParser(description="Sunny Pint pipeline v2")
    parser.add_argument("--area", default="norwich", help="Area to process")
    parser.add_argument("--stage", help="Comma-separated stages to run (default: all)")
    parser.add_argument("--force", action="store_true", help="Ignore manifest, re-run everything")
    parser.add_argument("--dry-run", action="store_true", help="Show what would run")
    args = parser.parse_args()

    area = parse_area_name(args.area)
    stages = args.stage.split(",") if args.stage else STAGES
    manifest = load_manifest()
    report = RunReport(area.name)

    print(f"Pipeline v2 — area: {area.name}")
    print(f"  Stages: {', '.join(stages)}")
    print(f"  Force: {args.force}")
    print()

    # Auto-download data sources if needed.
    if not args.dry_run:
        from pipeline.utils.download import ensure_data_sources
        ensure_data_sources(args.area)

    if args.dry_run:
        for stage in stages:
            inputs = hash_inputs(get_stage_inputs(stage))
            needs_run, reason = stage_needs_run(manifest, stage, inputs)
            flag = "RUN" if needs_run or args.force else "SKIP"
            print(f"  [{stage}] {flag} — {reason}")
        return

    for stage in stages:
        if stage not in STAGES:
            print(f"  Unknown stage: {stage}")
            continue
        run_stage(stage, area, manifest, report, args.force)

    report.save()


if __name__ == "__main__":
    main()
