"""The GeoLibre Jupyter widget and its leafmap-style Python API."""

from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import os
import pathlib
import uuid
import warnings
import weakref
from collections.abc import Callable
from typing import Any

import anywidget
import traitlets

from . import project as _project
from ._html_export import (
    _CSS_DIMENSION_RE as _CSS_DIMENSION_RE,
)
from ._html_export import (
    _HTML_EXPORT_TEMPLATE as _HTML_EXPORT_TEMPLATE,
)
from ._html_export import (
    DEFAULT_HTML_APP_URL as DEFAULT_HTML_APP_URL,
)
from ._html_export import (
    _html_escape as _html_escape,
)
from ._html_export import (
    render_project_html as render_project_html,
)
from ._layer import (
    Feature as Feature,
)
from ._layer import (
    Layer as Layer,
)
from ._map_controls import _MapControlsMixin
from ._map_events import _MapEventsMixin
from ._map_layers import _MapLayersMixin
from ._map_query import _MapQueryMixin
from ._map_raster import _MapRasterMixin
from ._map_scene import _MapSceneMixin
from ._map_story import _MapStoryMixin
from ._map_support import (
    _COLLAPSIBLE_PANELS as _COLLAPSIBLE_PANELS,
)
from ._map_support import (
    _CSV_RESTKEY as _CSV_RESTKEY,
)
from ._map_support import (
    _EE_VECTOR_STYLE_KEYS as _EE_VECTOR_STYLE_KEYS,
)
from ._map_support import (
    _HERE as _HERE,
)
from ._map_support import (
    _MAX_TABULAR_BYTES as _MAX_TABULAR_BYTES,
)
from ._map_support import (
    _STATIC_APP as _STATIC_APP,
)
from ._map_support import (
    _VALID_LAYOUTS as _VALID_LAYOUTS,
)
from ._map_support import (
    _VALID_PROJECTIONS as _VALID_PROJECTIONS,
)
from ._map_support import (
    _VALID_THEMES as _VALID_THEMES,
)
from ._map_support import (
    APP_LAYOUT_ENV,
    CHROME_TOGGLES,
    RENDERER_ENV,
    THEME_ENV,
    _resolve_chrome,
)
from ._map_support import (
    MAP_CONTROLS as MAP_CONTROLS,
)
from ._map_support import (
    MAP_PANELS as MAP_PANELS,
)
from ._map_support import (
    MEASURE_AREA_UNITS as MEASURE_AREA_UNITS,
)
from ._map_support import (
    MEASURE_DISTANCE_UNITS as MEASURE_DISTANCE_UNITS,
)
from ._map_support import (
    _read_local_vector as _read_local_vector,
)
from ._map_support import (
    _remove_temporary_rasters as _remove_temporary_rasters,
)
from ._map_vector import _MapVectorMixin
from ._map_view import _MapViewMixin
from ._server import (
    app_port,
    serve_app,
)
from .basemaps import resolve_basemap

# Primary renderers a project can name; mirrors build_empty_project's check.
_VALID_RENDERERS = frozenset({"maplibre", "cesium", "mapbox", "arcgis"})

# The public names this module has always exposed; several now live in the
# private modules above and are re-exported here.
__all__ = [
    "MAP_PANELS",
    "MAP_CONTROLS",
    "MEASURE_DISTANCE_UNITS",
    "MEASURE_AREA_UNITS",
    "DEFAULT_HTML_APP_URL",
    "render_project_html",
    "Map",
    "Feature",
    "Layer",
]


