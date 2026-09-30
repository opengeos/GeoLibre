"""Tests for geolibre.pointcloud: node ranges, label files and pre-labels."""

from __future__ import annotations

import struct

import pytest

laspy = pytest.importorskip("laspy")
np = pytest.importorskip("numpy")

from geolibre import authoring  # noqa: E402
from geolibre import pointcloud as pc  # noqa: E402
from geolibre import project as p  # noqa: E402


def _field(point_format: int = 7):
    """A 60 x 60 m field at 1 m spacing with an 8 m tall 12 x 12 m building.

    Returns:
        ``(LasData, roof_mask)``; every point is unclassified (1).
    """
    xs, ys = np.meshgrid(np.arange(-30.0, 30.0), np.arange(-30.0, 30.0))
    xs, ys = xs.ravel(), ys.ravel()
    roof = (np.abs(xs) < 6) & (np.abs(ys) < 6)
    zs = 100 + 0.02 * xs + 0.01 * ys + np.where(roof, 8.0, 0.0)
    header = laspy.LasHeader(
        point_format=point_format, version="1.4" if point_format >= 6 else "1.2"
    )
    header.scales = [0.01, 0.01, 0.01]
    header.offsets = [500000.0, 4800000.0, 0.0]
    las = laspy.LasData(header)
    las.x = xs + 500000
    las.y = ys + 4800000
    las.z = zs
    las.classification = np.ones(len(xs), dtype=np.uint8)
    return las, roof


def _write_fake_copc(path, las, nodes):
    """Write `las` with a COPC info VLR and a hierarchy page appended.

    `nodes` is ``[(key, offset, count)]`` in page order; data offsets only need
    to order the nodes, as in a real COPC file. An entry with a fourth item
    goes into a child page that the root page points to.
    """
    placeholder = b"\xab" * 160
    las.header.vlrs.append(
        laspy.VLR(user_id="copc", record_id=1, description="copc info", record_data=placeholder)
    )
    las.write(str(path))
    raw = bytearray(path.read_bytes())
    at = raw.index(placeholder)
    entry = struct.Struct("<4iQii")

    def page_bytes(entries):
        return b"".join(entry.pack(*key, offset, 0, count) for key, offset, count in entries)

    root_entries = [(n[0], n[1], n[2]) for n in nodes if len(n) == 3]
    child_entries = [(n[0], n[1], n[2]) for n in nodes if len(n) == 4]
    root_offset = len(raw)
    child_offset = None
    body = bytearray()
    if child_entries:
        # Root page: its own entries plus a pointer to the child page after it.
        root_size = entry.size * (len(root_entries) + 1)
        child_offset = root_offset + root_size
        body += page_bytes(root_entries)
        body += entry.pack(1, 1, 1, 1, child_offset, entry.size * len(child_entries), -1)
        body += page_bytes(child_entries)
    else:
        root_size = entry.size * len(root_entries)
        body += page_bytes(root_entries)
    struct.pack_into("<QQ", raw, at + 40, root_offset, root_size)
    raw += body
    path.write_bytes(bytes(raw))


def test_plain_file_is_one_node(tmp_path):
    las, _ = _field()
    las.write(str(tmp_path / "field.las"))
    assert pc.point_node_ranges(tmp_path / "field.las") == [("file", 0, 3600)]


def test_copc_node_ranges_follow_chunk_order(tmp_path):
    las, _ = _field()
    path = tmp_path / "field.copc.laz"
    # Page order differs from file order; the child page holds one node.
    _write_fake_copc(
        path,
        las,
        [
            ((1, 0, 0, 0), 5000, 1600),
            ((0, 0, 0, 0), 1000, 1000),
            ((2, 1, 1, 0), 9000, 1000, "child"),
        ],
    )
    assert pc.point_node_ranges(path) == [
        ("0-0-0-0", 0, 1000),
        ("1-0-0-0", 1000, 1600),
        ("2-1-1-0", 2600, 1000),
    ]


def test_copc_hierarchy_that_disagrees_with_the_header_is_refused(tmp_path):
    las, _ = _field()
    path = tmp_path / "bad.copc.laz"
    _write_fake_copc(path, las, [((0, 0, 0, 0), 1000, 10)])
    with pytest.raises(ValueError, match="hierarchy holds 10 points"):
        pc.point_node_ranges(path)


def test_encoding_matches_the_app():
    # Produced by the app's encodeNodeEdits for instance ids.
    assert (
        pc.encode_point_label_node({0: 1, 5: 300, 70000: 4294967295}, wide=True)
        == "Y2BkWcP0ahHLfyDgBwA="
    )
    edits = {0: 6, 1: 6, 70000: 64}
    assert p.decode_point_label_node(pc.encode_point_label_node(edits)) == edits


def test_write_labeled_point_cloud_applies_labels_and_instances(tmp_path):
    las, _ = _field()
    las.write(str(tmp_path / "field.las"))
    result = pc.write_labeled_point_cloud(
        tmp_path / "field.las",
        tmp_path / "labeled.laz",
        {"file": {0: 6, 5: 64, 99999: 2}},
        {"file": {0: 3}},
        chunk_size=1000,
    )
    # The edit past the end of the file is dropped.
    assert result == {"points": 3600, "relabelled": 2, "instanced": 1}
    out = laspy.read(str(tmp_path / "labeled.laz"))
    assert out.header.point_format.id == 7
    assert out.classification[0] == 6 and out.classification[5] == 64
    assert out.classification[6] == 1
    assert out["instance"].dtype == np.uint32
    assert int(out["instance"][0]) == 3 and int(out["instance"][1]) == 0
    assert np.array_equal(np.asarray(out.X), np.asarray(las.X))


