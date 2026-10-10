"""Tests for the ICESat-2 / GEDI footprint reader and Map.add_icesat2 / add_gedi."""

from __future__ import annotations

import pytest

h5py = pytest.importorskip("h5py")
np = pytest.importorskip("numpy")

import geolibre.geolibre as gmod  # noqa: E402
from geolibre import spaceborne_lidar as sl  # noqa: E402
from geolibre.geolibre import Map  # noqa: E402


@pytest.fixture
def m(monkeypatch):
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def _atl08(path, *, beams=("gt1l", "gt1r"), n=6, empty_beam=None):
    """Write a minimal ATL08 granule: segments along a north-south track."""
    with h5py.File(path, "w") as f:
        f.attrs["short_name"] = np.bytes_(b"ATL08")
        for b_index, beam in enumerate(beams):
            group = f.create_group(beam)
            group.attrs["atlas_beam_type"] = np.bytes_(b"strong" if beam.endswith("l") else b"weak")
            if beam == empty_beam:
                continue
            seg = group.create_group("land_segments")
            lat = 35.0 + np.arange(n) * 0.01
            lon = np.full(n, -84.0 + b_index * 0.001)
            seg["latitude"] = lat
            seg["longitude"] = lon
            seg["delta_time"] = 2.5e8 + np.arange(n, dtype=np.float64)
            terrain = seg.create_group("terrain")
            h = np.linspace(300, 350, n).astype(np.float32)
            h[2] = 3.4028235e38  # fill
            ds = terrain.create_dataset("h_te_best_fit", data=h)
            ds.attrs["_FillValue"] = np.float32(3.4028235e38)
            terrain["terrain_slope"] = np.full(n, 0.1, dtype=np.float32)
            canopy = seg.create_group("canopy")
            canopy["h_canopy"] = np.full(n, 12.5, dtype=np.float32)
            seg["night_flag"] = np.ones(n, dtype=np.int8)


def _gedi_l2a(path, *, n=5, version3=False):
    """Write a minimal GEDI L2A granule with one power and one coverage beam."""
    with h5py.File(path, "w") as f:
        f.create_group("METADATA/DatasetIdentification").attrs["shortName"] = "GEDI_L2A"
        for beam, description in (("BEAM0101", "Full power beam"), ("BEAM0000", "Coverage beam")):
            group = f.create_group(beam)
            group.attrs["description"] = description
            group["lat_lowestmode"] = 10.0 + np.arange(n) * 0.001
            group["lon_lowestmode"] = np.full(n, 20.0)
            group["delta_time"] = 1.0e8 + np.arange(n, dtype=np.float64)
            group["elev_lowestmode"] = np.full(n, 100.0, dtype=np.float32)
            rh = np.tile(np.arange(101, dtype=np.float32), (n, 1))
            group["rh"] = rh
            flags = np.array([1, 0, 1, 1, 1][:n], dtype=np.uint8)
            group["l2a_quality_flag_rel3" if version3 else "quality_flag"] = flags
            group["shot_number"] = np.arange(n, dtype=np.uint64) + np.uint64(2**60)


def test_detects_products_from_attributes_and_names():
    assert sl.detect_product("ATL08") == "ATL08"
    assert sl.detect_product(" gedi02_b ") == "GEDI_L2B"
    assert sl.detect_product(None, "/x/GEDI_L4A_AGB_Density_V2_1.GEDI04_A_2019.h5") == "GEDI_L4A"
    assert sl.detect_product(None, "ATL06_20230629.h5") == "ATL06"
    assert sl.detect_product(None, "notes.h5") is None


def test_reads_atl08_segments_with_derived_properties(tmp_path):
    path = tmp_path / "ATL08_test.h5"
    _atl08(path)
    result = sl.read_spaceborne_lidar(path)
    assert result.product == "ATL08"
    # The fill value fails the ATL08 "valid terrain height" rule on each beam.
    assert result.total == 12
    assert result.matched == 10
    assert result.kept == 10
    first = result.geojson["features"][0]
    props = first["properties"]
    assert first["id"] == 0
    assert props["beam"] == "gt1l"
    assert props["beam_type"] == "strong"
    assert props["distance_km"] == 0.0
    assert props["h_te_best_fit"] == 300.0
    assert props["h_canopy"] == 12.5
    assert props["night_flag"] == 1
    assert props["time"] == "2025-12-03T12:26:40.000Z"
    # Along-track distance counts from the first segment of each beam, in km.
    second = result.geojson["features"][1]["properties"]
    assert second["distance_km"] == pytest.approx(1.112, abs=0.01)
    assert result.per_beam == {"gt1l": 5, "gt1r": 5}


def test_keeps_fill_rows_as_null_without_the_quality_filter(tmp_path):
    path = tmp_path / "ATL08_test.h5"
    _atl08(path, beams=("gt1l",))
    result = sl.read_spaceborne_lidar(path, quality_filter=False)
    values = [f["properties"]["h_te_best_fit"] for f in result.geojson["features"]]
    assert values[2] is None
    assert result.kept == 6


