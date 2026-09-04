"""GeoLibre for Jupyter: the full GeoLibre GIS app as an anywidget."""

from typing import Any

from .authoring import (
    basemap_catalog,
    color_ramp_names,
    describe_project,
    load_project,
    save_project,
)
from .dash_component import DashMap
from .geolibre import Feature, Layer, Map
from .legends import builtin_legend_names
from .polyline import decode_polyline, encode_polyline, polyline_to_geojson, unescape_polyline

# Dash discovers component bundles from these package-level distribution
# declarations. Keeping Dash optional means importing the normal Jupyter API
# does not require Dash to be installed.
_js_dist = [
    {
        "relative_package_path": "static/dash/geolibre.js",
        "namespace": "geolibre",
    }
]
_css_dist: list[dict[str, str]] = []

__version__ = "2.9.0"
__all__ = [
    "Feature",
    "Layer",
    "Map",
    "DashMap",
    "__version__",
    "basemap_catalog",
    "builtin_legend_names",
    "color_ramp_names",
    "decode_polyline",
    "describe_project",
    "encode_polyline",
    "load_project",
    "polyline_to_geojson",
    "save_project",
    "unescape_polyline",
]


def _jupyter_server_extension_points() -> list[dict[str, str]]:
    """Declare the Jupyter Server extension that serves the bundled app."""
    return [{"module": "geolibre"}]


def _load_jupyter_server_extension(serverapp: Any) -> None:
    """Entry point called by Jupyter Server when the extension loads."""
    from ._extension import load_jupyter_server_extension

    load_jupyter_server_extension(serverapp)