def test_legacy_format_is_upgraded_only_for_classes_above_31(tmp_path):
    las, _ = _field(point_format=1)
    las.write(str(tmp_path / "legacy.las"))
    small = pc.write_labeled_point_cloud(
        tmp_path / "legacy.las", tmp_path / "small.las", {"file": {0: 6}}
    )
    assert small["relabelled"] == 1
    assert laspy.read(str(tmp_path / "small.las")).header.point_format.id == 1
    pc.write_labeled_point_cloud(tmp_path / "legacy.las", tmp_path / "big.las", {"file": {0: 64}})
    big = laspy.read(str(tmp_path / "big.las"))
    assert big.header.point_format.id == 6
    # Waveform formats keep their waveform fields (4 -> 9).
    wave, _ = _field(point_format=4)
    wave.write(str(tmp_path / "wave.las"))
    pc.write_labeled_point_cloud(
        tmp_path / "wave.las", tmp_path / "wave-out.las", {"file": {0: 64}}
    )
    assert laspy.read(str(tmp_path / "wave-out.las")).header.point_format.id == 9
    assert big.classification[0] == 64
    assert np.allclose(np.asarray(big.z), np.asarray(las.z))


def test_upgrade_keeps_crs_extra_dimensions_and_metadata(tmp_path):
    pyproj = pytest.importorskip("pyproj")
    las, _ = _field(point_format=1)
    las.header.add_crs(pyproj.CRS.from_epsg(32610))
    las.header.generating_software = "survey tool"
    las.add_extra_dim(laspy.ExtraBytesParams(name="height", type=np.float32, description="m"))
    las.height = np.arange(len(las.points), dtype=np.float32)
    las.write(str(tmp_path / "legacy.las"))
    pc.write_labeled_point_cloud(tmp_path / "legacy.las", tmp_path / "big.laz", {"file": {0: 64}})
    out = laspy.read(str(tmp_path / "big.laz"))
    assert out.header.point_format.id == 6
    assert out.header.parse_crs().to_epsg() == 32610
    assert out.header.global_encoding.wkt
    assert out.header.generating_software.strip("\0") == "survey tool"
    assert np.array_equal(np.asarray(out.height), np.asarray(las.height))
    assert int(out.classification[0]) == 64


def test_copc_labels_land_on_the_right_points(tmp_path):
    las, _ = _field()
    path = tmp_path / "field.copc.laz"
    _write_fake_copc(path, las, [((1, 0, 0, 0), 5000, 2600), ((0, 0, 0, 0), 1000, 1000)])
    # Node 0-0-0-0 comes first in the file, so its point 3 is file point 3;
    # node 1-0-0-0 starts at file point 1000.
    pc.write_labeled_point_cloud(path, tmp_path / "out.las", {"0-0-0-0": {3: 6}, "1-0-0-0": {3: 9}})
    out = laspy.read(str(tmp_path / "out.las"))
    assert out.classification[3] == 6
    assert out.classification[1003] == 9
    assert int((np.asarray(out.classification) != 1).sum()) == 2
    # The rewritten file is plain LAS: no COPC records carry over.
    assert not any(vlr.user_id.strip("\0").lower() == "copc" for vlr in out.header.vlrs)


def test_prelabel_marks_ground_but_not_the_roof(tmp_path):
    pytest.importorskip("whitebox_workflows")
    las, roof = _field()
    las.write(str(tmp_path / "field.las"))
    labels = pc.prelabel_point_cloud(tmp_path / "field.las", "ground")
    edits = labels["file"]
    ground = [index for index, code in edits.items() if code == 2]
    assert len(ground) > 0.9 * int((~roof).sum())
    assert not any(roof[index] for index in ground)
    # Points the user already labelled are left alone (only 0/1 are relabelled).
    first = ground[0]
    again = pc.prelabel_point_cloud(tmp_path / "field.las", "ground", current={"file": {first: 6}})
    assert first not in again["file"]
    with pytest.raises(ValueError, match="tool must be one of"):
        pc.prelabel_point_cloud(tmp_path / "field.las", "trees")


def test_merge_point_labels_keeps_existing_edits():
    project: dict = {}
    authoring.merge_point_labels(project, "https://x/a.laz", {"file": {1: 6, 2: 6}})
    authoring.merge_point_labels(
        project, "https://x/a.laz", {"file": {2: 9, 3: 2}}, {"file": {1: 7}}
    )
    annotations = p.point_cloud_annotations(project)
    assert annotations["labels"]["https://x/a.laz"]["file"] == {1: 6, 2: 9, 3: 2}
    assert annotations["instances"]["https://x/a.laz"]["file"] == {1: 7}
    state = project["plugins"]["settings"]["geolibre-point-cloud-annotation"]
    assert len(state["sources"]) == 1