def test_filters_by_bbox_beams_and_caps_points(tmp_path):
    path = tmp_path / "ATL08_test.h5"
    _atl08(path, n=20)
    inside = sl.read_spaceborne_lidar(path, bbox=[-84.1, 35.0, -83.9, 35.05], quality_filter=False)
    assert all(f["geometry"]["coordinates"][1] <= 35.05 for f in inside.geojson["features"])
    one_beam = sl.read_spaceborne_lidar(path, beams=["gt1r"], quality_filter=False)
    assert set(one_beam.per_beam) == {"gt1r"}
    # A bare string names one beam.
    assert set(sl.read_spaceborne_lidar(path, beams="gt1r").per_beam) == {"gt1r"}
    capped = sl.read_spaceborne_lidar(path, quality_filter=False, max_points=7)
    assert capped.stride == 6
    assert capped.kept <= 7
    with pytest.raises(ValueError, match="None of the beams"):
        sl.read_spaceborne_lidar(path, beams=["gt3l"])


def test_skips_a_beam_without_land_segments(tmp_path):
    path = tmp_path / "ATL08_test.h5"
    _atl08(path, beams=("gt1l", "gt2l"), empty_beam="gt2l")
    assert set(sl.read_spaceborne_lidar(path).per_beam) == {"gt1l"}


@pytest.mark.parametrize("version3", [False, True])
def test_reads_gedi_l2a_quality_relative_heights_and_shot_numbers(tmp_path, version3):
    path = tmp_path / "GEDI02_A_test.h5"
    _gedi_l2a(path, version3=version3)
    fields = ["rh98", "rh50", "shot_number"]
    result = sl.read_spaceborne_lidar(path, fields=fields)
    assert result.product == "GEDI_L2A"
    # Shot 1 of each beam fails the quality flag.
    assert result.kept == 8
    props = result.geojson["features"][0]["properties"]
    assert props["beam"] == "BEAM0000"
    assert props["beam_type"] == "coverage"
    assert props["rh98"] == 98.0
    assert props["rh50"] == 50.0
    # 64-bit shot numbers stay exact as strings.
    assert props["shot_number"] == str(2**60)


def test_rejects_a_non_lidar_file(tmp_path):
    path = tmp_path / "other.h5"
    with h5py.File(path, "w") as f:
        f["x"] = np.arange(3)
    with pytest.raises(ValueError, match="not an ICESat-2"):
        sl.read_spaceborne_lidar(path)


def test_add_icesat2_builds_a_styled_footprint_layer(m, tmp_path):
    path = tmp_path / "ATL08_test.h5"
    _atl08(path)
    layer_id = m.add_icesat2(path)
    layer = m.project["layers"][-1]
    assert layer["id"] == layer_id
    assert layer["type"] == "geojson"
    assert layer["name"] == "ATL08 ATL08_test"
    assert layer["metadata"]["sourceKind"] == "spaceborne-lidar"
    assert layer["metadata"]["product"] == "ATL08"
    assert layer["metadata"]["beams"] == ["gt1l", "gt1r"]
    assert layer["style"]["circleRadius"] == 3
    assert layer["style"]["vectorStyleMode"] == "graduated"
    assert layer["style"]["vectorStyleProperty"] == "h_te_best_fit"
    assert len(layer["geojson"]["features"]) == 10


def test_add_icesat2_and_add_gedi_reject_the_other_mission(m, tmp_path):
    atl08 = tmp_path / "ATL08_test.h5"
    gedi = tmp_path / "GEDI02_A_test.h5"
    _atl08(atl08)
    _gedi_l2a(gedi)
    with pytest.raises(ValueError, match="not GEDI"):
        m.add_gedi(atl08)
    with pytest.raises(ValueError, match="not ICESat-2"):
        m.add_icesat2(gedi)
    layer_id = m.add_gedi(gedi, "Shots", color_by="", circleRadius=5)
    layer = m.project["layers"][-1]
    assert layer["id"] == layer_id
    assert layer["name"] == "Shots"
    assert layer["style"]["circleRadius"] == 5
    assert (
        "vectorStyleMode" not in layer["style"] or layer["style"]["vectorStyleMode"] != "graduated"
    )


def test_reports_when_no_footprint_survives(m, tmp_path):
    path = tmp_path / "ATL08_test.h5"
    _atl08(path)
    with pytest.raises(ValueError, match="No footprints"):
        m.add_icesat2(path, bbox=[0, 0, 1, 1])


def test_along_track_distance_carries_over_invalid_coordinates():
    lat = np.array([0.0, np.nan, 0.0, 0.0])
    lon = np.array([0.0, 0.0, 0.01, 0.02])
    km = sl._along_track_km(np, lat, lon)
    assert km[0] == 0.0
    assert km[1] == 0.0
    assert km[2] == pytest.approx(1.112, abs=0.001)
    assert km[3] == pytest.approx(2.224, abs=0.001)
