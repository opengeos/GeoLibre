from pathlib import Path

import pytest

from geolibre_server.app.whitebox import (
    WhiteboxRunRequest,
    _is_batch_directory_input,
    _prepare_arguments,
)

_BATCH_DESCRIPTION = (
    "Input LiDAR path or typed LiDAR object. If omitted, runs "
    "in batch mode over LiDAR files in current directory."
)


def _lidar_input_param(name: str, description: str = _BATCH_DESCRIPTION) -> dict:
    """Return minimal LiDAR input parameter metadata.

    Args:
        name: Parameter name.
        description: Catalog description controlling batch detection.

    Returns:
        Normalized Whitebox parameter metadata for a LiDAR input.
    """
    return {
        "data_kind": "lidar",
        "description": description,
        "io_role": "input",
        "kind": "lidar_in",
        "name": name,
        "required": False,
    }


def _classify_lidar_tool() -> dict:
    """Return minimal Classify LiDAR metadata for argument tests.

    Returns:
        Tool metadata with one batch-capable LiDAR input and one LiDAR output.
    """
    return {
        "id": "classify_lidar",
        "params": [
            _lidar_input_param("input"),
            {
                "data_kind": "lidar",
                "description": "Optional output LiDAR path.",
                "io_role": "output",
                "kind": "lidar_out",
                "name": "output",
                "required": False,
            },
        ],
    }


def test_prepare_arguments_uses_lidar_directory_as_batch_workdir(
    tmp_path: Path,
) -> None:
    """Verify directory LiDAR inputs trigger Whitebox batch mode.

    Args:
        tmp_path: Pytest temporary directory fixture.
    """
    request = WhiteboxRunRequest(
        tool_id="classify_lidar",
        parameters={"input": str(tmp_path), "output": ""},
        tool=_classify_lidar_tool(),
    )

    args, working_directory = _prepare_arguments(request, [])

    # The empty output value coerces away and batch mode suppresses the
    # default output path, so args carries no "output" key either.
    assert args == {}
    assert working_directory == str(tmp_path.resolve())


def test_prepare_arguments_keeps_lidar_file_input(tmp_path: Path) -> None:
    """Verify file LiDAR inputs keep the normal JSON input argument.

    Args:
        tmp_path: Pytest temporary directory fixture.
    """
    lidar_path = tmp_path / "sample.las"
    lidar_path.touch()
    request = WhiteboxRunRequest(
        tool_id="classify_lidar",
        parameters={"input": str(lidar_path), "output": ""},
        tool=_classify_lidar_tool(),
    )

    args, working_directory = _prepare_arguments(request, [])

    assert args["input"] == str(lidar_path)
    assert args["output"].endswith(".laz")
    assert working_directory is None


def test_prepare_arguments_keeps_missing_path_as_input(tmp_path: Path) -> None:
    """Verify nonexistent paths fall through to normal argument handling.

    Args:
        tmp_path: Pytest temporary directory fixture.
    """
    missing = tmp_path / "missing.las"
    request = WhiteboxRunRequest(
        tool_id="classify_lidar",
        parameters={"input": str(missing), "output": ""},
        tool=_classify_lidar_tool(),
    )

    args, working_directory = _prepare_arguments(request, [])

    assert args["input"] == str(missing)
    assert working_directory is None


def test_prepare_arguments_rejects_relative_batch_directory() -> None:
    """Verify relative directory values do not trigger batch mode."""
    request = WhiteboxRunRequest(
        tool_id="classify_lidar",
        parameters={"input": ".", "output": ""},
        tool=_classify_lidar_tool(),
    )

    args, working_directory = _prepare_arguments(request, [])

    assert args["input"] == "."
    assert working_directory is None


def test_prepare_arguments_rejects_conflicting_batch_directories(
    tmp_path: Path,
) -> None:
    """Verify two different batch directories raise a ValueError.

    Args:
        tmp_path: Pytest temporary directory fixture.
    """
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    tool = {
        "id": "classify_lidar",
        "params": [_lidar_input_param("input"), _lidar_input_param("polygons")],
    }
    request = WhiteboxRunRequest(
        tool_id="classify_lidar",
        parameters={"input": str(first), "polygons": str(second)},
        tool=tool,
    )

    with pytest.raises(ValueError, match="batch input directory"):
        _prepare_arguments(request, [])


def test_prepare_arguments_accepts_equivalent_batch_directories(
    tmp_path: Path,
) -> None:
    """Verify lexical variants of the same directory do not conflict.

    Args:
        tmp_path: Pytest temporary directory fixture.
    """
    sub = tmp_path / "sub"
    sub.mkdir()
    tool = {
        "id": "classify_lidar",
        "params": [_lidar_input_param("input"), _lidar_input_param("polygons")],
    }
    request = WhiteboxRunRequest(
        tool_id="classify_lidar",
        parameters={
            "input": str(tmp_path),
            "polygons": str(sub / ".."),
        },
        tool=tool,
    )

    args, working_directory = _prepare_arguments(request, [])

    assert args == {}
    assert working_directory == str(tmp_path.resolve())


def test_prepare_arguments_without_tool_metadata(tmp_path: Path) -> None:
    """Verify missing tool metadata never triggers batch mode.

    Args:
        tmp_path: Pytest temporary directory fixture.
    """
    request = WhiteboxRunRequest(
        tool_id="classify_lidar",
        parameters={"input": str(tmp_path)},
        tool=None,
    )

    args, working_directory = _prepare_arguments(request, [])

    assert args["input"] == str(tmp_path)
    assert working_directory is None


def test_is_batch_directory_input_requires_batch_wording() -> None:
    """Verify non-batch descriptions never enable batch mode."""
    assert _is_batch_directory_input(_lidar_input_param("input"))
    assert not _is_batch_directory_input(
        _lidar_input_param("input", description="Input LiDAR file.")
    )
    # Output parameters never enable batch mode even with batch wording.
    output_param = _lidar_input_param("output")
    output_param["kind"] = "lidar_out"
    assert not _is_batch_directory_input(output_param)
