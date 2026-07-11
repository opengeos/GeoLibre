"""Security tests for the sidecar: auth token, Host validation, path sandbox."""

from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient


def _reload_app(monkeypatch: pytest.MonkeyPatch, token: str | None):
    """Reload the FastAPI app module with GEOLIBRE_SIDECAR_TOKEN set or unset.

    Args:
        monkeypatch: Pytest monkeypatch fixture.
        token: Token to place in the environment, or None to unset it.

    Returns:
        The freshly reloaded ``geolibre_server.app.main`` module.
    """
    if token is None:
        monkeypatch.delenv("GEOLIBRE_SIDECAR_TOKEN", raising=False)
    else:
        monkeypatch.setenv("GEOLIBRE_SIDECAR_TOKEN", token)
    import geolibre_server.app.main as main

    return importlib.reload(main)


def test_no_token_env_leaves_endpoints_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without GEOLIBRE_SIDECAR_TOKEN, requests are not challenged (dev/tests)."""
    main = _reload_app(monkeypatch, None)
    client = TestClient(main.app)
    assert client.get("/health").status_code == 200
    assert client.get("/algorithms").status_code == 200


def test_token_required_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """With a token set, work endpoints demand it; /health stays exempt."""
    main = _reload_app(monkeypatch, "s3cr3t")
    try:
        client = TestClient(main.app)
        # Health is exempt so the readiness probe keeps working.
        assert client.get("/health").status_code == 200
        # Missing / wrong token is rejected.
        assert client.get("/algorithms").status_code == 401
        assert (
            client.get("/algorithms", headers={"X-GeoLibre-Token": "nope"}).status_code
            == 401
        )
        # Correct token via either accepted header passes.
        assert (
            client.get(
                "/algorithms", headers={"X-GeoLibre-Token": "s3cr3t"}
            ).status_code
            == 200
        )
        assert (
            client.get(
                "/algorithms", headers={"Authorization": "Bearer s3cr3t"}
            ).status_code
            == 200
        )
        # A non-ASCII token header (raw latin-1 bytes on the wire) must fail auth
        # (401), not crash the byte comparison with a TypeError (500).
        assert (
            client.get(
                "/algorithms", headers={"X-GeoLibre-Token": b"t\xe9k\xe9n"}
            ).status_code
            == 401
        )
    finally:
        _reload_app(monkeypatch, None)


def test_untrusted_host_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-loopback Host header is rejected (DNS-rebinding defense)."""
    main = _reload_app(monkeypatch, "s3cr3t")
    try:
        client = TestClient(main.app)
        assert (
            client.get(
                "/algorithms",
                headers={"Host": "evil.example.com", "X-GeoLibre-Token": "s3cr3t"},
            ).status_code
            == 400
        )
        assert (
            client.get(
                "/algorithms",
                headers={"Host": "127.0.0.1:8765", "X-GeoLibre-Token": "s3cr3t"},
            ).status_code
            == 200
        )
    finally:
        _reload_app(monkeypatch, None)


