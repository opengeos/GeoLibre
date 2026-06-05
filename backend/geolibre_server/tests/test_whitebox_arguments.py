from pathlib import Path

from geolibre_server.app.whitebox import WhiteboxRunRequest, _prepare_arguments


def _classify_lidar_tool() -> dict:
    """Return minimal Classify LiDAR metadata for argument tests.

    Returns:
        Tool metadata with one batch-capable LiDAR input and one LiDAR output.
    """
    return {
        "id": "classify_lidar",
        "params": [
            {
                "data_kind": "lidar",
                "description": (
                    "Input LiDAR path or typed LiDAR object. If omitted, runs "
                    "in batch mode over LiDAR files in current directory."
                ),
                "io_role": "input",
                "kind": "lidar_in",
                "name": "input",
                "required": False,
            },
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

    assert args == {}
    assert working_directory == str(tmp_path)


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
