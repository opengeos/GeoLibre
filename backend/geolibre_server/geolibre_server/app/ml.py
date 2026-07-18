"""AI segmentation sidecar endpoints (SamGeo / SAM3).

These endpoints back the GeoLibre segmentation toolbox (issue #301): draw a box,
click points, or type a text prompt on imagery and get GeoJSON polygons back.
The heavy model stack (PyTorch + SAM3) is **not** loaded into this sidecar
process. Instead this module is a thin reverse-proxy in front of the
``segment-geospatial`` REST API (``samgeo.api:app``, the ``samgeo-api`` console
script), which is launched on demand as a child process or reached at an
external URL.

Why proxy instead of importing samgeo here? The sidecar is meant to stay small
and CPU-only; SAM3 needs a multi-gigabyte, GPU-specific Torch build. Keeping it
in its own process (or on a separate GPU host) mirrors how ``conversion`` and
``raster`` push heavy work into a managed runtime.

Configuration (environment variables):

- ``GEOLIBRE_ML_SAMGEO_URL`` — base URL of an already-running ``samgeo-api``
  (e.g. ``http://127.0.0.1:8000``). When set, no child process is launched;
  requests are forwarded here. Use this to run the model server in a GPU env.
- ``GEOLIBRE_ML_SAMGEO_CMD`` — command used to launch ``samgeo-api`` on demand
  (default ``samgeo-api``). ``--host``/``--port`` are appended automatically.
- ``GEOLIBRE_ML_DEFAULT_MODEL`` — model_version the UI should default to
  (default ``sam3``; see issue #301 decision to use SAM3, not SAM2).

All endpoints degrade gracefully: ``GET /ml/status`` reports ``available:
false`` with an actionable message when ``samgeo-api`` (or the ``ml`` extra)
is missing, and the work endpoints return 503.
"""

from __future__ import annotations

import logging
import os
import shlex
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from .runtime import (
    RuntimeBootstrapError,
    _clean_env,
    _subprocess_startup_kwargs,
)

router = APIRouter(prefix="/ml", tags=["ml"])
logger = logging.getLogger("geolibre.ml")

# Default model for the segmentation toolbox. SAM3 covers automatic, box/point,
# and text prompts; SAM2 is intentionally not used (issue #301 decision).
DEFAULT_MODEL = os.environ.get("GEOLIBRE_ML_DEFAULT_MODEL", "sam3")

_EXTERNAL_URL = os.environ.get("GEOLIBRE_ML_SAMGEO_URL")
_LAUNCH_CMD = os.environ.get("GEOLIBRE_ML_SAMGEO_CMD", "samgeo-api")

# How long to wait for a freshly launched samgeo-api to answer /health. The
# server imports FastAPI/numpy at startup but loads models lazily on first
# /segment call, so startup is fast; the budget mainly covers a cold import.
_HEALTH_TIMEOUT_SECS = 60
_PROXY_TIMEOUT_SECS = 1800  # model inference on large rasters can be slow

# Guards the launch-or-reuse decision for the child process.
_child_lock = threading.Lock()
_child: dict = {"proc": None, "url": None}


def _require_httpx():
    """Import httpx lazily so the sidecar runs without the ``ml`` extra.

    Returns:
        The imported ``httpx`` module.

    Raises:
        RuntimeBootstrapError: If httpx is not installed.
    """
    try:
        import httpx  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - exercised via status path
        raise RuntimeBootstrapError(
            "The 'ml' extra is not installed. Install with: pip install geolibre-server[ml]"
        ) from exc
    return httpx


def _free_port() -> int:
    """Return an unused localhost TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _redact_url(url: str) -> str:
    """Strip embedded credentials from a URL before surfacing it to clients.

    A configured ``GEOLIBRE_ML_SAMGEO_URL`` may carry ``user:pass@host``; the
    status payload and error messages are shown in the browser, so credentials
    must not leak there.

    Args:
        url: The URL to sanitise.

    Returns:
        The URL with any userinfo removed, or the original string if it cannot
        be parsed.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    if not (parsed.username or parsed.password):
        return url
    host = parsed.hostname or ""
    netloc = f"{host}:{parsed.port}" if parsed.port else host
    return urllib.parse.urlunsplit(parsed._replace(netloc=netloc))