def test_whitebox_path_confined_to_roots(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Whitebox input/output paths outside the allowlisted roots are rejected."""
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import (
        WhiteboxRunRequest,
        _prepare_arguments,
    )

    # Configure a single allowlisted root (mirrors the Docker GEOLIBRE_CONVERSION_ROOTS).
    root = tmp_path / "data"
    root.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])

    tool = {
        "id": "some_raster_tool",
        "params": [
            {"name": "input", "kind": "raster_in"},
            {"name": "output", "kind": "raster_out"},
        ],
    }

    # An input path escaping the roots is refused.
    outside = WhiteboxRunRequest(
        tool_id="some_raster_tool",
        parameters={"input": "/etc/passwd", "output": str(root / "out.tif")},
        tool=tool,
    )
    with pytest.raises(HTTPException) as excinfo:
        _prepare_arguments(outside, [])
    assert excinfo.value.status_code == 403

    # An output path escaping the roots is refused.
    bad_output = WhiteboxRunRequest(
        tool_id="some_raster_tool",
        parameters={
            "input": str(root / "in.tif"),
            "output": "/usr/share/nginx/html/x.tif",
        },
        tool=tool,
    )
    with pytest.raises(HTTPException) as excinfo:
        _prepare_arguments(bad_output, [])
    assert excinfo.value.status_code == 403

    # Paths inside the roots are accepted.
    ok = WhiteboxRunRequest(
        tool_id="some_raster_tool",
        parameters={"input": str(root / "in.tif"), "output": str(root / "out.tif")},
        tool=tool,
    )
    args, _ = _prepare_arguments(ok, [])
    assert args["input"] == str(root / "in.tif")
    assert args["output"] == str(root / "out.tif")


def test_whitebox_path_check_ignores_mislabeled_kind(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """A path smuggled under a non-path ``kind`` is still confined to the roots.

    ``request.tool`` is untrusted free-form input, so a caller can mislabel a
    file parameter's ``kind`` (e.g. ``"string"``) to try to skip the sandbox.
    The check keys off the value shape, so it still fires.
    """
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import (
        WhiteboxRunRequest,
        _prepare_arguments,
    )

    root = tmp_path / "data"
    root.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])

    # Mislabel the real path parameter as a plain "string" kind.
    tool = {
        "id": "some_raster_tool",
        "params": [{"name": "input", "kind": "string"}],
    }
    for escaping in ("/etc/passwd", "../../etc/passwd"):
        request = WhiteboxRunRequest(
            tool_id="some_raster_tool",
            parameters={"input": escaping},
            tool=tool,
        )
        with pytest.raises(HTTPException) as excinfo:
            _prepare_arguments(request, [])
        assert excinfo.value.status_code == 403

    # A non-path scalar string is not mistaken for a path.
    request = WhiteboxRunRequest(
        tool_id="some_raster_tool",
        parameters={"input": "EPSG:4326"},
        tool=tool,
    )
    args, _ = _prepare_arguments(request, [])
    assert args["input"] == "EPSG:4326"


def test_whitebox_relative_path_confined_by_cwd(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """A relative path arg is confined by pinning the subprocess cwd to a root.

    A bare filename like ``pwned.tif`` is not "escape-shaped", so it isn't
    rejected — instead the run's working directory is pinned to an allowlisted
    root so Whitebox resolves it inside the sandbox rather than the sidecar's cwd.
    """
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import (
        WhiteboxRunRequest,
        _prepare_arguments,
    )

    root = tmp_path / "data"
    root.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])

    tool = {"id": "t", "params": [{"name": "output", "kind": "raster_out"}]}
    request = WhiteboxRunRequest(
        tool_id="t",
        parameters={"output": "pwned.tif"},
        tool=tool,
    )
    args, working_directory = _prepare_arguments(request, [])
    assert args["output"] == "pwned.tif"
    assert working_directory == str(root.resolve())


def test_whitebox_cwd_pins_to_root_of_absolute_input(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """With multiple roots, the cwd pins to the root holding an absolute arg."""
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import (
        WhiteboxRunRequest,
        _prepare_arguments,
    )

    root0 = tmp_path / "data"
    root0.mkdir()
    root1 = tmp_path / "scratch"
    root1.mkdir()
    monkeypatch.setattr(
        conversion,
        "_CONVERSION_ROOTS",
        [str(root0.resolve()), str(root1.resolve())],
    )

    tool = {
        "id": "t",
        "params": [
            {"name": "input", "kind": "raster_in"},
            {"name": "output", "kind": "raster_out"},
        ],
    }
    # Absolute input under the *second* root; relative output should resolve
    # there too, so the cwd is pinned to root1 rather than root0.
    request = WhiteboxRunRequest(
        tool_id="t",
        parameters={"input": str(root1 / "dem.tif"), "output": "out.tif"},
        tool=tool,
    )
    _, working_directory = _prepare_arguments(request, [])
    assert working_directory == str(root1.resolve())


def test_whitebox_relative_path_through_symlink_is_rejected(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """A relative arg traversing a symlink that escapes the root is rejected."""
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import (
        WhiteboxRunRequest,
        _prepare_arguments,
    )

    root = tmp_path / "data"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    # A symlink inside the root pointing outside it.
    (root / "escape").symlink_to(outside)
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])

    tool = {"id": "t", "params": [{"name": "output", "kind": "raster_out"}]}
    request = WhiteboxRunRequest(
        tool_id="t",
        parameters={"output": "escape/secret.tif"},
        tool=tool,
    )
    with pytest.raises(HTTPException) as excinfo:
        _prepare_arguments(request, [])
    assert excinfo.value.status_code == 403

    # A relative path staying inside the root is accepted.
    ok = WhiteboxRunRequest(
        tool_id="t",
        parameters={"output": "subdir/out.tif"},
        tool=tool,
    )
    args, _ = _prepare_arguments(ok, [])
    assert args["output"] == "subdir/out.tif"


def test_whitebox_null_byte_path_is_rejected(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """An embedded NUL byte yields a clean 403, not an uncaught 500."""
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import (
        WhiteboxRunRequest,
        _prepare_arguments,
    )

    root = tmp_path / "data"
    root.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])

    tool = {"id": "t", "params": [{"name": "input", "kind": "raster_in"}]}
    request = WhiteboxRunRequest(
        tool_id="t",
        parameters={"input": "/data/x\x00y.tif"},
        tool=tool,
    )
    with pytest.raises(HTTPException) as excinfo:
        _prepare_arguments(request, [])
    assert excinfo.value.status_code == 403


def test_whitebox_paths_unconfined_without_roots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no allowlist (desktop default), any path is accepted."""
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import (
        WhiteboxRunRequest,
        _prepare_arguments,
    )

    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [])
    tool = {
        "id": "some_raster_tool",
        "params": [{"name": "input", "kind": "raster_in"}],
    }
    request = WhiteboxRunRequest(
        tool_id="some_raster_tool",
        parameters={"input": "/anywhere/on/disk.tif"},
        tool=tool,
    )
    args, _ = _prepare_arguments(request, [])
    assert args["input"] == "/anywhere/on/disk.tif"
