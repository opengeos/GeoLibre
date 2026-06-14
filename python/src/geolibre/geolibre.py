"""The GeoLibre Jupyter widget and its leafmap-style Python API."""

from __future__ import annotations

import base64
import copy
import json
import os
import pathlib
import time
import uuid
import warnings
from typing import Any, Callable

import anywidget
import traitlets

from . import project as _project
from ._server import app_port, serve_app
from .basemaps import resolve_basemap

_HERE = pathlib.Path(__file__).parent
_STATIC_APP = _HERE / "static" / "app"

# Accepted values for the constructor's layout/theme args, validated up front so
# a typo surfaces immediately instead of silently falling back in the front-end.
_VALID_LAYOUTS = frozenset({"embed", "full", "maponly"})
_VALID_THEMES = frozenset({"light", "dark"})


def _read_local_vector(path: Any, data_format: str | None = None) -> dict[str, Any]:
    """Read a local vector file into a GeoJSON FeatureCollection via GeoPandas.

    The browser cannot read a file that lives on the kernel host, so a local
    vector dataset is read here and inlined as GeoJSON (reprojected to EPSG:4326)
    instead of being streamed by the in-browser vector control. GeoPandas is an
    optional dependency, imported lazily so the rest of the API works without it.

    Args:
        path: Filesystem path to a vector file (Shapefile, GeoParquet,
            FlatGeobuf, GeoPackage, ...).
        data_format: Optional format hint (e.g. ``"parquet"``) that overrides
            filename-suffix detection, so a GeoParquet file saved under a
            non-standard name still uses the dedicated Parquet reader.

    Returns:
        A GeoJSON FeatureCollection dict in EPSG:4326.

    Raises:
        ValueError: If the file does not exist or, after conversion to GeoJSON,
            exceeds the 50 MB size limit.
        ImportError: If GeoPandas is not installed.
    """
    file_path = pathlib.Path(str(path)).expanduser()
    if not file_path.exists():
        raise ValueError(f"Vector file not found: {path}")
    try:
        import geopandas
    except ImportError as exc:
        raise ImportError(
            "Reading a local vector file requires GeoPandas. Install it with "
            "`pip install geopandas`, or pass a URL to a hosted dataset instead."
        ) from exc
    # GeoPandas' GDAL-backed read_file may lack the Parquet driver depending on
    # the GDAL build, so dispatch (Geo)Parquet to the dedicated reader. Honour an
    # explicit format hint so a Parquet file under a non-standard name still works.
    is_parquet = (data_format or "").lower() in ("parquet", "geoparquet") or (
        file_path.suffix.lower() in (".parquet", ".geoparquet", ".pq")
    )
    if is_parquet:
        gdf = geopandas.read_parquet(file_path)
    else:
        gdf = geopandas.read_file(file_path)
    if gdf.crs is not None:
        gdf = gdf.to_crs(epsg=4326)
    # Round-trip through GeoPandas' own GeoJSON writer so numpy/datetime property
    # values become plain JSON the widget bus can serialize.
    geojson = gdf.to_json()
    # Cap the inlined payload like load_featurecollection does for URL/file
    # GeoJSON; a format like Shapefile can expand sharply once converted.
    if len(geojson.encode("utf-8")) > _project._MAX_GEOJSON_BYTES:
        raise ValueError(
            f"Vector file exceeds the 50 MB GeoJSON size limit after conversion: {path}"
        )
    return json.loads(geojson)


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
        height: str = "800px",
        layout: str = "embed",
        theme: str = "light",
        server_proxy: bool | str = "auto",
        **kwargs: Any,
    ) -> None:
        """Create a GeoLibre map.

        Args:
            center: Initial ``[lng, lat]`` map center.
            zoom: Initial zoom level.
            basemap: A basemap name or MapLibre style URL for the background.
            height: CSS height of the widget (e.g. ``"800px"``).
            layout: ``"embed"`` (compact UI), ``"full"`` (full desktop UI), or
                ``"maponly"`` (map without chrome).
            theme: ``"light"`` or ``"dark"``.
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
            **kwargs: Forwarded to ``anywidget.AnyWidget``.
        """
        if layout not in _VALID_LAYOUTS:
            raise ValueError(
                f"layout must be one of {sorted(_VALID_LAYOUTS)}, got {layout!r}"
            )
        if theme not in _VALID_THEMES:
            raise ValueError(
                f"theme must be one of {sorted(_VALID_THEMES)}, got {theme!r}"
            )
        super().__init__(**kwargs)
        self.height = height
        self.layout = layout
        self.theme = theme
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
        )
        # Scripting RPC state. Command/result and event traffic ride anywidget's
        # custom message channel (self.send / on_msg), kept off the project trait
        # so the project sync loop guard is untouched. `_pending` maps an
        # in-flight requestId to its result slot; `_event_handlers` maps an event
        # name to its registered callbacks.
        self._pending: dict[str, dict[str, Any]] = {}
        self._event_handlers: dict[str, list[Callable[[Any], None]]] = {}
        self.on_msg(self._on_custom_msg)

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

    def _on_custom_msg(
        self, _widget: Any, content: Any, _buffers: Any
    ) -> None:
        """Handle out-of-band messages from the app (results and events).

        Args:
            _widget: The widget instance (unused; required by the on_msg API).
            content: The decoded message payload.
            _buffers: Binary buffers (unused).
        """
        if not isinstance(content, dict):
            return
        msg_type = content.get("type")
        if msg_type == "geolibre:result":
            slot = self._pending.get(content.get("requestId"))
            if slot is None:
                # A reply for a request that already timed out / was cleaned up.
                return
            slot["ok"] = bool(content.get("ok"))
            slot["value"] = content.get("value")
            slot["error"] = content.get("error")
            slot["done"] = True
        elif msg_type == "geolibre:event":
            self._dispatch_event(content.get("event"), content.get("payload"))

    def _dispatch_event(self, event: Any, payload: Any) -> None:
        """Invoke every callback registered for an event, isolating failures."""
        for handler in list(self._event_handlers.get(event, ())):
            try:
                handler(payload)
            except Exception as exc:  # noqa: BLE001 - never let one callback kill the bus
                warnings.warn(
                    f"GeoLibre event handler for {event!r} raised: {exc}",
                    stacklevel=2,
                )

    @staticmethod
    def _wait_for_result(
        slot: dict[str, Any], method: str, timeout: float
    ) -> None:
        """Block the kernel until a result slot resolves or the timeout elapses.

        Jupyter comms are asynchronous, so the kernel must keep processing
        incoming messages while the calling cell blocks. ``jupyter_ui_poll``
        pumps the kernel's event loop re-entrantly (handling the ipykernel
        version differences) so the ``on_msg`` reply lands and fills the slot.

        Args:
            slot: The pending request slot, resolved in place by ``_on_custom_msg``.
            method: Command name, for error messages.
            timeout: Seconds to wait before giving up.

        Raises:
            TimeoutError: If no reply arrives within ``timeout`` seconds.
            RuntimeError: If ``jupyter_ui_poll`` is not installed.
        """
        try:
            from jupyter_ui_poll import ui_events
        except ImportError as exc:
            raise RuntimeError(
                "Interactive GeoLibre queries require the 'jupyter_ui_poll' "
                "package. Install it with `pip install jupyter_ui_poll`."
            ) from exc
        deadline = time.monotonic() + timeout
        with ui_events() as poll:
            while not slot["done"]:
                poll(10)
                if slot["done"]:
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError(
                        f"GeoLibre command {method!r} timed out after {timeout}s. "
                        "The map must be displayed and loaded before it can "
                        "answer; show the map, then retry or pass a larger "
                        "timeout=."
                    )
                time.sleep(0.01)

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 10.0,
    ) -> Any:
        """Send a command to the running app and block for its reply.

        This is the low-level primitive behind the query/processing methods; call
        it directly to reach a command without a dedicated wrapper.

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
        request_id = uuid.uuid4().hex
        slot: dict[str, Any] = {
            "done": False,
            "ok": False,
            "value": None,
            "error": None,
        }
        self._pending[request_id] = slot
        self.send(
            {
                "type": "geolibre:command",
                "requestId": request_id,
                "method": method,
                "params": params or {},
            }
        )
        try:
            self._wait_for_result(slot, method, timeout)
        finally:
            self._pending.pop(request_id, None)
        if not slot["ok"]:
            raise RuntimeError(
                slot["error"] or f"GeoLibre command {method!r} failed"
            )
        return slot["value"]

    def on(
        self, event: str, callback: Callable[[Any], None]
    ) -> Callable[[], None]:
        """Register a callback for an app event.

        Events are delivered when the map is displayed and the user interacts
        with it. The known events are ``"click"`` (payload
        ``{"lngLat": [lng, lat], "features": [...]}``), ``"selection-change"``
        (``{"layerId", "featureId"}``), and ``"layer-change"``
        (``{"layerIds": [...]}``).

        Args:
            event: The event name.
            callback: Called with the event payload.

        Returns:
            A function that unregisters this callback.
        """
        self._event_handlers.setdefault(event, []).append(callback)

        def _off() -> None:
            handlers = self._event_handlers.get(event)
            if handlers and callback in handlers:
                handlers.remove(callback)

        return _off

    def on_click(self, callback: Callable[[Any], None]) -> Callable[[], None]:
        """Register a callback fired when the user clicks the map."""
        return self.on("click", callback)

    def on_selection_change(
        self, callback: Callable[[Any], None]
    ) -> Callable[[], None]:
        """Register a callback fired when the selected layer/feature changes."""
        return self.on("selection-change", callback)

    def on_layer_change(
        self, callback: Callable[[Any], None]
    ) -> Callable[[], None]:
        """Register a callback fired when layers are added or removed."""
        return self.on("layer-change", callback)

    # -- live queries / view --------------------------------------------

    def get_view(self, *, timeout: float = 10.0) -> dict[str, Any]:
        """Return the live camera ``{center, zoom, bearing, pitch, bbox}``."""
        return self.request("getView", timeout=timeout)

    def get_center(self, *, timeout: float = 10.0) -> list[float]:
        """Return the live map center as ``[lng, lat]``."""
        return self.request("getCenter", timeout=timeout)

    def get_bounds(self, *, timeout: float = 10.0) -> list[float]:
        """Return the live viewport bounds as ``[west, south, east, north]``."""
        return self.request("getBounds", timeout=timeout)

    def fly_to(
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
        """Animate the camera. Only the provided fields change.

        Args:
            lng: Target longitude (pass with ``lat`` to recenter).
            lat: Target latitude.
            zoom: Target zoom level.
            bearing: Target bearing in degrees.
            pitch: Target pitch in degrees.
            duration: Animation duration in milliseconds.
            timeout: Seconds to wait for acknowledgement.
        """
        params: dict[str, Any] = {}
        if lng is not None and lat is not None:
            params["center"] = [float(lng), float(lat)]
        if zoom is not None:
            params["zoom"] = float(zoom)
        if bearing is not None:
            params["bearing"] = float(bearing)
        if pitch is not None:
            params["pitch"] = float(pitch)
        if duration is not None:
            params["duration"] = float(duration)
        self.request("flyTo", params, timeout=timeout)

    def fit_bounds(
        self,
        bounds: list[float] | tuple[float, float, float, float],
        *,
        timeout: float = 10.0,
    ) -> None:
        """Fit the camera to ``[west, south, east, north]``."""
        self.request(
            "fitBounds", {"bounds": [float(b) for b in bounds]}, timeout=timeout
        )

    def identify(
        self,
        lng: float,
        lat: float,
        *,
        layer_id: str | None = None,
        timeout: float = 10.0,
    ) -> list[dict[str, Any]]:
        """Query rendered features at a geographic point (like clicking it).

        Args:
            lng: Longitude of the query point.
            lat: Latitude of the query point.
            layer_id: Restrict the query to one layer; omit to query all layers.
            timeout: Seconds to wait for the reply.

        Returns:
            One ``{"layerId", "featureId", "properties", "geometry"}`` dict per
            matched feature, topmost first.
        """
        params: dict[str, Any] = {"lngLat": [float(lng), float(lat)]}
        if layer_id is not None:
            params["layerId"] = layer_id
        return self.request("identify", params, timeout=timeout)

    def get_features(
        self, layer_id: str, *, timeout: float = 10.0
    ) -> list[Feature]:
        """Return a layer's features as :class:`Feature` (GeoJSON) objects.

        Reads the live store, so features added or edited in the UI are
        included. Only vector (GeoJSON) layers carry inline features; a tiled or
        remote layer returns an empty list — use :meth:`identify` for those.

        Args:
            layer_id: The layer id.
            timeout: Seconds to wait for the reply.

        Returns:
            A list of :class:`Feature` objects (each also a plain GeoJSON dict).
        """
        features = self.request(
            "getLayerFeatures", {"layerId": layer_id}, timeout=timeout
        )
        return [Feature(f) for f in features or []]

    def list_algorithms(self, *, timeout: float = 10.0) -> list[dict[str, Any]]:
        """List the available client-side processing algorithms.

        Returns:
            One ``{"id", "name", "group", "description", "parameters"}`` dict per
            algorithm, suitable for discovering ids and parameters to pass to
            :meth:`run_algorithm`.
        """
        return self.request("listAlgorithms", timeout=timeout)

    def run_algorithm(
        self,
        algorithm_id: str,
        parameters: dict[str, Any] | None = None,
        *,
        timeout: float = 120.0,
    ) -> dict[str, Any]:
        """Run a processing algorithm in the app and add its result layers.

        Args:
            algorithm_id: An id from :meth:`list_algorithms` (e.g. ``"buffer"``).
            parameters: The algorithm's parameters (see its ``parameters`` from
                :meth:`list_algorithms`). Layer parameters take a layer id.
            timeout: Seconds to wait; raise this for large inputs.

        Returns:
            ``{"logs": [...], "resultLayerIds": [...]}`` — the algorithm's log
            lines and the ids of any layers it added to the map.
        """
        return self.request(
            "runAlgorithm",
            {"id": algorithm_id, "params": parameters or {}},
            timeout=timeout,
        )

    def to_image(
        self, path: str | None = None, *, timeout: float = 30.0
    ) -> bytes | None:
        """Capture the current map view as a PNG.

        Args:
            path: If given, write the PNG here (parent dirs are created) and
                return ``None``. Otherwise return the PNG bytes.
            timeout: Seconds to wait for the capture.

        Returns:
            The PNG bytes, or ``None`` when written to ``path``.
        """
        data_url = self.request("toImage", timeout=timeout)
        _, _, encoded = str(data_url).partition(",")
        png = base64.b64decode(encoded)
        if path is not None:
            out = pathlib.Path(path).expanduser()
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(png)
            return None
        return png

    # -- layer object model ---------------------------------------------

    @property
    def layers(self) -> list[Layer]:
        """The current layers as :class:`Layer` objects, in draw order."""
        return [
            Layer(self, layer["id"])
            for layer in self.project.get("layers", [])
            if isinstance(layer, dict) and "id" in layer
        ]

    def get_layer(self, layer_id: str) -> Layer:
        """Return a :class:`Layer` handle for ``layer_id``.

        Raises:
            ValueError: If no layer with that id exists.
        """
        for layer in self.project.get("layers", []):
            if isinstance(layer, dict) and layer.get("id") == layer_id:
                return Layer(self, layer_id)
        raise ValueError(f"No layer with id {layer_id!r}")

    def _mutate_layer(
        self, layer_id: str, mutate: Callable[[dict[str, Any]], None]
    ) -> None:
        """Apply an in-place mutation to one layer through the project trait."""

        def _apply(project: dict[str, Any]) -> None:
            for layer in project.get("layers", []):
                if isinstance(layer, dict) and layer.get("id") == layer_id:
                    mutate(layer)
                    return
            raise ValueError(f"No layer with id {layer_id!r}")

        self._update_project(_apply)

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

        Note:
            File and URL sources are fetched and inlined into the project (up to
            the 50 MB GeoJSON limit), so a large dataset is carried in memory and
            re-synced over the widget bus on every subsequent project update. For
            very large layers, prefer a tile/COG source the app fetches directly.
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

    def add_raster(
        self,
        url: str,
        name: str = "Raster",
        *,
        bands: list[int] | None = None,
        colormap: str | None = None,
        rescale: list[list[float]] | None = None,
        **style: Any,
    ) -> str:
        """Add a raster (COG / GeoTIFF) layer.

        Alias of :meth:`add_cog` with a generic default name.

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
        return self.add_cog(
            url, name, bands=bands, colormap=colormap, rescale=rescale, **style
        )

    def add_wms(
        self,
        endpoint: str,
        layers: str,
        name: str = "WMS Layer",
        *,
        styles: str = "",
        image_format: str = "image/png",
        transparent: bool = True,
        tile_size: int = 256,
        **style: Any,
    ) -> str:
        """Add a WMS layer rendered as tiled raster (a WMS GetMap request).

        Args:
            endpoint: WMS service endpoint (the GetMap base URL).
            layers: Comma-separated WMS layer name(s).
            name: Layer display name.
            styles: Comma-separated WMS style name(s) (empty for the default).
            image_format: WMS image format (e.g. ``"image/png"``).
            transparent: Whether to request transparent tiles.
            tile_size: Tile size in pixels.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.wms_layer(
                name,
                endpoint,
                layers,
                styles=styles,
                image_format=image_format,
                transparent=transparent,
                tile_size=tile_size,
                **style,
            )
        )

    def add_wmts(
        self,
        url: str,
        name: str = "WMTS Layer",
        *,
        tile_size: int = 256,
        **style: Any,
    ) -> str:
        """Add a WMTS layer from a tile URL template.

        Args:
            url: A WMTS tile URL template (``{z}/{y}/{x}``).
            name: Layer display name.
            tile_size: Tile size in pixels.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.wmts_layer(name, url, tile_size=tile_size, **style)
        )

    def add_wfs(
        self,
        endpoint: str,
        type_name: str,
        name: str = "WFS Layer",
        *,
        version: str = "2.0.0",
        output_format: str = "application/json",
        srs_name: str = "EPSG:4326",
        max_features: int | None = 1000,
        **style: Any,
    ) -> str:
        """Add a WFS layer.

        The WFS GetFeature response (GeoJSON) is fetched and inlined into the
        project, so the endpoint must support a GeoJSON ``output_format``.

        Args:
            endpoint: WFS service endpoint.
            type_name: WFS feature type name (e.g. ``"topp:states"``).
            name: Layer display name.
            version: WFS protocol version (e.g. ``"2.0.0"`` or ``"1.1.0"``).
            output_format: Requested output format (must yield GeoJSON).
            srs_name: Spatial reference of the response.
            max_features: Cap on the number of returned features (defaults to
                1000, matching the UI, since the response is inlined). Pass
                ``None`` to request every feature.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        url = _project.wfs_getfeature_url(
            endpoint,
            type_name,
            version=version,
            output_format=output_format,
            srs_name=srs_name,
            max_features=max_features,
        )
        fc = _project.load_featurecollection(url)
        layer = _project.geojson_layer(name, fc, source_url=url, **style)
        # Mirror the protocol fields the UI persists on the source so the Edit
        # Layer panel can pre-populate the WFS form and isWfsLayer() recognizes
        # the layer when round-tripped from a Python-produced project.
        layer["source"].update(
            {
                "service": "wfs",
                "typeName": type_name,
                "version": version,
                "outputFormat": output_format,
                **({"srsName": srs_name} if srs_name else {}),
            }
        )
        layer["metadata"].update(
            {
                "service": "wfs",
                "sourceKind": "wfs-getfeature",
                "typeName": type_name,
                "featureCount": len(fc.get("features", [])),
            }
        )
        return self._add_layer(layer)

    def add_vector(
        self,
        data: Any,
        name: str = "Vector",
        *,
        render_mode: str = "geojson",
        data_format: str | None = None,
        source_layer: str | None = None,
        **style: Any,
    ) -> str:
        """Add a vector layer from a URL, a local file, or a geo object.

        A remote URL is handed to the in-browser vector control (so any
        GDAL-readable format streams without being inlined). A local file path is
        read with GeoPandas and inlined as GeoJSON, since the browser cannot read
        a kernel-side file. An object exposing ``__geo_interface__`` (e.g. a
        GeoDataFrame) is inlined directly.

        Args:
            data: A dataset URL, a local file path, or a ``__geo_interface__``
                object.
            name: Layer display name.
            render_mode: ``"geojson"`` or ``"tiles"`` (remote URLs only).
            data_format: Optional GDAL format hint for remote URLs
                (e.g. ``"parquet"``, ``"flatgeobuf"``).
            source_layer: Optional source/container layer for multi-layer files.
            **style: Style overrides.

        Returns:
            The id of the added layer.

        Raises:
            ImportError: If a local file is given but GeoPandas is not installed.
            ValueError: If a local file path does not exist.
        """
        if isinstance(data, str) and data.startswith(("http://", "https://")):
            return self._add_layer(
                _project.vector_layer(
                    name,
                    data,
                    render_mode=render_mode,
                    data_format=data_format,
                    source_layer=source_layer,
                    **style,
                )
            )
        if hasattr(data, "__geo_interface__"):
            # The object is inlined as GeoJSON; none of the vector-control
            # options apply, so flag them rather than dropping them silently.
            if (
                render_mode != "geojson"
                or data_format is not None
                or source_layer is not None
            ):
                warnings.warn(
                    "render_mode, data_format, and source_layer are ignored for "
                    "__geo_interface__ objects; they only apply to remote URLs.",
                    stacklevel=2,
                )
            return self.add_geojson(data, name=name, **style)
        # A local file is read and inlined as GeoJSON; render_mode and
        # source_layer only apply to the in-browser vector control (remote URLs),
        # so flag them as no-ops here rather than dropping them silently.
        if render_mode != "geojson" or source_layer is not None:
            warnings.warn(
                "render_mode and source_layer are ignored for local files; they "
                "only apply to remote URLs handled by the in-browser vector "
                "control.",
                stacklevel=2,
            )
        fc = _read_local_vector(data, data_format=data_format)
        return self._add_layer(_project.geojson_layer(name, fc, **style))

    def add_geoparquet(self, data: Any, name: str = "GeoParquet", **style: Any) -> str:
        """Add a GeoParquet layer from a URL or local file.

        Args:
            data: A GeoParquet URL or local file path.
            name: Layer display name.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self.add_vector(data, name=name, data_format="parquet", **style)

    def add_flatgeobuf(self, data: Any, name: str = "FlatGeobuf", **style: Any) -> str:
        """Add a FlatGeobuf layer from a URL or local file.

        Args:
            data: A FlatGeobuf URL or local file path.
            name: Layer display name.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self.add_vector(data, name=name, data_format="flatgeobuf", **style)

    def add_shp(self, data: Any, name: str = "Shapefile", **style: Any) -> str:
        """Add a Shapefile layer from a URL (zipped) or local file.

        Args:
            data: A zipped Shapefile URL or a local ``.shp`` path.
            name: Layer display name.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self.add_vector(data, name=name, data_format="shp", **style)

    def add_vector_tiles(
        self,
        url: str,
        name: str = "Vector Tiles",
        *,
        source_layers: list[str] | None = None,
        source_layer: str | None = None,
        **style: Any,
    ) -> str:
        """Add a vector tile layer from a TileJSON endpoint.

        Args:
            url: TileJSON endpoint for the vector tileset.
            name: Layer display name.
            source_layers: Source-layer names to render (multi-layer tilesets).
            source_layer: A single source-layer name (single-layer convenience).
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.vector_tiles_layer(
                name,
                url,
                source_layers=source_layers,
                source_layer=source_layer,
                **style,
            )
        )

    def add_pmtiles(
        self,
        url: str,
        name: str = "PMTiles",
        *,
        tile_type: str = "vector",
        source_layers: list[str] | None = None,
        **style: Any,
    ) -> str:
        """Add a PMTiles layer from a ``.pmtiles`` URL.

        Args:
            url: URL of the ``.pmtiles`` archive.
            name: Layer display name.
            tile_type: ``"vector"`` or ``"raster"``.
            source_layers: Vector source-layer names to render (vector only).
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.pmtiles_layer(
                name,
                url,
                tile_type=tile_type,
                source_layers=source_layers,
                **style,
            )
        )

    def add_3d_tiles(
        self,
        url: str,
        name: str = "3D Tiles",
        *,
        altitude_offset: float = 0,
        request_headers: dict[str, str] | None = None,
        **style: Any,
    ) -> str:
        """Add a 3D Tiles layer from a ``tileset.json`` URL.

        Args:
            url: URL of the 3D Tiles ``tileset.json``.
            name: Layer display name.
            altitude_offset: Vertical offset applied to the tileset, in meters.
            request_headers: Optional request headers (persisted in the project).
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.three_d_tiles_layer(
                name,
                url,
                altitude_offset=altitude_offset,
                request_headers=request_headers,
                **style,
            )
        )

    def add_video(
        self,
        urls: str | list[str],
        coordinates: list[list[float]],
        name: str = "Video",
        **style: Any,
    ) -> str:
        """Add a georeferenced video layer.

        Args:
            urls: One video URL or a list of format fallbacks (e.g. MP4, WebM).
            coordinates: Four ``[lng, lat]`` corners in top-left, top-right,
                bottom-right, bottom-left order.
            name: Layer display name.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        url_list = [urls] if isinstance(urls, str) else list(urls)
        return self._add_layer(
            _project.video_layer(name, url_list, coordinates, **style)
        )

    def remove_layer(self, layer_id: str) -> None:
        """Remove a layer by id.

        Args:
            layer_id: The id returned when the layer was added.
        """

        def _drop(p: dict[str, Any]) -> None:
            p["layers"] = [
                layer for layer in p["layers"] if layer.get("id") != layer_id
            ]

        self._update_project(_drop)

    def clear_layers(self) -> None:
        """Remove all layers from the map."""
        self._update_project(lambda p: p.update({"layers": []}))

    # -- view / basemap API ---------------------------------------------

    def add_basemap(self, basemap: str) -> None:
        """Set the background basemap style.

        Args:
            basemap: A basemap name or MapLibre style URL.
        """
        url = resolve_basemap(basemap)
        self._update_project(lambda p: p.update({"basemapStyleUrl": url}))

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

    # leafmap compatibility alias for set_center
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
                    raise ValueError(
                        f"Invalid project JSON in file {text}: {exc}"
                    ) from exc
        # Validate the required keys up front (matching parseProject in
        # @geolibre/core) so an invalid project raises here instead of failing
        # silently in the app and only surfacing through the `error` trait.
        if not isinstance(project, dict):
            raise ValueError("Project must be a JSON object")
        missing = {"version", "name", "mapView"} - project.keys()
        if missing:
            raise ValueError(
                f"Invalid project: missing required keys {sorted(missing)}"
            )
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
        self._seq += 1
        self.project = project

    def save_project(self, path: str) -> None:
        """Write the current project to a ``.geolibre.json`` file.

        Args:
            path: Destination file path. Parent directories are created if
                they do not already exist.
        """
        out = pathlib.Path(path).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(self.project, indent=2), encoding="utf-8")


