"""The GeoLibre Jupyter widget and its leafmap-style Python API."""

from __future__ import annotations

import copy
import json
import pathlib
from typing import Any, Callable

import anywidget
import traitlets

from . import project as _project
from ._server import serve_app
from .basemaps import resolve_basemap

_HERE = pathlib.Path(__file__).parent
_STATIC_APP = _HERE / "static" / "app"


class Map(anywidget.AnyWidget):
    """An interactive GeoLibre map for Jupyter notebooks.

    The widget embeds the full GeoLibre GIS app (menus, panels, processing
    tools) and exposes a small Python API to add data and drive the view. State
    is synchronized both ways through a single ``.geolibre.json`` project, so
    edits made in the UI are readable from Python via :meth:`to_project`.

    Example:
        >>> from geolibre import Map
        >>> m = Map(center=(-100, 40), zoom=4)
        >>> m.add_geojson("https://example.com/data.geojson", name="Data")
        >>> m
    """

    _esm = _HERE / "_frontend.js"

    # The serialized project is the single source of truth synced over the
    # bridge. Edits in the UI flow back into this trait.
    project = traitlets.Dict().tag(sync=True)
    # Base URL of the localhost server hosting the bundled app.
    _app_url = traitlets.Unicode("").tag(sync=True)
    height = traitlets.Unicode("600px").tag(sync=True)
    # "embed" (compact chrome), "full" (desktop chrome), or "maponly".
    layout = traitlets.Unicode("embed").tag(sync=True)
    theme = traitlets.Unicode("light").tag(sync=True)
    # Bumped on every Python-initiated project change; echoed by the app.
    _seq = traitlets.Int(0).tag(sync=True)
    # Last error reported by the app (e.g. an invalid project).
    error = traitlets.Unicode("").tag(sync=True)

    def __init__(
        self,
        center: list[float] | tuple[float, float] | None = None,
        zoom: float | None = None,
        *,
        basemap: str | None = None,
        height: str = "600px",
        layout: str = "embed",
        theme: str = "light",
        **kwargs: Any,
    ) -> None:
        """Create a GeoLibre map.

        Args:
            center: Initial ``[lng, lat]`` map center.
            zoom: Initial zoom level.
            basemap: A basemap name or MapLibre style URL for the background.
            height: CSS height of the widget (e.g. ``"600px"``).
            layout: ``"embed"`` (compact UI), ``"full"`` (full desktop UI), or
                ``"maponly"`` (map without chrome).
            theme: ``"light"`` or ``"dark"``.
            **kwargs: Forwarded to ``anywidget.AnyWidget``.
        """
        super().__init__(**kwargs)
        self.height = height
        self.layout = layout
        self.theme = theme
        self._app_url = serve_app(_STATIC_APP)
        self.project = _project.build_empty_project(
            center=center,
            zoom=zoom,
            basemap_url=resolve_basemap(basemap) if basemap else None,
        )

    # -- internal --------------------------------------------------------

    def _update_project(self, mutate: Callable[[dict[str, Any]], None]) -> None:
        """Mutate the project off a deep copy and reassign it.

        traitlets only fires a sync on identity change, so an in-place edit of
        ``self.project`` would not reach the app. Each mutation works on a copy,
        bumps the sequence counter, and reassigns the trait.

        Args:
            mutate: Callback that mutates the project dict in place.
        """
        proj = copy.deepcopy(self.project)
        mutate(proj)
        self._seq += 1
        self.project = proj

    def _add_layer(self, layer: dict[str, Any]) -> str:
        self._update_project(lambda p: p["layers"].append(layer))
        return layer["id"]

    # -- layer API -------------------------------------------------------

    def add_geojson(self, data: Any, name: str = "GeoJSON", **style: Any) -> str:
        """Add a GeoJSON layer.

        Args:
            data: A FeatureCollection/Feature/geometry dict, a file path or URL
                to a GeoJSON file, a JSON string, or any object with a
                ``__geo_interface__`` (e.g. a GeoDataFrame).
            name: Layer display name.
            **style: Style overrides (e.g. ``fillColor="#ff0000"``).

        Returns:
            The id of the added layer.
        """
        source_url = (
            data
            if isinstance(data, str) and data.startswith(("http://", "https://"))
            else None
        )
        fc = _project.load_featurecollection(data)
        return self._add_layer(
            _project.geojson_layer(name, fc, source_url=source_url, **style)
        )

    def add_tile_layer(
        self,
        url: str,
        name: str = "Tile Layer",
        *,
        tile_size: int = 256,
        attribution: str | None = None,
        **style: Any,
    ) -> str:
        """Add a raster XYZ tile layer.

        Args:
            url: An XYZ tile URL template (``{z}/{x}/{y}``).
            name: Layer display name.
            tile_size: Tile size in pixels.
            attribution: Optional attribution string.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.tile_layer(
                name,
                url,
                tile_size=tile_size,
                attribution=attribution,
                **style,
            )
        )

    def add_cog(
        self,
        url: str,
        name: str = "COG",
        *,
        bands: list[int] | None = None,
        colormap: str | None = None,
        rescale: list[list[float]] | None = None,
        **style: Any,
    ) -> str:
        """Add a Cloud Optimized GeoTIFF (COG) layer.

        Args:
            url: URL of the COG / GeoTIFF.
            name: Layer display name.
            bands: Optional 1-based band indices to render.
            colormap: Optional colormap name (single-band rendering).
            rescale: Optional ``[[min, max], ...]`` ranges per band.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.cog_layer(
                name,
                url,
                bands=bands,
                colormap=colormap,
                rescale=rescale,
                **style,
            )
        )

    def remove_layer(self, layer_id: str) -> None:
        """Remove a layer by id.

        Args:
            layer_id: The id returned when the layer was added.
        """
        self._update_project(
            lambda p: p.__setitem__(
                "layers", [l for l in p["layers"] if l.get("id") != layer_id]
            )
        )

    def clear_layers(self) -> None:
        """Remove all layers from the map."""
        self._update_project(lambda p: p.__setitem__("layers", []))

    # -- view / basemap API ---------------------------------------------

    def add_basemap(self, basemap: str) -> None:
        """Set the background basemap style.

        Args:
            basemap: A basemap name or MapLibre style URL.
        """
        url = resolve_basemap(basemap)
        self._update_project(lambda p: p.__setitem__("basemapStyleUrl", url))

    def set_center(self, lng: float, lat: float, zoom: float | None = None) -> None:
        """Center the map, optionally setting the zoom.

        Args:
            lng: Longitude of the new center.
            lat: Latitude of the new center.
            zoom: Optional zoom level.
        """

        def mutate(p: dict[str, Any]) -> None:
            p["mapView"]["center"] = [float(lng), float(lat)]
            if zoom is not None:
                p["mapView"]["zoom"] = float(zoom)

        self._update_project(mutate)

    set_center_zoom = set_center

    # -- project I/O -----------------------------------------------------

    def to_project(self) -> dict[str, Any]:
        """Return a deep copy of the current project dict."""
        return copy.deepcopy(self.project)

    def load_project(self, source: Any) -> None:
        """Replace the current project.

        Args:
            source: A project dict, a JSON string, or a path to a
                ``.geolibre.json`` file.
        """
        if isinstance(source, dict):
            project = copy.deepcopy(source)
        else:
            text = str(source)
            if text.strip().startswith("{"):
                project = json.loads(text)
            else:
                project = json.loads(
                    pathlib.Path(text).expanduser().read_text(encoding="utf-8")
                )
        self._seq += 1
        self.project = project

    def save_project(self, path: str) -> None:
        """Write the current project to a ``.geolibre.json`` file.

        Args:
            path: Destination file path.
        """
        pathlib.Path(path).expanduser().write_text(
            json.dumps(self.project, indent=2), encoding="utf-8"
        )