def _is_healthy(base_url: str, timeout: float = 3.0) -> bool:
    """Return True if a samgeo-api server answers /health at ``base_url``."""
    try:
        httpx = _require_httpx()
        resp = httpx.get(f"{base_url}/health", timeout=timeout)
        return resp.status_code == 200 and resp.json().get("status") == "ok"
    except RuntimeBootstrapError:
        # The `ml` extra (httpx) is missing: report "not reachable" rather than
        # raising, so callers like /ml/status degrade gracefully.
        return False
    except Exception as exc:  # noqa: BLE001 - a probe failure means "not healthy"
        logger.debug("Health check for %s failed: %s", _redact_url(base_url), exc)
        return False


def _launch_command() -> Optional[list[str]]:
    """Resolve the samgeo-api launch command, or None if it is not available."""
    parts = shlex.split(_LAUNCH_CMD)
    if not parts:
        return None
    if shutil.which(parts[0]) is None:
        return None
    return parts


def _ensure_server() -> str:
    """Return the base URL of a ready samgeo-api, launching one if needed.

    Reuses a configured external server (``GEOLIBRE_ML_SAMGEO_URL``) or a
    previously launched child process. Otherwise launches ``samgeo-api`` on a
    free port and waits for it to become healthy.

    Returns:
        The base URL (no trailing slash) of a healthy samgeo-api server.

    Raises:
        RuntimeBootstrapError: If no server can be reached or launched.
    """
    if _EXTERNAL_URL:
        base = _EXTERNAL_URL.rstrip("/")
        if _is_healthy(base):
            return base
        raise RuntimeBootstrapError(
            f"GEOLIBRE_ML_SAMGEO_URL is set to {_redact_url(base)} but no "
            "samgeo-api server answered there."
        )

    # Decide whether to reuse an existing child or launch a new one. The lock is
    # held only for this decision and the Popen call, never for the health-poll
    # below: holding it across the multi-second startup wait would block other
    # thread-pool workers serving concurrent /ml requests (and could starve the
    # pool entirely), since _ensure_server runs via run_in_threadpool.
    with _child_lock:
        proc = _child["proc"]
        url = _child["url"]
        if proc is not None and proc.poll() is None and url:
            # Another request already launched (or is launching) the server;
            # reuse its URL and wait for health below instead of duplicating it.
            launched = proc
        else:
            command = _launch_command()
            if command is None:
                raise RuntimeBootstrapError(
                    "samgeo-api was not found on PATH. Install the segmentation "
                    "stack with: pip install segment-geospatial[api,samgeo3], or set "
                    "GEOLIBRE_ML_SAMGEO_URL to an existing samgeo-api server."
                )

            port = _free_port()
            url = f"http://127.0.0.1:{port}"
            full_cmd = command + ["--host", "127.0.0.1", "--port", str(port)]
            logger.info("Launching samgeo-api: %s", " ".join(full_cmd))
            try:
                launched = subprocess.Popen(  # noqa: S603 - command is operator-configured
                    full_cmd,
                    env=_clean_env(),
                    stdout=subprocess.DEVNULL,
                    # Inherit stderr so samgeo-api startup errors reach the
                    # sidecar's log instead of being discarded.
                    stderr=None,
                    **_subprocess_startup_kwargs(),
                )
            except OSError as exc:
                raise RuntimeBootstrapError(f"Failed to launch samgeo-api: {exc}") from exc
            _child["proc"] = launched
            _child["url"] = url

    deadline = time.monotonic() + _HEALTH_TIMEOUT_SECS
    while time.monotonic() < deadline:
        if launched.poll() is not None:
            _forget_child(launched)
            raise RuntimeBootstrapError(
                "samgeo-api exited during startup. Check that "
                "segment-geospatial[api] is installed in its environment."
            )
        if _is_healthy(url):
            return url
        time.sleep(1.0)

    _terminate_process(launched)
    _forget_child(launched)
    raise RuntimeBootstrapError(
        f"samgeo-api did not become healthy within {_HEALTH_TIMEOUT_SECS}s."
    )


def _terminate_process(proc) -> None:
    """Terminate a child process, escalating to kill if it ignores SIGTERM.

    Args:
        proc: A ``subprocess.Popen`` instance (or None / already-exited).
    """
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception as exc:  # noqa: BLE001 - escalate to kill on any wait failure
        logger.debug("SIGTERM wait failed (%s); escalating to SIGKILL", exc)
        proc.kill()


def _forget_child(proc) -> None:
    """Clear the shared child slot if it still refers to ``proc``.

    Guards against clobbering a newer launch recorded by a concurrent request.

    Args:
        proc: The process whose slot should be released.
    """
    with _child_lock:
        if _child["proc"] is proc:
            _child["proc"] = None
            _child["url"] = None