class Feature(dict):
    """A GeoJSON feature with convenience accessors.

    A ``Feature`` *is* a plain ``dict``, so it serializes to JSON and feeds
    straight into tools that consume GeoJSON (e.g.
    ``geopandas.GeoDataFrame.from_features``), while also offering attribute-style
    access to the common members.
    """

    @property
    def geometry(self) -> Any:
        """The feature's GeoJSON geometry, or ``None``."""
        return self.get("geometry")

    @property
    def properties(self) -> dict[str, Any]:
        """The feature's properties mapping (empty dict if absent)."""
        return self.get("properties") or {}

    @property
    def id(self) -> Any:
        """The feature's id, or ``None``."""
        return self.get("id")

    @property
    def __geo_interface__(self) -> dict[str, Any]:
        """The GeoJSON mapping, for libraries that read ``__geo_interface__``."""
        return dict(self)


class Layer:
    """A handle to one layer on a :class:`Map`.

    Reads reflect the live project; property setters and :meth:`remove` mutate
    the project through the same synced trait the rest of the API uses, so edits
    propagate to the running app. Query helpers (:meth:`get_features`,
    :meth:`zoom_to`) round-trip to the app.
    """

    def __init__(self, m: Map, layer_id: str) -> None:
        """Bind a layer handle.

        Args:
            m: The owning map.
            layer_id: The layer's id.
        """
        self._map = m
        self._id = layer_id

    def _layer(self) -> dict[str, Any]:
        for layer in self._map.project.get("layers", []):
            if isinstance(layer, dict) and layer.get("id") == self._id:
                return layer
        raise ValueError(f"Layer {self._id!r} no longer exists")

    @property
    def id(self) -> str:
        """The layer id."""
        return self._id

    @property
    def type(self) -> Any:
        """The layer type (e.g. ``"geojson"``, ``"raster"``)."""
        return self._layer().get("type")

    @property
    def name(self) -> Any:
        """The layer's display name."""
        return self._layer().get("name")

    @name.setter
    def name(self, value: str) -> None:
        self._map._mutate_layer(self._id, lambda layer: layer.update(name=value))

    @property
    def visible(self) -> bool:
        """Whether the layer is visible."""
        return bool(self._layer().get("visible", True))

    @visible.setter
    def visible(self, value: bool) -> None:
        self._map._mutate_layer(
            self._id, lambda layer: layer.update(visible=bool(value))
        )

    @property
    def opacity(self) -> float:
        """The layer's opacity in ``[0, 1]``."""
        return float(self._layer().get("opacity", 1.0))

    @opacity.setter
    def opacity(self, value: float) -> None:
        self._map._mutate_layer(
            self._id, lambda layer: layer.update(opacity=float(value))
        )

    @property
    def style(self) -> dict[str, Any]:
        """A copy of the layer's style object."""
        return copy.deepcopy(self._layer().get("style", {}))

    def set_style(self, **style: Any) -> None:
        """Merge style overrides into the layer (e.g. ``fillColor="#ff0000"``)."""

        def _apply(layer: dict[str, Any]) -> None:
            layer.setdefault("style", {}).update(style)

        self._map._mutate_layer(self._id, _apply)

    def get_features(self, *, timeout: float = 10.0) -> list[Feature]:
        """Return this layer's features (see :meth:`Map.get_features`)."""
        return self._map.get_features(self._id, timeout=timeout)

    def zoom_to(self, *, timeout: float = 10.0) -> None:
        """Fit the map camera to this layer's extent."""
        self._map.request("zoomToLayer", {"layerId": self._id}, timeout=timeout)

    def remove(self) -> None:
        """Remove this layer from the map."""
        self._map.remove_layer(self._id)

    def __repr__(self) -> str:
        try:
            return f"Layer(id={self._id!r}, name={self.name!r}, type={self.type!r})"
        except ValueError:
            return f"Layer(id={self._id!r}, removed)"
