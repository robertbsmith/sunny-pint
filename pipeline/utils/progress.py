"""Shared progress tracking utilities."""

import json
import time
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"


def write_progress(name: str, state: dict[str, Any]) -> None:
    """Atomically write a progress JSON file to data/{name}_progress.json."""
    path = DATA_DIR / f"{name}_progress.json"
    try:
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2, default=str))
        tmp.replace(path)
    except Exception:
        pass


def eta_str(done: int, total: int, started: float) -> str:
    """Human-readable ETA string."""
    elapsed = time.time() - started
    if done == 0:
        return "ETA --"
    rate = done / elapsed
    remaining = (total - done) / rate if rate else 0
    if remaining < 90:
        return f"ETA {remaining:.0f}s"
    if remaining < 5400:
        return f"ETA {remaining / 60:.0f}min"
    return f"ETA {remaining / 3600:.1f}h"