class Map(
    _MapControlsMixin,
    _MapStoryMixin,
    _MapSceneMixin,
    _MapRasterMixin,
    _MapVectorMixin,
    _MapLayersMixin,
    _MapQueryMixin,
    _MapViewMixin,
    _MapEventsMixin,
    anywidget.AnyWidget,
):
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
    # Port of that server, so the front-end can route through a host proxy (e.g.
    # google.colab.kernel.proxyPort) when localhost is not reachable from the
    # browser, as on Google Colab.
    _app_port = traitlets.Int(0).tag(sync=True)
    # How the front-end reaches the app on a remote server. "" means the direct
    # localhost path (local Jupyter, VS Code). "remote" means the browser cannot
    # reach the kernel's localhost, so the front-end probes two same-origin
    # routes and uses whichever is live: the bundled Jupyter Server extension at
    # `{base_url}geolibre/app/`, and jupyter-server-proxy at
    # `{base_url}proxy/{_app_port}/`. Either one works on JupyterHub and other
    # remote servers; the localhost bundle is always served so the proxy route
    # has a target. Google Colab is detected in the front-end and uses its own
    # port proxy.
    _remote_mode = traitlets.Unicode("").tag(sync=True)
    height = traitlets.Unicode("800px").tag(sync=True)
    # "embed" (compact chrome), "full" (desktop chrome), or "maponly". Not named
    # ``layout``: that trait belongs to ipywidgets.DOMWidget and holds the Layout
    # widget every frontend resolves when it displays the view.
    app_layout = traitlets.Unicode("embed").tag(sync=True)
    theme = traitlets.Unicode("light").tag(sync=True)
    # Single pieces of app chrome: True shows, False hides, None keeps the app's
    # default (the layout preset and the viewer's saved settings). They become
    # URL params on the app iframe, so changing one after display reloads it.
    toolbar = traitlets.Bool(None, allow_none=True).tag(sync=True)
    layer_panel = traitlets.Bool(None, allow_none=True).tag(sync=True)
    style_panel = traitlets.Bool(None, allow_none=True).tag(sync=True)
    status_bar = traitlets.Bool(None, allow_none=True).tag(sync=True)
    # Bumped on every Python-initiated project change; echoed by the app.
    _seq = traitlets.Int(0).tag(sync=True)
    # Last error reported by the app (e.g. an invalid project).
    error = traitlets.Unicode("").tag(sync=True)
    # UI state replayed into the app whenever it loads: ``identify`` (a layer
    # id, a list of layer ids, "all", or None) and ``controls`` (a control or
    # panel name -> shown). Set through set_identify/show_control. The live
    # project does not carry it; exports write it as the project's
    # ``interaction`` block (see _project_with_ui).
    _ui = traitlets.Dict().tag(sync=True)

    def __init__(
        self,
        center: list[float] | tuple[float, float] | None = None,
        zoom: float | None = None,
        *,
        basemap: str | None = None,
        renderer: str | None = None,
        height: str = "800px",
        app_layout: str | None = None,
        layout: Any = None,
        theme: str | None = None,
        server_proxy: bool | str = "auto",
        toolbar: bool | None = None,
        layer_panel: bool | None = None,
        style_panel: bool | None = None,
        status_bar: bool | None = None,
        **kwargs: Any,
    ) -> None:
        """Create a GeoLibre map.

        Args:
            center: Initial ``[lng, lat]`` map center.
            zoom: Initial zoom level.
            basemap: A basemap name or MapLibre style URL for the background.
            renderer: ``"maplibre"`` (default), ``"cesium"``, ``"mapbox"``, or
                ``"arcgis"``. Defaults to the ``GEOLIBRE_RENDERER`` environment
                variable when set. Switch a live map with :meth:`set_renderer`.
            height: CSS height of the widget (e.g. ``"800px"``).
            app_layout: ``"embed"`` (compact UI, the default), ``"full"`` (full
                desktop UI), or ``"maponly"`` (map without chrome). Defaults to
                the ``GEOLIBRE_APP_LAYOUT`` environment variable when set.
            layout: An ``ipywidgets.Layout`` for the widget, as on any other
                ipywidgets widget. Its ``height`` overrides ``height``. Passing
                an ``app_layout`` string here is deprecated.
            theme: ``"light"`` (the default) or ``"dark"``. Defaults to the
                ``GEOLIBRE_THEME`` environment variable when set.
            server_proxy: How the browser reaches the bundled app.
                ``"auto"`` (default) serves the app directly from localhost for
                local Jupyter and VS Code, and switches to a remote-aware path
                when running under JupyterHub (detected via
                ``JUPYTERHUB_SERVICE_PREFIX``). On that path the front-end probes
                two same-origin routes and uses whichever is live: the bundled
                GeoLibre Jupyter Server extension at ``{base_url}geolibre/app/``
                (needs no ``jupyter-server-proxy`` but only registers after the
                Jupyter Server restarts) and ``jupyter-server-proxy`` at
                ``{base_url}proxy/{port}/`` (works in the running server without a
                restart). Pass ``True`` to force the remote path on any other
                remote server (Binder, remote JupyterLab), or ``False`` to force
                the direct localhost path. Google Colab is detected separately and
                always uses its own port proxy.
            toolbar: Show (``True``) or hide (``False``) the top toolbar and
                its menus. ``None`` (default) reads ``GEOLIBRE_TOOLBAR``, else
                keeps the layout's default.
            layer_panel: Show or hide the Layers panel. ``None`` reads
                ``GEOLIBRE_LAYER_PANEL``, else keeps the viewer's saved setting.
            style_panel: Show or hide the Style (symbology) panel. ``None``
                reads ``GEOLIBRE_STYLE_PANEL``, else keeps the saved setting.
            status_bar: Show or hide the bottom status bar. ``None`` reads
                ``GEOLIBRE_STATUS_BAR``, else keeps the layout's default.

                Environment variables accept ``true``/``false``, ``1``/``0``,
                ``on``/``off``, ``yes``/``no``, and ``show``/``hide``. An
                explicit argument always wins over the environment, and
                ``app_layout="maponly"`` hides all chrome whatever these say.
            **kwargs: Forwarded to ``anywidget.AnyWidget``.
        """
        if isinstance(layout, str):
            if app_layout is not None:
                raise TypeError("Pass the app chrome as app_layout only, not also as layout")
            warnings.warn(
                "Map(layout=<str>) is deprecated; use Map(app_layout=<str>). "
                "layout now holds the ipywidgets Layout.",
                DeprecationWarning,
                stacklevel=2,
            )
            app_layout, layout = layout, None
        # Name the environment variable in the error when the value came from it.
        layout_source = "app_layout"
        if app_layout is None:
            app_layout = os.environ.get(APP_LAYOUT_ENV, "").strip().lower()
            layout_source = APP_LAYOUT_ENV if app_layout else layout_source
            app_layout = app_layout or "embed"
        theme_source = "theme"
        if theme is None:
            theme = os.environ.get(THEME_ENV, "").strip().lower()
            theme_source = THEME_ENV if theme else theme_source
            theme = theme or "light"
        renderer_source = "renderer"
        if renderer is None:
            renderer = os.environ.get(RENDERER_ENV, "").strip().lower()
            renderer_source = RENDERER_ENV if renderer else renderer_source
            renderer = renderer or "maplibre"
        if renderer not in _VALID_RENDERERS:
            raise ValueError(
                f"{renderer_source} must be one of {sorted(_VALID_RENDERERS)}, got {renderer!r}"
            )
        chrome = _resolve_chrome(
            {
                "toolbar": toolbar,
                "layer_panel": layer_panel,
                "style_panel": style_panel,
                "status_bar": status_bar,
            }
        )
        if app_layout not in _VALID_LAYOUTS:
            raise ValueError(
                f"{layout_source} must be one of {sorted(_VALID_LAYOUTS)}, got {app_layout!r}"
            )
        if theme not in _VALID_THEMES:
            raise ValueError(
                f"{theme_source} must be one of {sorted(_VALID_THEMES)}, got {theme!r}"
            )
        if layout is not None:
            kwargs["layout"] = layout
        super().__init__(**kwargs)
        self.height = height
        self.app_layout = app_layout
        self.theme = theme
        for key, value in chrome.items():
            setattr(self, key, value)
        self._watch_layout_height(self.layout)
        self._remote_mode = self._resolve_remote_mode(server_proxy)
        # Always start the localhost bundle server. Locally it is the app origin;
        # under "remote" it backs the jupyter-server-proxy route (and serves the
        # same directory the Jupyter Server extension exposes), so the front-end
        # has a live target whether or not the extension has been loaded yet.
        self._app_url = serve_app(_STATIC_APP)
        self._app_port = app_port() or 0
        self.project = _project.build_empty_project(
            center=center,
            zoom=zoom,
            basemap_url=resolve_basemap(basemap) if basemap else None,
            renderer=renderer,
        )
        # Scripting RPC state. Command/result and event traffic ride anywidget's
        # custom message channel (self.send / on_msg), kept off the project trait
        # so the project sync loop guard is untouched. `_pending` maps an
        # in-flight requestId to its result slot; `_event_handlers` maps an event
        # name to its registered callbacks.
        self._pending: dict[str, dict[str, Any]] = {}
        self._event_handlers: dict[str, list[Callable[[Any], None]]] = {}
        # GeoTIFFs materialized from in-memory xarray objects must remain on
        # disk while the widget is alive because the app reads them lazily via
        # HTTP Range requests.
        self._temporary_rasters: list[pathlib.Path] = []
        # ``close()`` is easy to forget, so the same list is handed to a
        # finalizer, which weakref runs when the Map is collected and, because
        # ipywidgets keeps widgets referenced until then, at interpreter exit.
        # ``close()`` clears the list in place rather than rebinding it, so this
        # finalizer stays valid for anything materialized afterwards.
        self._raster_cleanup = weakref.finalize(
            self, _remove_temporary_rasters, self._temporary_rasters
        )
        self.on_msg(self._on_custom_msg)

    def _watch_layout_height(self, layout: Any) -> None:
        """Follow a Layout widget's height, applying the one it already has.

        ipywidgets sizes only the view's outer element from the Layout. The app
        iframe inside it is sized by the ``height`` trait, so without this
        ``m.layout.height = "100%"`` would leave the map at its old height.

        Args:
            layout: The ``ipywidgets.Layout`` now assigned to this widget.
        """
        layout.observe(self._on_layout_height, "height")
        if layout.height:
            self.height = layout.height

    def _on_layout_height(self, change: dict[str, Any]) -> None:
        """Copy a Layout height change onto the ``height`` trait.

        Args:
            change: The traitlets change notification. Clearing the Layout's
                height leaves the current ``height`` in place.
        """
        if change["new"]:
            self.height = change["new"]

    @traitlets.observe("layout")
    def _on_layout_replaced(self, change: dict[str, Any]) -> None:
        """Move the height watcher when ``m.layout`` is assigned a new Layout.

        Args:
            change: The traitlets change notification for the ``layout`` trait.
        """
        old = change["old"]
        if old is not None and old is not traitlets.Undefined:
            old.unobserve(self._on_layout_height, "height")
        self._watch_layout_height(change["new"])

    def close(self) -> None:
        """Close the widget and remove rasters materialized from xarray data."""
        try:
            # The Layout outlives this widget in the ipywidgets registry, so its
            # observer would otherwise keep a closed Map alive. traitlets raises
            # ValueError once it is gone, as on a repeated close(). Read the stored
            # value: a rejected constructor reaches here through __del__, and
            # self.layout would create a new Layout widget just to discard it.
            layout = self._trait_values.get("layout")
            if layout is not None:
                with contextlib.suppress(ValueError):
                    layout.unobserve(self._on_layout_height, "height")
            super().close()
        finally:
            _remove_temporary_rasters(getattr(self, "_temporary_rasters", []))

    @staticmethod
    def _running_on_colab() -> bool:
        """Return True when running inside a Google Colab kernel."""
        try:
            import google.colab  # noqa: F401
        except ImportError:
            return False
        return True

    @staticmethod
    def _resolve_remote_mode(server_proxy: bool | str) -> str:
        """Decide how the front-end reaches the bundled app.

        Args:
            server_proxy: ``True`` to force the remote path (the front-end probes
                the server-extension and jupyter-server-proxy routes) on any
                remote server, ``False`` to force the direct localhost path, or
                ``"auto"`` to use the remote path only when a JupyterHub
                single-user server is detected (via the
                ``JUPYTERHUB_SERVICE_PREFIX`` environment variable).

        Returns:
            ``"remote"`` to have the front-end probe the server-extension and
            jupyter-server-proxy routes, or ``""`` for the direct localhost path.
        """
        if isinstance(server_proxy, bool):
            mode = "remote" if server_proxy else ""
        elif server_proxy == "auto":
            mode = "remote" if os.environ.get("JUPYTERHUB_SERVICE_PREFIX") else ""
        else:
            raise ValueError("server_proxy must be True, False, or 'auto'")
        # Google Colab reaches the app through its own port proxy (resolved in
        # the front-end), which needs the localhost server running and a
        # populated _app_port. Never route Colab through the remote path, even
        # when server_proxy=True is passed explicitly.
        if mode == "remote" and Map._running_on_colab():
            return ""
        return mode

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

    # -- scripting RPC ---------------------------------------------------

    async def request_async(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 10.0,
    ) -> Any:
        """Send a command to the running app and asynchronously await its reply.

        Async counterpart of :meth:`request`, with the same command set,
        arguments, return value, and errors. Because awaiting suspends the
        coroutine instead of blocking a thread, this works on the thread
        running the asyncio event loop that delivers the reply -- e.g.
        directly inside an async Shiny for Python observer or
        ``reactive.extended_task``, with no worker thread and no
        ``jupyter_ui_poll`` pumping. It also works with top-level ``await``
        in Jupyter.

        Args:
            method: The command name (e.g. ``"getCenter"``).
            params: Command parameters.
            timeout: Seconds to wait for the reply.

        Returns:
            The command's result value.

        Raises:
            TimeoutError: If the app does not reply in time.
            RuntimeError: If the app reports the command failed.
        """
        loop = asyncio.get_running_loop()
        request_id = uuid.uuid4().hex
        slot: dict[str, Any] = {
            "done": False,
            "ok": False,
            "value": None,
            "error": None,
            "future": loop.create_future(),
        }
        try:
            # Register and send inside the try so a failing send() still cleans
            # up the slot in finally.
            self._pending[request_id] = slot
            self.send(
                {
                    "type": "geolibre:command",
                    "requestId": request_id,
                    "method": method,
                    "params": params or {},
                }
            )
            await asyncio.wait_for(slot["future"], timeout)
        except TimeoutError:
            raise TimeoutError(
                f"GeoLibre command {method!r} timed out after {timeout}s. "
                "The map must be displayed and loaded before it can "
                "answer; show the map, then retry or pass a larger "
                "timeout=."
            ) from None
        finally:
            self._pending.pop(request_id, None)
        if not slot["ok"]:
            raise RuntimeError(slot["error"] or f"GeoLibre command {method!r} failed")
        return slot["value"]

    # -- live queries / view --------------------------------------------

    async def get_view_async(self, *, timeout: float = 10.0) -> dict[str, Any]:
        """Async variant of :meth:`get_view`; see :meth:`request_async`."""
        return await self.request_async("getView", timeout=timeout)

    async def get_center_async(self, *, timeout: float = 10.0) -> list[float]:
        """Async variant of :meth:`get_center`; see :meth:`request_async`."""
        return await self.request_async("getCenter", timeout=timeout)

    async def get_bounds_async(self, *, timeout: float = 10.0) -> list[float]:
        """Async variant of :meth:`get_bounds`; see :meth:`request_async`."""
        return await self.request_async("getBounds", timeout=timeout)

    async def fly_to_async(
        self,
        lng: float | None = None,
        lat: float | None = None,
        *,
        zoom: float | None = None,
        bearing: float | None = None,
        pitch: float | None = None,
        duration: float | None = None,
        timeout: float = 10.0,
    ) -> None:
        """Async variant of :meth:`fly_to`; see :meth:`request_async`."""
        await self.request_async(
            "flyTo",
            self._fly_to_params(lng, lat, zoom, bearing, pitch, duration),
            timeout=timeout,
        )

    async def fit_bounds_async(
        self,
        bounds: list[float] | tuple[float, float, float, float],
        *,
        timeout: float = 10.0,
    ) -> None:
        """Async variant of :meth:`fit_bounds`; see :meth:`request_async`."""
        values = self._validate_bounds(bounds)
        await self.request_async("fitBounds", {"bounds": values}, timeout=timeout)

    async def zoom_to_bounds_async(
        self,
        bounds: list[float] | tuple[float, float, float, float],
        *,
        timeout: float = 10.0,
    ) -> None:
        """Async variant of :meth:`zoom_to_bounds`; see :meth:`request_async`."""
        await self.fit_bounds_async(bounds, timeout=timeout)

    async def zoom_to_layer_async(self, layer: str | Layer, *, timeout: float = 10.0) -> None:
        """Async variant of :meth:`zoom_to_layer`; see :meth:`request_async`."""
        resolved = self._resolve_layer(layer)
        await self.request_async("zoomToLayer", {"layerId": resolved.id}, timeout=timeout)

    async def identify_async(
        self,
        lng: float,
        lat: float,
        *,
        layer_id: str | None = None,
        timeout: float = 10.0,
    ) -> list[dict[str, Any]]:
        """Async variant of :meth:`identify`; see :meth:`request_async`."""
        params: dict[str, Any] = {"lngLat": [float(lng), float(lat)]}
        if layer_id is not None:
            params["layerId"] = layer_id
        return await self.request_async("identify", params, timeout=timeout)

    async def get_features_async(self, layer_id: str, *, timeout: float = 10.0) -> list[Feature]:
        """Async variant of :meth:`get_features`; see :meth:`request_async`."""
        features = await self.request_async(
            "getLayerFeatures", {"layerId": layer_id}, timeout=timeout
        )
        return self._wrap_features(features)

    async def get_selected_features_async(
        self, *, as_gdf: bool = False, timeout: float = 10.0
    ) -> list[Feature] | Any:
        """Async variant of :meth:`get_selected_features`; see :meth:`request_async`."""
        features = await self.request_async("getSelectedFeatures", timeout=timeout)
        feats = self._wrap_features(features)
        return self._features_to_gdf(feats) if as_gdf else feats

    async def get_drawn_features_async(
        self, *, as_gdf: bool = False, timeout: float = 10.0
    ) -> list[Feature] | Any:
        """Async variant of :meth:`get_drawn_features`; see :meth:`request_async`."""
        features = await self.request_async("getDrawnFeatures", timeout=timeout)
        feats = self._wrap_features(features)
        return self._features_to_gdf(feats) if as_gdf else feats

    async def list_algorithms_async(self, *, timeout: float = 10.0) -> list[dict[str, Any]]:
        """Async variant of :meth:`list_algorithms`; see :meth:`request_async`."""
        return await self.request_async("listAlgorithms", timeout=timeout)

    async def run_algorithm_async(
        self,
        algorithm_id: str,
        parameters: dict[str, Any] | None = None,
        *,
        timeout: float = 120.0,
    ) -> dict[str, Any]:
        """Async variant of :meth:`run_algorithm`; see :meth:`request_async`."""
        return await self.request_async(
            "runAlgorithm",
            {"id": algorithm_id, "params": parameters or {}},
            timeout=timeout,
        )

    async def run_model_builder_async(
        self,
        graph: dict[str, Any],
        *,
        timeout: float = 600.0,
    ) -> dict[str, Any]:
        """Async variant of :meth:`run_model_builder`; see :meth:`request_async`."""
        return await self.request_async("runModelBuilder", {"graph": graph}, timeout=timeout)

    async def list_whitebox_tools_async(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        """Async variant of :meth:`list_whitebox_tools`; see :meth:`request_async`."""
        return await self.request_async("listWhiteboxTools", timeout=timeout)

    async def run_whitebox_tool_async(
        self,
        tool_id: str,
        parameters: dict[str, Any] | None = None,
        *,
        timeout: float = 300.0,
    ) -> dict[str, Any]:
        """Async variant of :meth:`run_whitebox_tool`; see :meth:`request_async`."""
        resolved = self._resolve_tool_params(parameters)
        return await self.request_async(
            "runWhiteboxTool",
            {"id": str(tool_id), "params": resolved},
            timeout=timeout,
        )

    async def to_image_async(
        self, path: str | None = None, *, timeout: float = 30.0
    ) -> bytes | None:
        """Async variant of :meth:`to_image`; see :meth:`request_async`."""
        data_url = await self.request_async("toImage", timeout=timeout)
        return self._png_from_data_url(data_url, path)

    def to_html(
        self,
        path: str | None = None,
        *,
        title: str = "GeoLibre Map",
        width: str = "100%",
        height: str | None = None,
        app_url: str | None = None,
    ) -> str | None:
        """Export the current map as a standalone HTML page.

        The page embeds the GeoLibre app in an ``<iframe>`` and injects the
        current project into it over the same ``postMessage`` bridge the widget
        uses, so it renders the map exactly as configured here, in this map's
        :attr:`app_layout`, :attr:`theme`, and chrome toggles (such as
        :attr:`toolbar` and :attr:`layer_panel`). Unlike
        :meth:`to_image` this needs no running kernel to view; by default it
        loads the hosted GeoLibre app over the network so the file stays
        portable.

        Args:
            path: If given, write the HTML here (parent dirs are created) and
                return ``None``. Otherwise return the HTML string.
            title: The exported page's ``<title>``.
            width: CSS width of the embedded map (e.g. ``"100%"`` or ``"800px"``).
            height: CSS height of the embedded map; defaults to this map's
                :attr:`height`.
            app_url: Base URL of the GeoLibre app to embed. Defaults to the
                hosted viewer so the export is portable. Pass a self-hosted
                deployment URL to pin a specific version, or this map's live
                ``_app_url`` to embed the session-bound localhost bundle.

        Returns:
            The HTML string, or ``None`` when written to ``path``.

        Note:
            Layers backed by kernel-side local files (e.g. a local GeoTIFF added
            via :meth:`add_cog`) are served only for this kernel session, so the
            exported page cannot reach them once the kernel stops. Use hosted
            URLs or tile sources for a fully self-contained export.
        """
        html = render_project_html(
            self._project_with_ui(copy.deepcopy(self.project)),
            title=title,
            width=width,
            height=height or self.height,
            app_url=app_url,
            layout=self.app_layout,
            theme=self.theme,
            chrome={key: getattr(self, key) for key in CHROME_TOGGLES},
        )
        if path is not None:
            out = pathlib.Path(path).expanduser()
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(html, encoding="utf-8")
            return None
        return html

    # -- markers ---------------------------------------------------------

    @staticmethod
    def _point_feature(
        lng: float,
        lat: float,
        properties: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build a GeoJSON point Feature at ``[lng, lat]`` with ``properties``."""
        return {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(lng), float(lat)]},
            "properties": dict(properties or {}),
        }

    @staticmethod
    def _points_to_featurecollection(points: Any) -> dict[str, Any]:
        """Coerce assorted point inputs into a GeoJSON point FeatureCollection.

        Accepts the same forms as :meth:`add_geojson` (a FeatureCollection /
        Feature / geometry dict, a GeoJSON string, or a ``__geo_interface__``
        object such as a GeoDataFrame), plus a sequence of ``(lng, lat)`` pairs
        or ``{"lng"/"lon"/"x", "lat"/"y", **properties}`` mappings for the common
        "just give me a list of coordinates" case.

        Args:
            points: The point input in one of the supported forms.

        Returns:
            A GeoJSON FeatureCollection dict of point features.

        Raises:
            ValueError: If a sequence entry is not a coordinate pair or a mapping
                with longitude/latitude keys, or if a GeoJSON/geo-interface input
                carries a non-point geometry (the marker APIs are point-only).
        """
        # Defer dict / GeoJSON-string / __geo_interface__ inputs to the shared
        # loader so a GeoDataFrame of points or a FeatureCollection works as-is.
        if hasattr(points, "__geo_interface__") or isinstance(points, (dict, str)):
            fc = _project.load_featurecollection(points)
            # The marker APIs are point-only; reject other geometries rather than
            # silently rendering polygons/lines through a "markers" layer.
            for feature in fc.get("features", []):
                geometry = feature.get("geometry") if isinstance(feature, dict) else None
                geometry_type = geometry.get("type") if isinstance(geometry, dict) else None
                if geometry_type not in ("Point", "MultiPoint"):
                    raise ValueError(
                        "add_markers requires Point/MultiPoint geometries; got "
                        f"{geometry_type!r}. Use add_geojson for other geometries."
                    )
            return fc

        features: list[dict[str, Any]] = []
        for entry in points:
            if isinstance(entry, dict):
                lng = entry.get("lng", entry.get("lon", entry.get("x")))
                lat = entry.get("lat", entry.get("y"))
                if lng is None or lat is None:
                    raise ValueError(
                        "Point mapping needs longitude (lng/lon/x) and latitude "
                        f"(lat/y) keys; got {sorted(entry)}"
                    )
                props = {
                    key: value
                    for key, value in entry.items()
                    if key not in ("lng", "lon", "x", "lat", "y")
                }
                features.append(Map._point_feature(lng, lat, props))
            else:
                pair = list(entry)
                if len(pair) != 2:
                    raise ValueError(f"Point must be a (lng, lat) pair; got {entry!r}")
                features.append(Map._point_feature(pair[0], pair[1]))
        return {"type": "FeatureCollection", "features": features}

    # -- choropleth ------------------------------------------------------

    def add_arcgis_vector_tile_layer(
        self,
        url: str,
        name: str | None = None,
        *,
        bounds: list[float] | None = None,
        attribution: str | None = None,
    ) -> str:
        """Add an ArcGIS VectorTileServer with the service's own style.

        The service description and its default style are read now and stored
        on the layer the way the app's ArcGIS plugin saves one, so the project
        opens with the service's cartography. Reads are limited to 2 MiB
        (description) and 8 MiB (style) with a 30-second deadline each. Styles
        the app cannot draw are refused. Tokens and portal items are not
        supported.

        Args:
            url: The ``.../VectorTileServer`` URL.
            name: Layer display name; defaults to the service name.
            bounds: ``[west, south, east, north]`` extent for "Zoom to layer",
                instead of the style's or service's extent.
            attribution: Attribution text instead of the service credit.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.arcgis_vector_tile_layer(url, name, bounds=bounds, attribution=attribution)
        )

    # -- view / basemap API ---------------------------------------------

    @property
    def name(self) -> str:
        """The project name."""
        return str(self.project.get("name", ""))

    @name.setter
    def name(self, value: str) -> None:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("name must be a non-empty string")
        self._update_project(lambda p: p.update(name=value.strip()))

    # -- interaction: identify, controls, projection ---------------------

    def _set_ui(self, **changes: Any) -> None:
        """Merge ``changes`` into the synced ``_ui`` trait.

        Like :meth:`_update_project`, this reassigns a new dict, because
        traitlets only syncs a changed value, not an in-place edit.

        Args:
            **changes: ``identify`` and/or ``controls`` entries to replace.
        """
        self._ui = {**self._ui, **changes}

    def _project_with_ui(self, project: dict[str, Any]) -> dict[str, Any]:
        """Write the Identify and control state into ``project`` for export.

        :meth:`set_identify` and :meth:`show_control` keep their state out of
        the live project so a project push never reopens a panel the user
        closed. A saved or exported project has no kernel to replay it, so it
        carries the state as its ``interaction`` block, which the app applies
        when the project opens.

        Args:
            project: A detached project dict, modified in place.

        Returns:
            ``project``, for chaining.
        """
        interaction: dict[str, Any] = {}
        identify = self._ui.get("identify")
        if identify is not None:
            interaction["identify"] = list(identify) if isinstance(identify, list) else identify
        controls = self._ui.get("controls")
        if controls:
            interaction["controls"] = copy.deepcopy(controls)
        if interaction:
            project["interaction"] = interaction
        return project

    # -- map controls: split map / legend / colorbar --------------------

    @staticmethod
    def _coerce_layer_ids(value: Any) -> list[str]:
        """Coerce a layer-id input into a list of layer-id strings.

        Accepts ``None`` (empty), a single layer id string, a :class:`Layer`, or
        an iterable of those. The literal ``"__basemap__"`` is a valid id (the
        basemap entry the swipe control recognizes).

        Args:
            value: The layer input in one of the supported forms.

        Returns:
            A list of layer-id strings.

        Raises:
            ValueError: If ``value`` (or an entry within it) is neither a string
                nor a :class:`Layer`.
        """
        if value is None:
            return []
        if isinstance(value, (str, Layer)):
            value = [value]
        elif not isinstance(value, (list, tuple)):
            # A bare non-iterable (e.g. split_map(123)) would raise an opaque
            # TypeError from the loop below; surface the documented ValueError.
            raise ValueError(
                "Layer reference must be a layer id string, a Layer, or a list "
                f"of those; got {value!r}"
            )
        ids: list[str] = []
        for entry in value:
            if isinstance(entry, Layer):
                ids.append(entry.id)
            elif isinstance(entry, str):
                ids.append(entry)
            else:
                raise ValueError(
                    f"Layer reference must be a layer id string or a Layer; got {entry!r}"
                )
        return ids

    # -- project I/O -----------------------------------------------------

    def to_project(self, *, keep_credentials: bool = False) -> dict[str, Any]:
        """Return a detached project dict.

        Credentials are removed by default so a returned project is safe to
        serialize or commit. Pass ``keep_credentials=True`` only for a trusted
        local workflow that must preserve authenticated layer configuration.

        The Identify target and control visibility set with
        :meth:`set_identify` and :meth:`show_control` are included as the
        project's ``interaction`` block.
        """
        if keep_credentials:
            return self._project_with_ui(copy.deepcopy(self.project))
        return self._project_with_ui(_project.redact_credentials(self.project))

    def load_project(self, source: Any) -> None:
        """Replace the current project.

        Args:
            source: A project dict, a JSON string, or a path to a
                ``.geolibre.json`` file.

        Raises:
            ValueError: If the source is not valid JSON or an existing file, or
                if the project is not a dict or is missing required top-level
                keys (``version``, ``name``, ``mapView``).
        """
        if isinstance(source, dict):
            project = copy.deepcopy(source)
        else:
            text = str(source)
            project = None
            if text.strip().startswith("{"):
                try:
                    project = json.loads(text)
                except json.JSONDecodeError:
                    # Looks like JSON but isn't; it may be a path that begins
                    # with "{" (e.g. `{backup}/map.json`), so fall through to
                    # the file-read branch below.
                    project = None
            if project is None:
                path = pathlib.Path(text).expanduser()
                try:
                    project = json.loads(path.read_text(encoding="utf-8"))
                except FileNotFoundError as exc:
                    # Honour the documented ValueError contract instead of
                    # leaking a raw FileNotFoundError/JSONDecodeError.
                    raise ValueError(
                        f"Project source is not valid JSON nor an existing file: {text}"
                    ) from exc
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Invalid project JSON in file {text}: {exc}") from exc
        # Validate the required keys up front (matching parseProject in
        # @geolibre/core) so an invalid project raises here instead of failing
        # silently in the app and only surfacing through the `error` trait.
        if not isinstance(project, dict):
            raise ValueError("Project must be a JSON object")
        missing = {"version", "name", "mapView"} - project.keys()
        if missing:
            raise ValueError(f"Invalid project: missing required keys {sorted(missing)}")
        # Presence isn't enough: set_center et al. index into mapView, so a
        # non-dict here would surface as a confusing TypeError later.
        if not isinstance(project.get("mapView"), dict):
            raise ValueError("Invalid project: 'mapView' must be an object")
        # The app defaults a missing `layers` to [], but the Map API mutates
        # project["layers"] directly (add_*/remove_layer), so backfill it and
        # reject a non-list to avoid a later KeyError / type error.
        layers = project.get("layers")
        if layers is None:
            project["layers"] = []
        elif not isinstance(layers, list):
            raise ValueError("Invalid project: 'layers' must be a list")
        layer_ids = {layer.get("id") for layer in project["layers"] if isinstance(layer, dict)}
        # A saved project carries its Identify target and controls as an
        # `interaction` block. Move it into `_ui`, which is what the widget
        # replays, so the live project never carries a second copy that a
        # project push would re-apply.
        interaction = project.pop("interaction", None)
        # A pinned Identify target belongs to the project being replaced, so
        # drop it unless the incoming project still has that layer. Leaving it
        # would replay `setIdentify` for a missing layer on the next sync, which
        # the front end rejects into a reply nobody reads -- Identify would end
        # up disarmed anyway, just via a stray error. "all" and None survive any
        # project, as in `clear_layers`.
        self._drop_identify_layers(lambda layer_id: layer_id not in layer_ids)
        self._seq += 1
        self.project = project
        if isinstance(interaction, dict):
            self._apply_interaction(interaction, layer_ids)

    def _apply_interaction(self, interaction: dict[str, Any], layer_ids: set[Any]) -> None:
        """Load a saved project's ``interaction`` block into ``_ui``.

        Entries the app would ignore are skipped rather than raised on: the
        block may come from a hand-edited file or a newer app version.

        Args:
            interaction: The project's ``interaction`` block.
            layer_ids: Ids of the layers in the loaded project.
        """
        changes: dict[str, Any] = {}
        if "identify" in interaction:
            identify = interaction["identify"]
            if identify is None or identify == "all":
                changes["identify"] = identify
            else:
                raw = [identify] if isinstance(identify, str) else identify
                ids = (
                    list(dict.fromkeys(i for i in raw if i in layer_ids))
                    if isinstance(raw, list)
                    else []
                )
                changes["identify"] = ids[0] if len(ids) == 1 else (ids or None)
        controls = interaction.get("controls")
        if isinstance(controls, dict):
            changes["controls"] = {
                **self._ui.get("controls", {}),
                **{
                    name: dict(shown) if isinstance(shown, dict) else shown
                    for name, shown in controls.items()
                    if (name in MAP_PANELS or name in MAP_CONTROLS)
                    and (
                        isinstance(shown, bool)
                        or (isinstance(shown, dict) and isinstance(shown.get("visible"), bool))
                    )
                },
            }
        if changes:
            self._set_ui(**changes)

    def save_project(self, path: str, *, keep_credentials: bool = False) -> None:
        """Write the current project to a ``.geolibre.json`` file.

        Like :meth:`to_project`, the file carries the Identify target and
        control visibility as its ``interaction`` block.

        Args:
            path: Destination file path. Parent directories are created if
                they do not already exist.
            keep_credentials: Preserve credentials for a trusted local file.
                Defaults to ``False`` so saved projects are safe to share.
        """
        out = pathlib.Path(path).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        project = self.to_project(keep_credentials=keep_credentials)
        out.write_text(json.dumps(project, indent=2), encoding="utf-8")
