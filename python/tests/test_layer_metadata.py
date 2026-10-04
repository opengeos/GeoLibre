"""Tests for a layer's descriptive (catalog) metadata authoring.

The block mirrors ``packages/core/src/layer-descriptive-metadata.ts``; the
cross-language round trip lives in ``test_authoring_parity.py`` (the pinned
fixture the app's ``parseProject`` reads back).
"""

from __future__ import annotations

import json

import pytest

import geolibre.geolibre as gmod
from geolibre import Map, authoring, project

POINT_FC = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "A"},
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }
    ],
}

FULL = {
    "title": "Rivers",
    "abstract": "Major rivers.",
    "keywords": ["hydrology", "rivers"],
    "license": "CC-BY-4.0",
    "attribution": "TN GIS",
    "contact": {"name": "Ada", "email": "ada@example.org", "organization": "TN GIS"},
    "lineage": "Digitized in 2019.",
    "temporalExtent": {"start": "2019-01-01", "end": "2019-12-31"},
    "links": [{"href": "https://example.org", "rel": "about", "title": "Home"}],
}


@pytest.fixture
def proj():
    """A project with one inlined GeoJSON layer named "Cities"."""
    p = project.build_empty_project("Test")
    authoring.add_layer(p, project.geojson_layer("Cities", POINT_FC))
    return p


@pytest.fixture
def m(monkeypatch):
    """A Map instance with the static server stubbed out (no bundle needed)."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def test_layer_metadata_builds_the_camel_case_block():
    built = project.layer_metadata(
        title=" Rivers ",
        abstract="Major rivers.",
        keywords="hydrology, rivers, Rivers, ",
        license="CC-BY-4.0",
        attribution="TN GIS",
        contact={"name": "Ada", "email": "ada@example.org", "organization": "TN GIS"},
        lineage="Digitized in 2019.",
        temporal_extent=("2019-01-01", "2019-12-31"),
        links=[{"href": "https://example.org", "rel": "about", "title": "Home"}],
    )
    assert built == FULL


def test_layer_metadata_is_none_when_everything_is_blank():
    assert project.layer_metadata(title="  ", keywords=[], contact={}) is None


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"contact": {"email": "nope"}}, "email"),
        ({"temporal_extent": ("2019-02-30", None)}, "start"),
        ({"temporal_extent": (None, "01/02/2020")}, "end"),
        ({"temporal_extent": ("2021-01-01", "2020-01-01")}, "before"),
        ({"links": ["javascript:alert(1)"]}, "href"),
        ({"links": ["/relative"]}, "href"),
    ],
)
def test_layer_metadata_rejects_malformed_values(kwargs, message):
    with pytest.raises(ValueError, match=message):
        project.layer_metadata(**kwargs)


def test_dates_compare_as_instants():
    # A date-only end covers its whole day, so a same-day date-time start fits.
    assert project.layer_metadata(temporal_extent=("2020-01-01T18:00:00Z", "2020-01-01"))
    # Offsets are honored: 01:00+02:00 is 23:00Z the previous day, so it ends
    # before a 23:30Z start even though its text sorts after it.
    assert project.layer_metadata(
        temporal_extent=("2020-01-01T22:30:00Z", "2020-01-02T01:00:00+02:00")
    )
    with pytest.raises(ValueError, match="before"):
        project.layer_metadata(
            temporal_extent=("2020-01-01T23:30:00Z", "2020-01-02T01:00:00+02:00")
        )


def test_is_valid_metadata_date():
    for value in ["2020-02-29", "2020-01-01T10:00", "2020-01-01T10:00:30.5+02:00"]:
        assert project.is_valid_metadata_date(value), value
    for value in ["2021-02-29", "2020-13-01", "2020-1-1", "2020-01-01T25:00"]:
        assert not project.is_valid_metadata_date(value), value


def test_normalize_layer_metadata_mirrors_the_app():
    assert project.normalize_layer_metadata(
        {
            "title": " T ",
            "keywords": "not-a-list",
            "contact": {"name": " "},
            "links": [{"title": "orphan"}, {"href": "https://x.org", "rel": " "}],
            "unknown": 1,
        }
    ) == {"title": "T", "links": [{"href": "https://x.org"}]}
    assert project.normalize_layer_metadata(None) is None
    assert project.normalize_layer_metadata({"title": ""}) is None


def test_set_layer_metadata_round_trips_through_a_saved_file(proj, tmp_path):
    authoring.set_layer_metadata(
        proj,
        "Cities",
        title="Rivers",
        abstract="Major rivers.",
        keywords=["hydrology", "rivers"],
        license="CC-BY-4.0",
        attribution="TN GIS",
        contact={"name": "Ada", "email": "ada@example.org", "organization": "TN GIS"},
        lineage="Digitized in 2019.",
        temporal_extent={"start": "2019-01-01", "end": "2019-12-31"},
        links=[{"href": "https://example.org", "rel": "about", "title": "Home"}],
    )
    out = tmp_path / "map.geolibre.json"
    authoring.save_project(out, proj)
    reopened = authoring.load_project(out)
    assert authoring.find_layer(reopened, "Cities")["descriptiveMetadata"] == FULL
    assert "descriptiveMetadata" in json.loads(out.read_text(encoding="utf-8"))["layers"][0]


def test_set_layer_metadata_merge_keeps_unnamed_fields(proj):
    authoring.set_layer_metadata(proj, "Cities", title="T", license="MIT")
    merged = authoring.set_layer_metadata(proj, "Cities", merge=True, abstract="A", license="")
    assert merged == {"title": "T", "abstract": "A"}
    replaced = authoring.set_layer_metadata(proj, "Cities", lineage="L")
    assert replaced == {"lineage": "L"}


def test_emptying_the_metadata_removes_the_block(proj):
    authoring.set_layer_metadata(proj, "Cities", title="T")
    assert authoring.set_layer_metadata(proj, "Cities", title=" ") is None
    assert "descriptiveMetadata" not in authoring.find_layer(proj, "Cities")
    authoring.set_layer_metadata(proj, "Cities", title="T")
    authoring.clear_layer_metadata(proj, "Cities")
    assert "descriptiveMetadata" not in authoring.find_layer(proj, "Cities")


def test_set_layer_metadata_rejects_unknown_fields(proj):
    with pytest.raises(ValueError, match="unknown layer metadata field"):
        authoring.set_layer_metadata(proj, "Cities", titel="typo")


def test_map_and_layer_handles(m):
    layer_id = m.add_geojson(POINT_FC, name="Cities")
    m.set_layer_metadata(layer_id, title="T", keywords=["a"])
    handle = m.layers[-1]
    assert handle.descriptive_metadata == {"title": "T", "keywords": ["a"]}
    handle.set_metadata(merge=True, license="CC0-1.0")
    assert handle.descriptive_metadata == {"title": "T", "keywords": ["a"], "license": "CC0-1.0"}
    m.clear_layer_metadata(layer_id)
    assert handle.descriptive_metadata == {}
