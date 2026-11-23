"""Subprocess worker for invoking WhiteboxWorkflows catalog and tool streaming."""

from __future__ import annotations

import base64
import json
import sys
import traceback
from typing import Any


def _make_session(wbw: Any, include_pro: bool, tier: str) -> Any:
    if hasattr(wbw, "RuntimeSession"):
        return wbw.RuntimeSession(include_pro=include_pro, tier=tier)
    return None


def _configure_stdout() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def run_invoke(payload: dict[str, Any]) -> None:
    """Execute a synchronous JSON method (capabilities, catalog, or metadata)."""
    import whitebox_workflows as wbw

    include_pro = bool(payload.get("include_pro", False))
    tier = str(payload.get("tier", "open"))
    method = payload.get("method")
    if hasattr(wbw, "RuntimeSession"):
        session = _make_session(wbw, include_pro, tier)
        if method == "capabilities":
            out = session.get_runtime_capabilities_json()
        elif method == "catalog":
            out = session.list_tool_catalog_json()
        elif method == "metadata":
            out = session.get_tool_metadata_json(str(payload.get("tool_id", "")))
        else:
            raise RuntimeError("unknown method")
    else:
        if method == "capabilities":
            out = wbw.get_runtime_capabilities_json_with_options(include_pro, tier)
        elif method == "catalog":
            out = wbw.list_tool_catalog_json_with_options(include_pro, tier)
        elif method == "metadata":
            out = wbw.get_tool_metadata_json_with_options(
                str(payload.get("tool_id", "")), include_pro, tier
            )
        else:
            raise RuntimeError("unknown method")
    sys.stdout.write(out if isinstance(out, str) else json.dumps(out))


def run_stream(payload: dict[str, Any]) -> None:
    """Execute a Whitebox tool and emit base64-encoded progress/result frames."""
    import whitebox_workflows as wbw

    def emit(evt: Any) -> None:
        txt = evt if isinstance(evt, str) else json.dumps(evt)
        sys.stdout.write("__WBW_EVENT__" + base64.b64encode(txt.encode()).decode() + "\n")
        sys.stdout.flush()

    include_pro = bool(payload.get("include_pro", False))
    tier = str(payload.get("tier", "open"))
    tool_id = str(payload.get("tool_id", ""))
    args_json = str(payload.get("args_json", "{}"))
    try:
        if hasattr(wbw, "RuntimeSession"):
            session = _make_session(wbw, include_pro, tier)
            method = getattr(session, "run_tool_json_stream", None)
            if callable(method):
                out = method(tool_id, args_json, emit)
            else:
                out = session.run_tool_json_with_progress(tool_id, args_json)
        elif hasattr(wbw, "run_tool_json_stream_options"):
            out = wbw.run_tool_json_stream_options(tool_id, args_json, emit, include_pro, tier)
        else:
            out = wbw.run_tool_json_with_progress_options(tool_id, args_json, include_pro, tier)
        txt = out if isinstance(out, str) else json.dumps(out)
        sys.stdout.write("__WBW_RESULT__" + base64.b64encode(txt.encode()).decode() + "\n")
    except Exception:
        sys.stdout.write(
            "__WBW_ERROR__" + base64.b64encode(traceback.format_exc().encode()).decode() + "\n"
        )


def main() -> None:
    _configure_stdout()
    mode = sys.argv[1]
    payload = json.loads(sys.argv[2])
    if mode == "invoke":
        run_invoke(payload)
    elif mode == "stream":
        run_stream(payload)
    else:
        raise RuntimeError(f"Unknown whitebox_runner mode: {mode}")


if __name__ == "__main__":
    main()
