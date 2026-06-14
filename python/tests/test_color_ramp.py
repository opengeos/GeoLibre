"""Tests for the color-ramp / classification helpers behind add_choropleth."""

from __future__ import annotations

import pytest

from geolibre.color_ramp import (
    equal_interval_breaks,
    get_color_ramp,
    graduated_stops,
    interpolate_hex,
    interpolate_ramp_colors,
    quantile_breaks,
)


def test_get_color_ramp_falls_back_to_default():
    assert get_color_ramp("viridis")[0] == "#440154"
    # Unknown name falls back to the default (first) ramp, matching the TS helper.
    assert get_color_ramp("does-not-exist") == get_color_ramp("viridis")


def test_interpolate_hex_endpoints_and_midpoint():
    assert interpolate_hex("#000000", "#ffffff", 0) == "#000000"
    assert interpolate_hex("#000000", "#ffffff", 1) == "#ffffff"
    assert interpolate_hex("#000000", "#ffffff", 0.5) == "#808080"


def test_interpolate_ramp_colors_count_and_ends():
    colors = interpolate_ramp_colors("viridis", 5)
    assert len(colors) == 5
    assert colors[0] == "#440154"
    assert colors[-1] == "#fde725"
    # count <= 1 returns the single end color.
    assert interpolate_ramp_colors("viridis", 1) == ["#fde725"]


def test_equal_interval_breaks():
    assert equal_interval_breaks(0, 10, 5) == [0, 2.5, 5, 7.5, 10]


def test_quantile_breaks_endpoints():
    breaks = quantile_breaks([0, 1, 2, 3, 100], 5)
    assert breaks[0] == 0
    assert breaks[-1] == 100


def test_quantile_breaks_empty():
    assert quantile_breaks([], 5) == []


def test_graduated_stops_equal_interval():
    stops = graduated_stops(list(range(11)), class_count=5, classification_scheme="equal-interval")
    assert [stop["value"] for stop in stops] == [0.0, 2.5, 5.0, 7.5, 10.0]
    assert stops[0]["color"] == "#440154"
    assert stops[-1]["color"] == "#fde725"


def test_graduated_stops_ignores_non_numeric():
    stops = graduated_stops(["1", "2", "bad", None, "4"], class_count=3)
    assert [stop["value"] for stop in stops] == [1.0, 2.5, 4.0]


def test_graduated_stops_constant_column_single_stop():
    stops = graduated_stops([5, 5, 5], class_count=4)
    assert stops == [{"value": 5.0, "color": "#fde725"}]


def test_graduated_stops_empty_uses_index_values():
    stops = graduated_stops([], class_count=3)
    assert [stop["value"] for stop in stops] == [0, 1, 2]


def test_graduated_stops_class_count_clamped():
    # class_count below 2 is clamped up to 2.
    stops = graduated_stops([0, 1, 2, 3], class_count=1)
    assert len(stops) == 2


def test_graduated_stops_class_count_capped_at_12():
    # Mirrors clampClassCount in StylePanel.tsx (max 12).
    stops = graduated_stops(list(range(100)), class_count=1000)
    assert len(stops) == 12


def test_get_color_ramp_returns_copy():
    ramp = get_color_ramp("viridis")
    ramp.append("#000000")
    # Mutating the returned list must not corrupt the shared definition.
    assert "#000000" not in get_color_ramp("viridis")


def test_graduated_stops_rejects_unknown_scheme():
    with pytest.raises(ValueError, match="classification_scheme"):
        graduated_stops([1, 2, 3], classification_scheme="natural-breaks")
