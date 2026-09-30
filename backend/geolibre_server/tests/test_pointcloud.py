"""Tests for the /pointcloud labelled rewrite."""

import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app import pointcloud
from geolibre_server.app.conversion import _RESULT_MARKER
from geolibre_server.app.pointcloud import (
    _APPLY_LABELS_SCRIPT,
    ApplyLabelsRequest,
    pointcloud_apply_labels,
)

laspy = pytest.importorskip("laspy")
np = pytest.importorskip("numpy")

# Encoded by the app's label store (encodeNodeEdits): classes {0: 6, 1: 6, 2: 2}
# and instance ids {0: 1, 5: 300, 70000: 4294967295}.
APP_CLASSES = "Y2ADQiYA"
APP_INSTANCES = "Y2BkWcP0ahHLfyDgBwA="


def _write_las(path: Path, count: int = 100, point_format: int = 6) -> None:
    header = laspy.LasHeader(
        point_format=point_format, version="1.4" if point_format >= 6 else "1.2"
    )
    header.scales = [0.01, 0.01, 0.01]
    las = laspy.LasData(header)
    las.x = np.arange(count, dtype=float)
    las.y = np.zeros(count)
    las.z = np.arange(count, dtype=float) / 10
    las.classification = np.ones(count, dtype=np.uint8)
    las.write(str(path))


def _run(params: dict, payload: dict, tmp_path: Path) -> dict:
    payload_path = tmp_path / "payload.json"
    payload_path.write_text(json.dumps(payload))
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _APPLY_LABELS_SCRIPT,
            json.dumps({**params, "payload_path": str(payload_path)}),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    # The payload is private to the job and removed once read.
    assert not payload_path.exists()
    return json.loads(completed.stdout.split(_RESULT_MARKER, 1)[1])


def test_script_compiles_with_its_marker() -> None:
    compile(_APPLY_LABELS_SCRIPT, "<apply-labels>", "exec")
    assert _RESULT_MARKER in _APPLY_LABELS_SCRIPT and "{marker}" not in _APPLY_LABELS_SCRIPT


def test_applies_app_encoded_labels_to_a_whole_file(tmp_path: Path) -> None:
    _write_las(tmp_path / "in.las")
    result = _run(
        {"input_path": str(tmp_path / "in.las"), "output_path": str(tmp_path / "out.laz")},
        {"labels": {"file": APP_CLASSES}, "instances": {"file": APP_INSTANCES}},
        tmp_path,
    )
    # Instance 70000 is past the end of the 100-point file, so it is dropped.
    assert result["points"] == 100
    assert (result["relabelled"], result["instanced"]) == (3, 2)
    out = laspy.read(str(tmp_path / "out.laz"))
    assert list(out.classification[:4]) == [6, 6, 2, 1]
    assert int(out["instance"][0]) == 1 and int(out["instance"][5]) == 300


def test_maps_copc_node_keys_to_file_order(tmp_path: Path) -> None:
    path = tmp_path / "in.copc.laz"
    header = laspy.LasHeader(point_format=6, version="1.4")
    las = laspy.LasData(header)
    las.x = np.arange(100, dtype=float)
    las.y = np.zeros(100)
    las.z = np.zeros(100)
    las.classification = np.ones(100, dtype=np.uint8)
    placeholder = b"\xab" * 160
    las.header.vlrs.append(
        laspy.VLR(user_id="copc", record_id=1, description="", record_data=placeholder)
    )
    las.write(str(path))
    raw = bytearray(path.read_bytes())
    at = raw.index(placeholder)
    entry = struct.Struct("<4iQii")
    # Node 1-0-0-0 is listed first but stored after node 0-0-0-0.
    page = entry.pack(1, 0, 0, 0, 9000, 0, 60) + entry.pack(0, 0, 0, 0, 1000, 0, 40)
    struct.pack_into("<QQ", raw, at + 40, len(raw), len(page))
    path.write_bytes(bytes(raw) + page)
    _run(
        {"input_path": str(path), "output_path": str(tmp_path / "out.las")},
        {"labels": {"1-0-0-0": APP_CLASSES}},
        tmp_path,
    )
    out = laspy.read(str(tmp_path / "out.las"))
    # Node 1-0-0-0 starts at file point 40.
    assert list(out.classification[40:43]) == [6, 6, 2]
    assert int((np.asarray(out.classification) != 1).sum()) == 3


def test_upgrades_a_legacy_format_for_classes_above_31(tmp_path: Path) -> None:
    import base64
    import zlib

    _write_las(tmp_path / "legacy.las", point_format=1)
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    edits = base64.b64encode(compressor.compress(bytes([0, 64])) + compressor.flush()).decode()
    _run(
        {"input_path": str(tmp_path / "legacy.las"), "output_path": str(tmp_path / "out.las")},
        {"labels": {"file": edits}},
        tmp_path,
    )
    out = laspy.read(str(tmp_path / "out.las"))
    assert out.header.point_format.id == 6
    assert int(out.classification[0]) == 64


def test_endpoint_checks_extensions_and_hands_labels_over_in_a_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_las(tmp_path / "in.las")
    started: dict = {}
    monkeypatch.setattr(pointcloud, "_ensure_pointcloud_runtime", lambda: sys.executable)
    monkeypatch.setattr(
        pointcloud,
        "_start_job",
        lambda tool_id, script, params, name: started.update(params=params) or {"id": "job"},
    )
    with pytest.raises(HTTPException) as bad:
        pointcloud_apply_labels(
            ApplyLabelsRequest(
                input_path=str(tmp_path / "in.las"), output_path=str(tmp_path / "out.tif")
            )
        )
    assert bad.value.status_code == 400
    pointcloud_apply_labels(
        ApplyLabelsRequest(
            input_path=str(tmp_path / "in.las"),
            output_path=str(tmp_path / "out.laz"),
            labels={"file": APP_CLASSES},
        )
    )
    payload_path = Path(started["params"]["payload_path"])
    try:
        assert json.loads(payload_path.read_text())["labels"] == {"file": APP_CLASSES}
    finally:
        payload_path.unlink()
