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
    assert client.get("/token-check").status_code == 200


def test_token_required_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """With a token set, work endpoints demand it; /health stays exempt."""
    main = _reload_app(monkeypatch, "s3cr3t")
    try:
        client = TestClient(main.app)
        # Health is exempt so the readiness probe keeps working.
        assert client.get("/health").status_code == 200
        # Missing / wrong token is rejected.
        assert client.get("/token-check").status_code == 401
        assert client.get("/token-check", headers={"X-GeoLibre-Token": "nope"}).status_code == 401
        # Correct token via either accepted header passes.
        assert client.get("/token-check", headers={"X-GeoLibre-Token": "s3cr3t"}).status_code == 200
        assert (
            client.get("/token-check", headers={"Authorization": "Bearer s3cr3t"}).status_code
            == 200
        )
        # A non-ASCII token header (raw latin-1 bytes on the wire) must fail auth
        # (401), not crash the byte comparison with a TypeError (500).
        assert (
            client.get("/token-check", headers={"X-GeoLibre-Token": b"t\xe9k\xe9n"}).status_code
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
                "/token-check",
                headers={"Host": "evil.example.com", "X-GeoLibre-Token": "s3cr3t"},
            ).status_code
            == 400
        )
        assert (
            client.get(
                "/token-check",
                headers={"Host": "127.0.0.1:8765", "X-GeoLibre-Token": "s3cr3t"},
            ).status_code
            == 200
        )
    finally:
        _reload_app(monkeypatch, None)


def test_whitebox_path_confined_to_roots(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
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


def test_whitebox_multi_path_check_ignores_mislabeled_kind(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Every path-list member stays confined even when its kind is mislabeled."""
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import WhiteboxRunRequest, _prepare_arguments

    root = tmp_path / "data"
    root.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])
    request = WhiteboxRunRequest(
        tool_id="merge_vectors",
        parameters={"inputs": "a.geojson,/etc/passwd"},
        tool={"params": [{"name": "inputs", "kind": "string"}]},
    )

    with pytest.raises(HTTPException) as excinfo:
        _prepare_arguments(request, [])
    assert excinfo.value.status_code == 403


def test_whitebox_relative_path_confined_by_cwd(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
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


def test_whitebox_relative_path_list_member_through_symlink_is_rejected(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Each member of an all-relative path list is checked against the pinned cwd.

    Whitebox splits a multi-dataset arg on commas, so a safe first member must
    not shield a later member that traverses a symlink out of the root.
    """
    from geolibre_server.app import conversion
    from geolibre_server.app.whitebox import WhiteboxRunRequest, _prepare_arguments

    root = tmp_path / "data"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "escape").symlink_to(outside)
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])

    tool = {"id": "merge_vectors", "params": [{"name": "inputs", "kind": "vector_in"}]}
    request = WhiteboxRunRequest(
        tool_id="merge_vectors",
        parameters={"inputs": "safe.geojson,escape/secret.geojson"},
        tool=tool,
    )
    with pytest.raises(HTTPException) as excinfo:
        _prepare_arguments(request, [])
    assert excinfo.value.status_code == 403

    ok = WhiteboxRunRequest(
        tool_id="merge_vectors",
        parameters={"inputs": "safe.geojson,subdir/other.geojson"},
        tool=tool,
    )
    args, _ = _prepare_arguments(ok, [])
    assert args["inputs"] == "safe.geojson,subdir/other.geojson"

    # A relative member alongside an absolute in-root member is resolved
    # against the pinned root, not the sidecar's own cwd.
    mixed = WhiteboxRunRequest(
        tool_id="merge_vectors",
        parameters={"inputs": f"safe.geojson,{root / 'other.geojson'}"},
        tool=tool,
    )
    args, cwd = _prepare_arguments(mixed, [])
    assert cwd == str(root.resolve())
    assert args["inputs"] == f"safe.geojson,{root / 'other.geojson'}"


