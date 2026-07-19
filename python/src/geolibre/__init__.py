"""GeoLibre for Jupyter: the full GeoLibre GIS app as an anywidget."""

from typing import Any

from .geolibre import Feature, Layer, Map

__version__ = "2.2.0"
__all__ = ["Feature", "Layer", "Map", "__version__"]


def _jupyter_server_extension_points() -> list[dict[str, str]]:
    """Declare the Jupyter Server extension that serves the bundled app."""
    return [{"module": "geolibre"}]


def _load_jupyter_server_extension(serverapp: Any) -> None:
    """Entry point called by Jupyter Server when the extension loads."""
    from ._extension import load_jupyter_server_extension

    load_jupyter_server_extension(serverapp)
