"""Pipeline run reports — written after each run for auditing."""

import json
import time
from pathlib import Path
from typing import Any

RUNS_DIR = Path(__file__).resolve().parent.parent / "data" / "pipeline_runs"


class RunReport:
    """Accumulates per-stage results and writes a JSON report at the end."""

    def __init__(self, area: str):
        self.area = area
        self.started_at = time.time()
        self.stages: dict[str, dict[str, Any]] = {}

    def skip(self, stage: str, reason: str) -> None:
        self.stages[stage] = {"status": "skipped", "reason": reason}
        print(f"  [{stage}] SKIP — {reason}")

    def start(self, stage: str) -> None:
        self.stages[stage] = {"status": "running", "started_at": time.time()}
        print(f"\n{'=' * 60}")
        print(f"  [{stage}] RUNNING")
        print(f"{'=' * 60}\n")

    def complete(self, stage: str, stats: dict[str, Any]) -> None:
        entry = self.stages.get(stage, {})
        started = entry.get("started_at", time.time())
        entry.update({
            "status": "completed",
            "duration_s": round(time.time() - started, 1),
            **stats,
        })
        self.stages[stage] = entry
        print(f"\n  [{stage}] DONE in {entry['duration_s']:.0f}s")
        for k, v in stats.items():
            print(f"    {k}: {v}")

    def fail(self, stage: str, error: str) -> None:
        entry = self.stages.get(stage, {})
        started = entry.get("started_at", time.time())
        entry.update({
            "status": "failed",
            "duration_s": round(time.time() - started, 1),
            "error": error,
        })
        self.stages[stage] = entry
        print(f"\n  [{stage}] FAILED: {error}")

    def save(self) -> Path:
        """Write the run report to data/pipeline_runs/."""
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        elapsed = round(time.time() - self.started_at, 1)

        # Build summary line.
        completed = [s for s, d in self.stages.items() if d["status"] == "completed"]
        skipped = [s for s, d in self.stages.items() if d["status"] == "skipped"]
        failed = [s for s, d in self.stages.items() if d["status"] == "failed"]
        parts = []
        if completed:
            parts.append(f"{len(completed)} completed")
        if skipped:
            parts.append(f"{len(skipped)} skipped")
        if failed:
            parts.append(f"{len(failed)} FAILED")
        summary = f"{self.area}: {', '.join(parts)} in {elapsed:.0f}s"

        report = {
            "area": self.area,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started_at)),
            "elapsed_s": elapsed,
            "summary": summary,
            "stages": self.stages,
        }

        ts = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime(self.started_at))
        path = RUNS_DIR / f"{ts}_{self.area}.json"
        path.write_text(json.dumps(report, indent=2, default=str))

        print(f"\n{'=' * 60}")
        print(f"  PIPELINE COMPLETE: {summary}")
        print(f"  Report: {path}")
        print(f"{'=' * 60}")
        return path