def stop_child_server() -> None:
    """Terminate a launched samgeo-api child process, if any.

    Called from the sidecar's /shutdown handler so the model server does not
    outlive the sidecar.
    """
    with _child_lock:
        proc = _child["proc"]
        _child["proc"] = None
        _child["url"] = None
    _terminate_process(proc)


@router.get("/status")
def ml_status():
    """Report whether the segmentation backend is available.

    Cheap by design: it never loads models. It probes an external/already
    running server, or reports whether ``samgeo-api`` can be launched on demand.

    Returns:
        A dict with ``available``, a human ``message``, the resolved ``url``
        when known, ``default_model``, and (when a server is reachable) the
        backend ``version`` and available ``models``.
    """
    payload: dict = {"available": False, "default_model": DEFAULT_MODEL}

    # 1) A reachable server (external URL or an already-launched child). Read the
    # child URL under the lock so a concurrent stop_child_server() cannot null
    # it mid-read.
    if _EXTERNAL_URL:
        base = _EXTERNAL_URL.rstrip("/")
    else:
        with _child_lock:
            base = _child.get("url")
    if base and _is_healthy(base):
        try:
            httpx = _require_httpx()
            version = httpx.get(f"{base}/health", timeout=5).json().get("version")
            models = httpx.get(f"{base}/models", timeout=5).json().get("models", {})
        except Exception:  # noqa: BLE001
            version, models = None, {}
        payload.update(
            available=True,
            message="Segmentation backend (samgeo-api) is ready.",
            url=_redact_url(base),
            version=version,
            models=models,
        )
        return payload

    if _EXTERNAL_URL:
        payload["message"] = (
            f"GEOLIBRE_ML_SAMGEO_URL is set to {_redact_url(_EXTERNAL_URL)} but "
            "the server is not responding."
        )
        return payload

    # 2) No server running yet: can we launch one on demand?
    try:
        _require_httpx()
    except RuntimeBootstrapError as exc:
        payload["message"] = str(exc)
        return payload

    if _launch_command() is not None:
        payload.update(
            available=True,
            message="samgeo-api is installed and will start on first use.",
        )
        return payload

    payload["message"] = (
        "Segmentation backend is unavailable. Install it with: "
        "pip install segment-geospatial[api,samgeo3], or set "
        "GEOLIBRE_ML_SAMGEO_URL to an existing samgeo-api server."
    )
    return payload


@router.get("/models")
async def ml_models():
    """Proxy the backend model catalogue (available + loaded models)."""
    return await _forward_get("/models")


async def _forward_get(path: str):
    """Forward a GET request to the segmentation backend."""
    httpx = _require_httpx()
    base = await _resolve_base()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{base}{path}")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"samgeo-api error: {exc}")
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
    )


async def _resolve_base() -> str:
    """Resolve a ready backend URL, mapping bootstrap failures to 503."""
    try:
        return await run_in_threadpool(_ensure_server)
    except RuntimeBootstrapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


async def _forward_segment(request: Request, path: str) -> Response:
    """Transparently forward a multipart segmentation request to samgeo-api.

    Streams the raw request body and content-type through so every form field
    and ``output_format`` supported by samgeo-api works without re-encoding, and
    so a large GeoTIFF upload is never buffered whole in the sidecar's memory.

    Args:
        request: The incoming FastAPI request (multipart/form-data).
        path: The backend path to forward to, e.g. ``/segment/text``.

    Returns:
        The backend response (status, body, content-type) passed straight back.
    """
    httpx = _require_httpx()
    base = await _resolve_base()
    headers = {}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type

    async def _body_iter():
        # Forward the upload chunk-by-chunk so the whole payload never sits in
        # memory at once (uvicorn/httpx negotiate chunked transfer encoding).
        async for chunk in request.stream():
            if chunk:
                yield chunk

    try:
        async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT_SECS) as client:
            resp = await client.post(f"{base}{path}", content=_body_iter(), headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"samgeo-api error: {exc}")
    # The GeoJSON/PNG response is buffered (resp.content); it is bounded and far
    # smaller than the upload. Streaming it back would need client.stream() +
    # StreamingResponse and is left as a follow-up.
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
    )


@router.post("/segment/automatic")
async def segment_automatic(request: Request):
    """Automatic mask generation (proxied to samgeo-api /segment/automatic)."""
    return await _forward_segment(request, "/segment/automatic")


@router.post("/segment/predict")
async def segment_predict(request: Request):
    """Box/point prompt segmentation (proxied to /segment/predict)."""
    return await _forward_segment(request, "/segment/predict")


@router.post("/segment/text")
async def segment_text(request: Request):
    """Text-prompt segmentation (proxied to /segment/text)."""
    return await _forward_segment(request, "/segment/text")
