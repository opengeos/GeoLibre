"""GeoLibre for Jupyter: the full GeoLibre GIS app as an anywidget."""

from typing import Any

from .authoring import (
    basemap_catalog,
    color_ramp_names,
    describe_project,
    load_project,
    save_project,
)
from .geolibre import Feature, Layer, Map
from .legends import builtin_legend_names

__version__ = "2.6.0"
__all__ = [
    "Feature",
    "Layer",
    "Map",
    "__version__",
    "basemap_catalog",
    "builtin_legend_names",
    "color_ramp_names",
    "describe_project",
    "load_project",
    "save_project",
]


def _jupyter_server_extension_points() -> list[dict[str, str]]:
    """Declare the Jupyter Server extension that serves the bundled app."""
    return [{"module": "geolibre"}]


def _load_jupyter_server_extension(serverapp: Any) -> None:
    """Entry point called by Jupyter Server when the extension loads."""
    from ._extension import load_jupyter_server_extension

    load_jupyter_server_extension(serverapp)