def test_whitebox_null_byte_path_is_rejected(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
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


def test_whitebox_tilde_and_relative_output_stay_confined(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Tilde paths are treated as escape-shaped and relative outputs resolve under workdir."""
    from geolibre_server.app import conversion, whitebox

    root = tmp_path / "data"
    root.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text('{"secret": true}', encoding="utf-8")
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])

    tool = {
        "id": "t",
        "params": [{"name": "output", "kind": "vector_out"}],
    }
    tilde_req = whitebox.WhiteboxRunRequest(
        tool_id="t",
        parameters={"output": "~/secret.json"},
        tool=tool,
    )
    with pytest.raises(HTTPException) as excinfo:
        whitebox._prepare_arguments(tilde_req, [])
    assert excinfo.value.status_code == 403

    # Relative output resolves against the pinned working directory, not process cwd,
    # preserving significant whitespace in the filename.
    outputs = whitebox._extract_outputs(
        {}, {"output": " nested/ result.geojson"}, tool, working_directory=str(root.resolve())
    )
    assert outputs["output"]["path"] == str((root / " nested" / " result.geojson").resolve())

    # Tilde-prefixed absolute outputs expand to the user's home directory rather than staying raw.
    tilde_out = whitebox._resolve_output_value("~/result.geojson", str(root.resolve()))
    assert not tilde_out.startswith("~")
    assert tilde_out.endswith("result.geojson")

    # Scalar result keys for tools with no declared _out params pass through untouched.
    scalar_outputs = whitebox._extract_outputs(
        {"message": "done", "count": "42"},
        {},
        {"params": []},
        working_directory=str(root.resolve()),
    )
    assert scalar_outputs == {"message": "done", "count": "42"}

    # Even if a recorded job somehow held an outside path, /output still enforces roots.
    job_id = "test-outside-output"
    now = whitebox._utc_now()
    with whitebox._JOBS_LOCK:
        whitebox._JOBS[job_id] = whitebox.JobState(
            id=job_id,
            status="succeeded",
            tool_id="t",
            created_at=now,
            updated_at=now,
            outputs={"output": {"path": str(outside)}},
        )
    try:
        with pytest.raises(HTTPException) as excinfo:
            whitebox.whitebox_output(str(outside))
        assert excinfo.value.status_code == 403
    finally:
        with whitebox._JOBS_LOCK:
            whitebox._JOBS.pop(job_id, None)


def test_shutdown_endpoint_disabled_in_container_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """GEOLIBRE_DISABLE_SHUTDOWN=1 blocks remote /shutdown requests with 403."""
    monkeypatch.setenv("GEOLIBRE_DISABLE_SHUTDOWN", "1")
    main = _reload_app(monkeypatch, None)
    client = TestClient(main.app)
    assert client.post("/shutdown").status_code == 403


def test_postgis_rejects_local_file_libpq_parameters(monkeypatch: pytest.MonkeyPatch) -> None:
    """File-reading libpq keywords are rejected when GEOLIBRE_POSTGIS_HOSTS is active."""
    from geolibre_server.app.postgis import _validate_postgis_target

    monkeypatch.setenv("GEOLIBRE_POSTGIS_HOSTS", "db.example")
    for key in (
        "passfile",
        "servicefile",
        "sslcert",
        "sslkey",
        "sslkeylogfile",
        "sslrootcert",
        "sslcrl",
        "sslcrldir",
    ):
        with pytest.raises(HTTPException) as excinfo:
            _validate_postgis_target({"host": "db.example", key: "/etc/passwd"})
        assert excinfo.value.status_code == 400


def test_raster_and_vector_confine_before_existence_probe(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Missing paths outside GEOLIBRE_CONVERSION_ROOTS return 403, not 400."""
    from geolibre_server.app import conversion
    from geolibre_server.app.raster import _validate_extra_input
    from geolibre_server.app.vector import _validate_write_path

    root = tmp_path / "data"
    root.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(root.resolve())])
    missing_outside = str(tmp_path / "does-not-exist.geojson")

    with pytest.raises(HTTPException) as raster_exc:
        _validate_extra_input(missing_outside, "Mask")
    assert raster_exc.value.status_code == 403

    with pytest.raises(HTTPException) as vector_exc:
        _validate_write_path(missing_outside)
    assert vector_exc.value.status_code == 403


def test_legacy_placeholder_routes_are_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    """The v0.5 ``GET /algorithms`` and 501 ``POST /run`` stubs were removed."""
    main = _reload_app(monkeypatch, None)
    client = TestClient(main.app)
    assert client.get("/algorithms").status_code == 404
    assert client.post("/run", json={"algorithm_id": "buffer"}).status_code in {404, 405}


def test_app_version_comes_from_the_package_version(monkeypatch: pytest.MonkeyPatch) -> None:
    """The OpenAPI version is the package version, which matches pyproject.toml."""
    import re
    from pathlib import Path

    import geolibre_server

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    # A regex rather than tomllib, which needs Python 3.11 (the sidecar supports 3.10).
    match = re.search(r'^version = "([^"]+)"', pyproject.read_text(encoding="utf-8"), re.M)
    assert match is not None
    declared = match.group(1)
    assert geolibre_server.__version__ == declared
    main = _reload_app(monkeypatch, None)
    assert main.app.version == declared
