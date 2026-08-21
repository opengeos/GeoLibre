"""Tests for Python polyline encoding, decoding, and Map.add_polyline."""

from __future__ import annotations

import math

import pytest

import geolibre.geolibre as gmod
from geolibre import (
    Map,
    decode_polyline,
    encode_polyline,
    polyline_to_geojson,
    unescape_polyline,
)


@pytest.fixture
def m(monkeypatch):
    """A Map instance with the static server stubbed out."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def test_decode_polyline_google():
    # Google standard precision-5 vector
    coords = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision=5)
    assert len(coords) == 3
    assert math.isclose(coords[0][0], -120.2, abs_tol=1e-5)
    assert math.isclose(coords[0][1], 38.5, abs_tol=1e-5)
    assert math.isclose(coords[1][0], -120.95, abs_tol=1e-5)
    assert math.isclose(coords[1][1], 40.7, abs_tol=1e-5)
    assert math.isclose(coords[2][0], -126.453, abs_tol=1e-5)
    assert math.isclose(coords[2][1], 43.252, abs_tol=1e-5)


def test_decode_polyline_valhalla():
    # Valhalla precision-6 vector
    coords = decode_polyline("_o`diA~gw}qC_pR_pR_pR_af@", precision=6)
    assert len(coords) == 3
    assert math.isclose(coords[0][0], -77.05, abs_tol=1e-6)
    assert math.isclose(coords[0][1], 38.88, abs_tol=1e-6)
    assert math.isclose(coords[1][0], -77.04, abs_tol=1e-6)
    assert math.isclose(coords[1][1], 38.89, abs_tol=1e-6)
    assert math.isclose(coords[2][0], -77.02, abs_tol=1e-6)
    assert math.isclose(coords[2][1], 38.9, abs_tol=1e-6)


def test_decode_polyline_empty_and_invalid():
    assert decode_polyline("") == []
    assert decode_polyline(None) == []  # type: ignore


def test_encode_polyline_google():
    coords = [
        (-120.2, 38.5),
        (-120.95, 40.7),
        (-126.453, 43.252),
    ]
    assert encode_polyline(coords, precision=5) == "_p~iF~ps|U_ulLnnqC_mqNvxq`@"


def test_encode_polyline_valhalla():
    coords = [
        (-77.05, 38.88),
        (-77.04, 38.89),
        (-77.02, 38.9),
    ]
    assert encode_polyline(coords, precision=6) == "_o`diA~gw}qC_pR_pR_pR_af@"


def test_encode_polyline_half_precision_rounding_p5():
    # Positive half-precision: 0.000025 * 1e5 = 2.5 -> Math.round is 3
    # Negative half-precision: -0.000025 * 1e5 = -2.5 -> Math.round is -2
    coords_pos = [(0.000025, 0.000025)]
    coords_neg = [(-0.000025, -0.000025)]
    assert encode_polyline(coords_pos, precision=5) == "EE"
    assert encode_polyline(coords_neg, precision=5) == "BB"
    decoded_pos = decode_polyline(encode_polyline(coords_pos, precision=5), precision=5)
    decoded_neg = decode_polyline(encode_polyline(coords_neg, precision=5), precision=5)
    assert math.isclose(decoded_pos[0][1], 0.00003, abs_tol=1e-6)
    assert math.isclose(decoded_neg[0][1], -0.00002, abs_tol=1e-6)


def test_encode_polyline_half_precision_rounding_p6():
    # Positive half-precision: 0.0000025 * 1e6 = 2.5 -> Math.round is 3
    # Negative half-precision: -0.0000025 * 1e6 = -2.5 -> Math.round is -2
    coords_pos = [(0.0000025, 0.0000025)]
    coords_neg = [(-0.0000025, -0.0000025)]
    assert encode_polyline(coords_pos, precision=6) == "EE"
    assert encode_polyline(coords_neg, precision=6) == "BB"
    decoded_pos = decode_polyline(encode_polyline(coords_pos, precision=6), precision=6)
    decoded_neg = decode_polyline(encode_polyline(coords_neg, precision=6), precision=6)
    assert math.isclose(decoded_pos[0][1], 0.000003, abs_tol=1e-7)
    assert math.isclose(decoded_neg[0][1], -0.000002, abs_tol=1e-7)


def test_polyline_roundtrip():
    original = [
        (106.6297, 10.8231),
        (106.635, 10.828),
        (106.64, 10.835),
    ]
    encoded = encode_polyline(original, precision=5)
    decoded = decode_polyline(encoded, precision=5)
    assert len(decoded) == len(original)
    for (orig_lng, orig_lat), (dec_lng, dec_lat) in zip(original, decoded):
        assert math.isclose(orig_lng, dec_lng, abs_tol=1e-5)
        assert math.isclose(orig_lat, dec_lat, abs_tol=1e-5)


def test_polyline_to_geojson_single():
    fc = polyline_to_geojson("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision=5, properties={"route": "R1"})
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 1
    feature = fc["features"][0]
    assert feature["geometry"]["type"] == "LineString"
    assert len(feature["geometry"]["coordinates"]) == 3
    assert feature["properties"]["route"] == "R1"


def test_unescape_polyline():
    escaped = "_p~iF~ps|U_ulLnnqC_mqNvxq\\\\`@"
    assert unescape_polyline(escaped) == "_p~iF~ps|U_ulLnnqC_mqNvxq\\`@"
    assert unescape_polyline("abc\\ndef") == "abc\\ndef"
    assert unescape_polyline("abc\\rdef") == "abc\\rdef"
    assert unescape_polyline("abc\\tdef") == "abc\\tdef"
    assert unescape_polyline("a\\\"b\\'c\\\\d") == "a\"b'c\\d"
    coords = decode_polyline(escaped, precision=5, unescape=True)
    assert len(coords) == 3


def test_polyline_to_geojson_multiple():
    polylines = [
        "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
        "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
    ]
    fc = polyline_to_geojson(polylines, precision=5)
    assert len(fc["features"]) == 2
    assert fc["features"][0]["properties"]["line_index"] == 1
    assert fc["features"][1]["properties"]["line_index"] == 2


def test_polyline_to_geojson_multiline_string():
    multiline_text = "_p~iF~ps|U_ulLnnqC_mqNvxq`@\n_p~iF~ps|U_ulLnnqC_mqNvxq`@"
    fc = polyline_to_geojson(multiline_text, precision=5)
    assert len(fc["features"]) == 2
    assert fc["features"][0]["properties"]["line_index"] == 1


def test_map_add_polyline(m):
    seq_before = m._seq
    layer_id = m.add_polyline(
        "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
        name="My Route",
        precision=5,
        lineColor="#ff0000",
    )
    assert isinstance(layer_id, str)
    assert m._seq == seq_before + 1

    last = m.project["layers"][-1]
    assert last["id"] == layer_id
    assert last["name"] == "My Route"
    assert last["type"] == "geojson"
    assert last["geojson"]["type"] == "FeatureCollection"
    assert len(last["geojson"]["features"]) == 1
    assert last["geojson"]["features"][0]["geometry"]["type"] == "LineString"


def test_encode_polyline_invalid_coords():
    with pytest.raises(ValueError, match="at least 2 elements"):
        encode_polyline([[10.0]])  # type: ignore

    with pytest.raises(ValueError, match="finite numbers"):
        encode_polyline([(float("nan"), 10.0)])

    with pytest.raises(ValueError, match="out of bounds"):
        encode_polyline([(200.0, 10.0)])

    with pytest.raises(ValueError, match="out of bounds"):
        encode_polyline([(10.0, 100.0)])


def test_decode_polyline_malformed_chars():
    # '/' has ASCII 47 (< 63), which must be rejected
    assert decode_polyline("_p~iF/invalid", precision=5) == []


def test_polyline_to_geojson_unescape_default():
    # Double backslash should NOT be automatically unescaped by default
    raw_with_double_backslash = "_p~iF~ps|U_ulLnnqC_mqNvxq\\\\`@"
    fc_default = polyline_to_geojson(raw_with_double_backslash, precision=5)
    # Default unescape=False treats consecutive backslashes literally (4 points decoded)
    assert len(fc_default["features"][0]["geometry"]["coordinates"]) == 4

    # Explicit unescape=True unescapes \\ to \ (3 points decoded)
    fc_explicit = polyline_to_geojson(raw_with_double_backslash, precision=5, unescape=True)
    assert len(fc_explicit["features"][0]["geometry"]["coordinates"]) == 3
    assert math.isclose(
        fc_explicit["features"][0]["geometry"]["coordinates"][2][0], -125.79764, abs_tol=1e-5
    )


def test_decode_polyline_out_of_range_bounds():
    from geolibre.polyline import _encode_signed_number

    for precision in (5, 6):
        factor = 10**precision

        lat_high = _encode_signed_number(95 * factor) + _encode_signed_number(0)
        assert decode_polyline(lat_high, precision=precision) == []
        lat_low = _encode_signed_number(-95 * factor) + _encode_signed_number(0)
        assert decode_polyline(lat_low, precision=precision) == []

        lon_high = _encode_signed_number(0) + _encode_signed_number(190 * factor)
        assert decode_polyline(lon_high, precision=precision) == []
        lon_low = _encode_signed_number(0) + _encode_signed_number(-190 * factor)
        assert decode_polyline(lon_low, precision=precision) == []
