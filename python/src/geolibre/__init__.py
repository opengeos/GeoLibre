"""GeoLibre for Jupyter: the full GeoLibre GIS app as an anywidget."""

from typing import TYPE_CHECKING, Any

from .authoring import (
    basemap_catalog,
    color_ramp_names,
    describe_project,
    load_project,
    save_project,
)
from .geolibre import Feature, Layer, Map
from .legends import builtin_legend_names
from .polyline import decode_polyline, encode_polyline, polyline_to_geojson, unescape_polyline

if TYPE_CHECKING:
    from .dash_component import DashMap

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

__version__ = "3.6.1"
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


def __getattr__(name: str) -> Any:
    """Import ``DashMap`` on first use.

    Importing Dash opens a ``dash`` comm in a Jupyter kernel, which logs
    ``Exception opening new comm`` in any frontend without Dash's extension, so
    the normal Jupyter API must not import it.

    Args:
        name: The module attribute being looked up.

    Returns:
        The ``DashMap`` class.

    Raises:
        AttributeError: If ``name`` is not a lazily loaded attribute.
    """
    if name == "DashMap":
        from .dash_component import DashMap

        globals()["DashMap"] = DashMap
        return DashMap
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _jupyter_server_extension_points() -> list[dict[str, str]]:
    """Declare the Jupyter Server extension that serves the bundled app."""
    return [{"module": "geolibre"}]


def _load_jupyter_server_extension(serverapp: Any) -> None:
    """Entry point called by Jupyter Server when the extension loads."""
    from ._extension import load_jupyter_server_extension

    load_jupyter_server_extension(serverapp)
