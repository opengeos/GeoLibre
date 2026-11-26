"""Project constants shared with the TypeScript app, loaded from project-constants.json."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Shared TS/Python constants synced from packages/core/src/project-constants.json.
_PROJECT_CONSTANTS: dict[str, Any] = json.loads(
    Path(__file__).parent.with_name("project-constants.json").read_text(encoding="utf-8")
)
