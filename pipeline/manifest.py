"""Pipeline manifest — tracks input hashes and stage completion state.

The manifest lives at data/pipeline_manifest.json and records what each
stage consumed (input file hashes, row counts) and produced. The
orchestrator uses it to decide which stages need re-running.
"""

import hashlib
import json
import time
from pathlib import Path
from typing import Any

MANIFEST_PATH = Path(__file__).resolve().parent.parent / "data" / "pipeline_manifest.json"


def _file_hash(path: Path, quick: bool = True) -> str:
    """Hash a file. If quick=True, use size+mtime (fast but not content-aware).
    If quick=False, use sha256 of first 64KB + last 64KB + size (catches most changes
    without reading the full file, good for multi-GB GeoPackages)."""
    if not path.exists():
        return "missing"
    stat = path.stat()
    if quick:
        return f"mtime:{stat.st_mtime_ns}:size:{stat.st_size}"
    # Content-based: hash head + tail + size.
    h = hashlib.sha256()
    h.update(str(stat.st_size).encode())
    with open(path, "rb") as f:
        h.update(f.read(65536))
        if stat.st_size > 65536:
            f.seek(-65536, 2)
            h.update(f.read(65536))
    return f"sha256:{h.hexdigest()[:16]}"


def load_manifest() -> dict[str, Any]:
    """Load the pipeline manifest, or return empty dict if none exists."""
    if MANIFEST_PATH.exists():
        try:
            return json.loads(MANIFEST_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_manifest(manifest: dict[str, Any]) -> None:
    """Atomically save the manifest."""
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = MANIFEST_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2, default=str))
    tmp.replace(MANIFEST_PATH)


def hash_inputs(paths: list[Path], quick: bool = True) -> dict[str, str]:
    """Hash a list of input files. Returns {filename: hash}."""
    return {p.name: _file_hash(p, quick=quick) for p in paths if p.exists()}


def stage_needs_run(
    manifest: dict[str, Any],
    stage_name: str,
    current_inputs: dict[str, str],
    area_name: str = "",
    expected_outputs: list[Path] | None = None,
) -> tuple[bool, str]:
    """Check if a stage needs to run by comparing current input hashes
    against the manifest's recorded inputs, AND verifying that every
    expected output file still exists on disk.

    The manifest is keyed by stage:area so different areas don't skip
    each other (e.g., running Norwich doesn't cause Edinburgh to skip).

    Returns (needs_run, reason).
    """
    key = f"{stage_name}:{area_name}" if area_name else stage_name
    prev = manifest.get(key, {})
    if not prev:
        return True, "never run"
    # Before trusting the "inputs unchanged" shortcut, check the outputs
    # actually exist. An accidental `rm` in public/data/ otherwise leaves
    # the manifest saying "done" while the downstream stage finds nothing.
    if expected_outputs:
        missing = [p for p in expected_outputs if not p.exists()]
        if missing:
            return True, f"outputs missing: {', '.join(p.name for p in missing)}"
    prev_inputs = prev.get("inputs", {})
    if current_inputs != prev_inputs:
        changed = set(current_inputs.keys()) ^ set(prev_inputs.keys())
        for k in current_inputs:
            if current_inputs.get(k) != prev_inputs.get(k):
                changed.add(k)
        return True, f"inputs changed: {', '.join(sorted(changed))}"
    return False, "inputs unchanged"


def record_stage(
    manifest: dict[str, Any],
    stage_name: str,
    inputs: dict[str, str],
    outputs: dict[str, Any],
    duration_s: float,
    area_name: str = "",
) -> None:
    """Record a completed stage in the manifest."""
    key = f"{stage_name}:{area_name}" if area_name else stage_name
    manifest[key] = {
        "inputs": inputs,
        "outputs": outputs,
        "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "duration_s": round(duration_s, 1),
    }
    save_manifest(manifest)
