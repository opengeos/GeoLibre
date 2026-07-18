"""The GeoLibre Jupyter widget and its leafmap-style Python API."""

from __future__ import annotations

import base64
import copy
import html as _html
import json
import math
import os
import pathlib
import re
import time
import uuid
import warnings
from typing import Any, Callable

import anywidget
import traitlets

from . import project as _project
from ._server import app_port, register_local_file, serve_app
from .basemaps import resolve_basemap
from .color_ramp import graduated_stops
from .legends import get_builtin_legend

_HERE = pathlib.Path(__file__).parent
_STATIC_APP = _HERE / "static" / "app"

# Accepted values for the constructor's layout/theme args, validated up front so
# a typo surfaces immediately instead of silently falling back in the front-end.
_VALID_LAYOUTS = frozenset({"embed", "full", "maponly"})
_VALID_THEMES = frozenset({"light", "dark"})

# Accepted values for the split-map / legend / colorbar helpers, validated up
# front so a typo surfaces in Python instead of silently falling back in the app.
# Reuse the canonical corner set from project.py so the two cannot drift.
_VALID_CONTROL_POSITIONS = _project.CONTROL_POSITIONS
_VALID_ORIENTATIONS = frozenset({"vertical", "horizontal"})
_VALID_LEGEND_SHAPES = frozenset({"square", "circle", "line"})


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


def _html_escape(value: str) -> str:
    """Escape a string for safe interpolation into HTML attributes/text."""
    return _html.escape(str(value), quote=True)


# A CSS length/percentage value (e.g. "100%", "800px", "calc(100% - 2rem)"). The
# allowed set deliberately excludes the structural CSS characters ("{};:") so a
# to_html() width/height cannot close the <style> rule and inject CSS.
_CSS_DIMENSION_RE = re.compile(r"^[\w%.+\-\s()]+$")


# Standalone export shell: an iframe hosting the GeoLibre app plus a script that
# replays the inlined project into it once the app announces it is ready, using
# the same postMessage protocol useEmbedBridge/useCommandBridge speak. The
# project is carried in a JSON <script> block rather than a JS string literal so
# it needs no JS-string escaping. {0}-style fields are filled by str.format, so
# literal CSS/JS braces are doubled.
_HTML_EXPORT_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title}</title>
<style>
  html, body {{ margin: 0; padding: 0; height: 100%; }}
  #geolibre-frame {{ border: 0; display: block; width: {width}; height: {height}; }}
</style>
</head>
<body>
<iframe id="geolibre-frame" src="{iframe_src}" allow="fullscreen" allowfullscreen></iframe>
<script type="application/json" id="geolibre-project">{project_json}</script>
<script>
(function () {{
  var frame = document.getElementById("geolibre-frame");
  var project = JSON.parse(
    document.getElementById("geolibre-project").textContent
  );
  var loaded = false;
  function load() {{
    if (loaded || !frame.contentWindow) return;
    loaded = true;
    frame.contentWindow.postMessage(
      {{ type: "geolibre:load-project", project: project, seq: 1 }},
      "*"
    );
  }}
  // The app posts "geolibre:ready" once mounted; reply with the project. Guard
  // on the frame as the source so an unrelated message cannot trigger the load.
  window.addEventListener("message", function (event) {{
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (data && data.type === "geolibre:ready") load();
  }});
}})();
</script>
</body>
</html>
"""


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
            raise ValueError(f"layout must be one of {sorted(_VALID_LAYOUTS)}, got {layout!r}")
        if theme not in _VALID_THEMES:
            raise ValueError(f"theme must be one of {sorted(_VALID_THEMES)}, got {theme!r}")
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

    def _on_custom_msg(self, _widget: Any, content: Any, _buffers: Any) -> None:
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
    def _wait_for_result(slot: dict[str, Any], method: str, timeout: float) -> None:
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

        def _check_deadline() -> None:
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"GeoLibre command {method!r} timed out after {timeout}s. "
                    "The map must be displayed and loaded before it can "
                    "answer; show the map, then retry or pass a larger "
                    "timeout=."
                )

        with ui_events() as poll:
            while not slot["done"]:
                # Check before and after pumping: a slow poll() with a large event
                # backlog could otherwise overrun a very small timeout.
                _check_deadline()
                poll(10)
                if slot["done"]:
                    break
                _check_deadline()
                # 20 Hz: imperceptible latency, far less CPU than a 100 Hz spin
                # (jupyter_ui_poll already pumps 10 kernel events per iteration).
                time.sleep(0.05)

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
            self._wait_for_result(slot, method, timeout)
        finally:
            self._pending.pop(request_id, None)
        if not slot["ok"]:
            raise RuntimeError(slot["error"] or f"GeoLibre command {method!r} failed")
        return slot["value"]

    def on(self, event: str, callback: Callable[[Any], None]) -> Callable[[], None]:
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

    def on_selection_change(self, callback: Callable[[Any], None]) -> Callable[[], None]:
        """Register a callback fired when the selected layer/feature changes."""
        return self.on("selection-change", callback)

    def on_layer_change(self, callback: Callable[[Any], None]) -> Callable[[], None]:
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
        self.request("fitBounds", {"bounds": [float(b) for b in bounds]}, timeout=timeout)

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

    def get_features(self, layer_id: str, *, timeout: float = 10.0) -> list[Feature]:
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
        features = self.request("getLayerFeatures", {"layerId": layer_id}, timeout=timeout)
        return [Feature(f) for f in features or []]

    @staticmethod
    def _features_to_gdf(features: list[Feature]) -> Any:
        """Build an EPSG:4326 GeoDataFrame from GeoJSON features.

        Args:
            features: The features to wrap (each a GeoJSON Feature mapping).

        Returns:
            A ``geopandas.GeoDataFrame`` in EPSG:4326.

        Raises:
            ImportError: If GeoPandas is not installed.
        """
        try:
            import geopandas
        except ImportError as exc:
            raise ImportError(
                "Returning features as a GeoDataFrame requires GeoPandas. Install "
                "it with `pip install geopandas`, or omit as_gdf=True to get a list "
                "of Feature objects instead."
            ) from exc
        # from_features accepts plain GeoJSON mappings (Feature is a dict subclass)
        # and yields an empty frame for an empty list, so no special-casing.
        return geopandas.GeoDataFrame.from_features(features, crs="EPSG:4326")

    def get_selected_features(
        self, *, as_gdf: bool = False, timeout: float = 10.0
    ) -> list[Feature] | Any:
        """Return the features currently selected in the app.

        Reads the live selection (the layer/feature highlighted by clicking a
        feature in the UI). Selection is a single feature, so the result is a
        list of zero or one :class:`Feature`; the list shape leaves room for
        future multi-select.

        Args:
            as_gdf: Return a ``geopandas.GeoDataFrame`` instead of a list of
                :class:`Feature` objects (requires GeoPandas).
            timeout: Seconds to wait for the reply.

        Returns:
            A list of :class:`Feature` objects, or a ``GeoDataFrame`` when
            ``as_gdf`` is true.

        Note:
            Only features in vector (GeoJSON) layers can be read back. A feature
            selected in a tile or service layer carries no inline geometry, so
            the result is an empty list; use :meth:`identify` for those layers.
        """
        features = self.request("getSelectedFeatures", timeout=timeout)
        feats = [Feature(f) for f in features or []]
        return self._features_to_gdf(feats) if as_gdf else feats

    def get_drawn_features(
        self, *, as_gdf: bool = False, timeout: float = 10.0
    ) -> list[Feature] | Any:
        """Return the features the user drew with the Geo Editor.

        Gathers the features from the app's "Sketches" layer(s) (the regions of
        interest drawn with the drawing tools), so a notebook can read back what
        was sketched on the map without knowing which layer it landed in.

        Args:
            as_gdf: Return a ``geopandas.GeoDataFrame`` instead of a list of
                :class:`Feature` objects (requires GeoPandas).
            timeout: Seconds to wait for the reply.

        Returns:
            A list of :class:`Feature` objects, or a ``GeoDataFrame`` when
            ``as_gdf`` is true.
        """
        features = self.request("getDrawnFeatures", timeout=timeout)
        feats = [Feature(f) for f in features or []]
        return self._features_to_gdf(feats) if as_gdf else feats

    @property
    def user_rois(self) -> dict[str, Any]:
        """The user-drawn regions of interest as a GeoJSON FeatureCollection.

        A leafmap-style accessor over :meth:`get_drawn_features`; reading it
        round-trips to the running app, so display the map first.
        """
        return {
            "type": "FeatureCollection",
            "features": [dict(f) for f in self.get_drawn_features()],
        }

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

    def to_image(self, path: str | None = None, *, timeout: float = 30.0) -> bytes | None:
        """Capture the current map view as a PNG.

        Args:
            path: If given, write the PNG here (parent dirs are created) and
                return ``None``. Otherwise return the PNG bytes.
            timeout: Seconds to wait for the capture.

        Returns:
            The PNG bytes, or ``None`` when written to ``path``.
        """
        data_url = self.request("toImage", timeout=timeout)
        _, sep, encoded = str(data_url).partition(",")
        if not sep:
            raise ValueError(f"toImage returned an unexpected value: {data_url!r}")
        png = base64.b64decode(encoded)
        if path is not None:
            out = pathlib.Path(path).expanduser()
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(png)
            return None
        return png

    # Hosted GeoLibre viewer used as the default to_html() app, so an exported
    # file is portable (loads the app over the network instead of the
    # session-bound localhost bundle).
    _DEFAULT_HTML_APP_URL = "https://web.geolibre.app/"

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
        uses, so it renders the map exactly as configured here. Unlike
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
        base_url = app_url or self._DEFAULT_HTML_APP_URL
        # Force the embed bridge on (isEmbedded() honours ?embed=1). Insert the
        # parameter into the query string *before* any URL fragment: a "#..."
        # fragment would otherwise swallow a trailing "?embed=1" (browsers read
        # it as part of the fragment), so the app never sees the flag. partition
        # keeps the fragment and its "#" intact when present and yields "" when
        # absent.
        base, hash_sep, fragment = base_url.partition("#")
        separator = "&" if "?" in base else "?"
        iframe_src = f"{base}{separator}embed=1{hash_sep}{fragment}"
        # width/height land inside a <style> rule; _html_escape does not neutralise
        # CSS metacharacters like "}" or ";", so validate them as plain CSS
        # dimensions to keep a stray value from closing the rule and injecting CSS.
        frame_height = height or self.height
        if not _CSS_DIMENSION_RE.match(width):
            raise ValueError(f"to_html: invalid CSS width value {width!r}")
        if not _CSS_DIMENSION_RE.match(frame_height):
            raise ValueError(f"to_html: invalid CSS height value {frame_height!r}")
        # Inline the project inside a JSON <script> block and escape "<" so a
        # property value can never break out of the script element; "<" is
        # valid JSON that JSON.parse restores to "<".
        project_json = json.dumps(self.project).replace("<", "\\u003c")
        html = _HTML_EXPORT_TEMPLATE.format(
            title=_html_escape(title),
            width=_html_escape(width),
            height=_html_escape(frame_height),
            iframe_src=_html_escape(iframe_src),
            project_json=project_json,
        )
        if path is not None:
            out = pathlib.Path(path).expanduser()
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(html, encoding="utf-8")
            return None
        return html

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

    def _mutate_layer(self, layer_id: str, mutate: Callable[[dict[str, Any]], None]) -> None:
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
            data if isinstance(data, str) and data.startswith(("http://", "https://")) else None
        )
        fc = _project.load_featurecollection(data)
        return self._add_layer(_project.geojson_layer(name, fc, source_url=source_url, **style))

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

    def add_marker(
        self,
        lng: float,
        lat: float,
        name: str = "Marker",
        *,
        properties: dict[str, Any] | None = None,
        **style: Any,
    ) -> str:
        """Add a single point marker at ``[lng, lat]``.

        The marker is a GeoJSON point layer (rendered as a circle); its
        ``properties`` are shown when the point is clicked. Style overrides such
        as ``fillColor`` and ``circleRadius`` control its appearance.

        Args:
            lng: Marker longitude.
            lat: Marker latitude.
            name: Layer display name.
            properties: Optional feature properties (shown on click).
            **style: Style overrides (e.g. ``fillColor``, ``circleRadius``).

        Returns:
            The id of the added layer.
        """
        fc = {
            "type": "FeatureCollection",
            "features": [self._point_feature(lng, lat, properties)],
        }
        return self._add_layer(_project.geojson_layer(name, fc, **style))

    def add_markers(
        self,
        points: Any,
        name: str = "Markers",
        **style: Any,
    ) -> str:
        """Add point markers from a collection of points.

        Args:
            points: A sequence of ``(lng, lat)`` pairs or
                ``{"lng"/"lon"/"x", "lat"/"y", **properties}`` mappings, a GeoJSON
                point FeatureCollection/Feature/geometry, a GeoJSON string, or a
                ``__geo_interface__`` object (e.g. a point GeoDataFrame).
            name: Layer display name.
            **style: Style overrides (e.g. ``fillColor``, ``circleRadius``).

        Returns:
            The id of the added layer.
        """
        fc = self._points_to_featurecollection(points)
        return self._add_layer(_project.geojson_layer(name, fc, **style))

    def add_circle_markers(
        self,
        points: Any,
        name: str = "Circle Markers",
        *,
        radius: float | None = None,
        **style: Any,
    ) -> str:
        """Add circle markers (point markers with an explicit radius).

        Convenience over :meth:`add_markers` that surfaces ``radius`` as a named
        argument; everything else behaves the same.

        Args:
            points: Points in any form accepted by :meth:`add_markers`.
            name: Layer display name.
            radius: Optional circle radius in pixels (sets ``circleRadius``).
            **style: Additional style overrides.

        Returns:
            The id of the added layer.
        """
        if radius is not None:
            style.setdefault("circleRadius", float(radius))
        return self.add_markers(points, name=name, **style)

    def add_marker_cluster(
        self,
        points: Any,
        name: str = "Marker Cluster",
        *,
        cluster_radius: int = 50,
        cluster_max_zoom: int = 14,
        **style: Any,
    ) -> str:
        """Add clustered point markers.

        Builds a GeoJSON point layer with the cluster renderer enabled, so
        nearby points collapse into count bubbles that split apart as you zoom
        in (the same clustering the UI's point renderer offers).

        Args:
            points: Points in any form accepted by :meth:`add_markers`.
            name: Layer display name.
            cluster_radius: Cluster radius in pixels.
            cluster_max_zoom: Zoom level beyond which points are no longer
                clustered.
            **style: Additional style overrides.

        Returns:
            The id of the added layer.
        """
        style.setdefault("pointRenderer", "cluster")
        style.setdefault("clusterRadius", int(cluster_radius))
        style.setdefault("clusterMaxZoom", int(cluster_max_zoom))
        return self.add_markers(points, name=name, **style)

    # -- choropleth ------------------------------------------------------

    def add_choropleth(
        self,
        data: Any,
        column: str,
        name: str = "Choropleth",
        *,
        class_count: int = 5,
        colormap: str = "viridis",
        scheme: str = "equal-interval",
        **style: Any,
    ) -> str:
        """Add a GeoJSON layer with data-driven (graduated) symbology.

        Classifies ``column`` into ``class_count`` numeric ranges and colors
        each range from ``colormap``, building the same graduated symbology the
        Style panel produces from the UI. The stops are computed kernel-side from
        the data, so no precomputed styling is required.

        Args:
            data: Any source accepted by :meth:`add_geojson` (a GeoJSON dict,
                file path, URL, JSON string, or GeoDataFrame).
            column: The feature property to classify (must be numeric).
            name: Layer display name.
            class_count: Number of classes (clamped to at least 2).
            colormap: A color ramp name (e.g. ``"viridis"``, ``"blues"``,
                ``"rdylgn"``).
            scheme: Classification scheme, ``"equal-interval"`` or ``"quantile"``.
            **style: Additional style overrides.

        Returns:
            The id of the added layer.

        Raises:
            ValueError: If the column is missing from every feature, or ``scheme``
                is not supported.
        """
        source_url = (
            data if isinstance(data, str) and data.startswith(("http://", "https://")) else None
        )
        fc = _project.load_featurecollection(data)
        features = fc.get("features", [])
        values = [
            feature.get("properties", {}).get(column)
            for feature in features
            if isinstance(feature, dict)
        ]
        if all(value is None for value in values):
            raise ValueError(f"Column {column!r} not found in any feature's properties")

        def _is_numeric(value: Any) -> bool:
            try:
                return math.isfinite(float(value))
            except (TypeError, ValueError):
                return False

        # graduated_stops would otherwise fall back to index-based stops for a
        # non-numeric column, succeeding with misleading symbology; reject it.
        if not any(_is_numeric(value) for value in values):
            raise ValueError(
                f"Column {column!r} must contain at least one numeric value for "
                "a graduated choropleth"
            )
        stops = graduated_stops(
            values,
            class_count=class_count,
            color_ramp=colormap,
            classification_scheme=scheme,
        )
        choropleth_style: dict[str, Any] = {
            "vectorStyleMode": "graduated",
            "vectorStyleProperty": column,
            "vectorStyleClassCount": min(12, max(2, int(class_count))),
            "vectorStyleColorRamp": colormap,
            "vectorStyleClassificationScheme": scheme,
            "vectorStyleStops": stops,
        }
        # Caller overrides win over the computed symbology.
        choropleth_style.update(style)
        return self._add_layer(
            _project.geojson_layer(name, fc, source_url=source_url, **choropleth_style)
        )

    # leafmap-style alias: add the data with optional column-driven symbology.
    def add_data(
        self,
        data: Any,
        column: str | None = None,
        name: str = "Data",
        **kwargs: Any,
    ) -> str:
        """Add data, optionally styled as a choropleth by ``column``.

        With ``column`` set this is :meth:`add_choropleth`; without it, a plain
        GeoJSON layer (:meth:`add_geojson`). Provided for leafmap parity.

        Args:
            data: Any source accepted by :meth:`add_geojson`.
            column: Optional numeric property to drive graduated symbology.
            name: Layer display name.
            **kwargs: Forwarded to :meth:`add_choropleth` (when ``column`` is
                given) or :meth:`add_geojson`.

        Returns:
            The id of the added layer.
        """
        if column is None:
            return self.add_geojson(data, name=name, **kwargs)
        return self.add_choropleth(data, column, name=name, **kwargs)

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

    @staticmethod
    def _resolve_raster_source(source: Any) -> str:
        """Resolve a raster source to a URL the in-iframe app can fetch.

        An ``http(s)`` URL is used as-is. Anything else is treated as a
        kernel-side local file path and exposed through the bundled static
        server (with HTTP Range support, which the GeoTIFF reader needs), so a
        local GeoTIFF renders without being hosted elsewhere.

        Args:
            source: A COG/GeoTIFF URL or a local file path.

        Returns:
            A URL the app can fetch.

        Raises:
            ValueError: If a local path is given but no such file exists.
            RuntimeError: If the static server is not running.
        """
        if isinstance(source, str) and source.startswith(("http://", "https://")):
            return source
        return register_local_file(source)

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
            url: URL of the COG / GeoTIFF, or a path to a local GeoTIFF on the
                kernel host. A local file is served by the bundled static server
                so the app can read it; that URL lives only for this kernel
                session, so a project saved with a local raster will not restore
                the raster when reopened later, and the file is only reachable
                when the browser runs on the same host as the kernel (local
                Jupyter, VS Code).
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
                self._resolve_raster_source(url),
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

        Alias of :meth:`add_cog` with a generic default name. Accepts a URL or a
        kernel-side local GeoTIFF path (see :meth:`add_cog` for the local-file
        caveats).

        Args:
            url: URL of the COG / GeoTIFF, or a local GeoTIFF path.
            name: Layer display name.
            bands: Optional 1-based band indices to render.
            colormap: Optional colormap name (single-band rendering).
            rescale: Optional ``[[min, max], ...]`` ranges per band.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self.add_cog(url, name, bands=bands, colormap=colormap, rescale=rescale, **style)

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
        version: str | None = "1.1.1",
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
            version: WMS protocol version, ``"1.1.1"`` (default) or
                ``"1.3.0"``. Version 1.3.0 sends ``CRS`` instead of ``SRS``;
                some servers accept only one version.
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
                version=version,
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
        return self._add_layer(_project.wmts_layer(name, url, tile_size=tile_size, **style))

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
            if render_mode != "geojson" or data_format is not None or source_layer is not None:
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
        return self._add_layer(_project.video_layer(name, url_list, coordinates, **style))

    def remove_layer(self, layer_id: str) -> None:
        """Remove a layer by id.

        Args:
            layer_id: The id returned when the layer was added.
        """

        def _drop(p: dict[str, Any]) -> None:
            p["layers"] = [layer for layer in p["layers"] if layer.get("id") != layer_id]

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

    # Name parity with the in-app console's geolibre.set_basemap(url).
    def set_basemap(self, basemap: str) -> None:
        """Set the background basemap style (alias of :meth:`add_basemap`).

        Args:
            basemap: A basemap name or MapLibre style URL.
        """
        self.add_basemap(basemap)

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

    def split_map(
        self,
        left_layers: Any = None,
        right_layers: Any = None,
        *,
        orientation: str = "vertical",
        position: float = 50,
        control_position: str = "top-left",
    ) -> None:
        """Add a swipe (split-map) comparison slider between two layer sets.

        Enables the Layer Swipe control, which clips the left/top layers to one
        side of a draggable slider and the right/bottom layers to the other, for
        before/after comparisons. Drives the app's built-in swipe plugin through
        the project, so it appears with no reload.

        Args:
            left_layers: Layer(s) shown on the left/top of the slider, as a layer
                id, a :class:`Layer`, or a list of those. The string
                ``"__basemap__"`` selects the basemap.
            right_layers: Layer(s) shown on the right/bottom of the slider, in the
                same forms as ``left_layers``.
            orientation: ``"vertical"`` (slider moves left/right) or
                ``"horizontal"`` (slider moves up/down).
            position: Initial slider position as a percentage in ``[0, 100]``.
            control_position: Corner for the swipe panel; one of ``"top-left"``,
                ``"top-right"``, ``"bottom-left"``, ``"bottom-right"``.

        Raises:
            ValueError: If ``orientation``, ``control_position``, or a layer
                reference is invalid.
        """
        if orientation not in _VALID_ORIENTATIONS:
            raise ValueError(
                f"orientation must be one of {sorted(_VALID_ORIENTATIONS)}, got {orientation!r}"
            )
        if control_position not in _VALID_CONTROL_POSITIONS:
            raise ValueError(
                "control_position must be one of "
                f"{sorted(_VALID_CONTROL_POSITIONS)}, got {control_position!r}"
            )
        left = self._coerce_layer_ids(left_layers)
        right = self._coerce_layer_ids(right_layers)
        clamped = min(100.0, max(0.0, float(position)))
        state = _project.swipe_state(
            left_layers=left,
            right_layers=right,
            orientation=orientation,
            position=clamped,
        )

        def mutate(p: dict[str, Any]) -> None:
            _project.set_plugin_state(
                p,
                _project.SWIPE_PLUGIN_ID,
                state,
                position=control_position,
            )

        self._update_project(mutate)

    def _update_components_state(
        self, key: str, entry_state_builder: Callable[[Any], dict[str, Any]]
    ) -> None:
        """Merge one feature's state into the Components plugin settings.

        The Components plugin (legend / colorbar / html) stores all its features
        under a single settings blob keyed by feature name, so a new legend must
        be merged in without dropping an existing colorbar (and vice versa).

        Args:
            key: The feature key (``"legend"`` or ``"colorbar"``).
            entry_state_builder: Called with the feature's current state (or
                ``None``) and returns its new state.
        """

        def mutate(p: dict[str, Any]) -> None:
            plugins = _project.ensure_plugins_block(p)
            current = plugins["settings"].get(_project.COMPONENTS_PLUGIN_ID)
            components = dict(current) if isinstance(current, dict) else {}
            components[key] = entry_state_builder(components.get(key))
            # The legend/colorbar restore from their settings blob alone, so the
            # plugin is configured but not added to activePluginIds (activating
            # it would also mount the full Components toolbar).
            _project.set_plugin_state(
                p,
                _project.COMPONENTS_PLUGIN_ID,
                components,
                activate=False,
            )

        self._update_project(mutate)

    def add_legend(
        self,
        title: str | None = None,
        *,
        legend_dict: dict[str, str] | None = None,
        labels: list[str] | None = None,
        colors: list[str] | None = None,
        builtin: str | None = None,
        position: str = "bottom-left",
        shape: str = "square",
    ) -> None:
        """Add a legend to the map.

        Supply the legend entries one of three ways: a built-in preset
        (``builtin``), a ``{label: color}`` mapping (``legend_dict``), or parallel
        ``labels`` and ``colors`` lists. Each call adds another legend, so a map
        can carry several at once.

        Args:
            title: Legend title. Defaults to ``"Legend"``, or the preset's title
                when ``builtin`` is given and no title is passed.
            legend_dict: A mapping of label to CSS color (preserves order).
            labels: Item labels, paired position-wise with ``colors``.
            colors: Item CSS colors, paired position-wise with ``labels``.
            builtin: A built-in preset name (e.g. ``"nlcd"``,
                ``"esa_worldcover"``). See
                :func:`geolibre.legends.builtin_legend_names`.
            position: Corner for the legend; one of ``"top-left"``,
                ``"top-right"``, ``"bottom-left"``, ``"bottom-right"``.
            shape: Swatch shape for every item; ``"square"``, ``"circle"``, or
                ``"line"``.

        Raises:
            ValueError: If no entries are supplied, ``labels``/``colors`` lengths
                differ, or ``position``/``shape``/``builtin`` is invalid.
        """
        if position not in _VALID_CONTROL_POSITIONS:
            raise ValueError(
                f"position must be one of {sorted(_VALID_CONTROL_POSITIONS)}, got {position!r}"
            )
        if shape not in _VALID_LEGEND_SHAPES:
            raise ValueError(f"shape must be one of {sorted(_VALID_LEGEND_SHAPES)}, got {shape!r}")

        # The three ways to supply entries are mutually exclusive; reject a
        # combination rather than silently letting one win by check order.
        sources = (
            builtin is not None,
            legend_dict is not None,
            labels is not None or colors is not None,
        )
        if sum(sources) > 1:
            raise ValueError(
                "Provide legend entries via exactly one of: builtin=, "
                "legend_dict=, or labels= and colors=."
            )

        pairs: list[tuple[str, str]]
        if builtin is not None:
            preset = get_builtin_legend(builtin)
            pairs = list(preset["items"])
            if title is None:
                title = preset["title"]
        elif legend_dict is not None:
            pairs = [(str(label), str(color)) for label, color in legend_dict.items()]
        elif labels is not None or colors is not None:
            if labels is None or colors is None:
                raise ValueError("labels and colors must be provided together")
            if len(labels) != len(colors):
                raise ValueError(
                    f"labels and colors must have the same length ({len(labels)} != {len(colors)})"
                )
            pairs = [(str(label), str(color)) for label, color in zip(labels, colors)]
        else:
            raise ValueError(
                "Provide legend entries via builtin=, legend_dict=, or labels= and colors=."
            )
        if not pairs:
            raise ValueError("Legend has no items")

        items = [{"label": label, "color": color, "shape": shape} for label, color in pairs]
        entry = _project.legend_gui_entry(title or "Legend", items, position)
        self._update_components_state(
            "legend",
            lambda existing: _project.legend_gui_state(entry, existing=existing),
        )

    def add_colorbar(
        self,
        *,
        colormap: str = "viridis",
        vmin: float = 0.0,
        vmax: float = 1.0,
        label: str = "",
        units: str = "",
        colors: list[str] | None = None,
        orientation: str = "vertical",
        position: str = "bottom-right",
    ) -> None:
        """Add a colorbar for a continuous (single-band) raster.

        Renders a gradient with min/max ticks, from either a named colormap or an
        explicit list of CSS colors. Each call adds another colorbar.

        Args:
            colormap: A named colormap (e.g. ``"viridis"``, ``"plasma"``,
                ``"inferno"``, ``"magma"``, ``"cividis"``, ``"turbo"``,
                ``"terrain"``). Ignored when ``colors`` is given.
            vmin: Value at the low end of the colorbar.
            vmax: Value at the high end of the colorbar.
            label: Title shown alongside the colorbar.
            units: Units suffix shown with the values.
            colors: Optional list of CSS colors defining a custom gradient; when
                given, the colorbar uses these instead of ``colormap``.
            orientation: ``"vertical"`` or ``"horizontal"``.
            position: Corner for the colorbar; one of ``"top-left"``,
                ``"top-right"``, ``"bottom-left"``, ``"bottom-right"``.

        Raises:
            ValueError: If ``orientation`` or ``position`` is invalid,
                ``vmin`` is not less than ``vmax``, or ``colors`` is given but
                empty.
        """
        if orientation not in _VALID_ORIENTATIONS:
            raise ValueError(
                f"orientation must be one of {sorted(_VALID_ORIENTATIONS)}, got {orientation!r}"
            )
        if position not in _VALID_CONTROL_POSITIONS:
            raise ValueError(
                f"position must be one of {sorted(_VALID_CONTROL_POSITIONS)}, got {position!r}"
            )
        vmin_f, vmax_f = float(vmin), float(vmax)
        # The app's normalizer only fixes vmin == vmax; an inverted range would
        # otherwise render a reversed gradient, so reject it here.
        if vmin_f >= vmax_f:
            raise ValueError(f"vmin ({vmin_f}) must be less than vmax ({vmax_f})")
        if colors is not None:
            if not colors:
                raise ValueError("colors must be a non-empty list when provided")
            mode = "custom"
            custom_colors = ", ".join(str(color) for color in colors)
        else:
            mode = "named"
            custom_colors = ""
        entry = _project.colorbar_gui_entry(
            mode=mode,
            colormap=colormap,
            custom_colors=custom_colors,
            vmin=vmin_f,
            vmax=vmax_f,
            label=label,
            units=units,
            orientation=orientation,
            position=position,
        )
        self._update_components_state(
            "colorbar",
            lambda existing: _project.colorbar_gui_state(entry, existing=existing),
        )

    def add_colormap(
        self,
        colormap: str = "viridis",
        *,
        vmin: float = 0.0,
        vmax: float = 1.0,
        label: str = "",
        **kwargs: Any,
    ) -> None:
        """Add a colorbar from a named colormap (alias of :meth:`add_colorbar`).

        Provided for leafmap parity; ``colormap`` is positional here.

        Args:
            colormap: A named colormap (see :meth:`add_colorbar`).
            vmin: Value at the low end of the colorbar.
            vmax: Value at the high end of the colorbar.
            label: Title shown alongside the colorbar.
            **kwargs: Forwarded to :meth:`add_colorbar` (e.g. ``units``,
                ``orientation``, ``position``).
        """
        self.add_colorbar(colormap=colormap, vmin=vmin, vmax=vmax, label=label, **kwargs)

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
        self._map._mutate_layer(self._id, lambda layer: layer.update(visible=bool(value)))

    @property
    def opacity(self) -> float:
        """The layer's opacity in ``[0, 1]``."""
        return float(self._layer().get("opacity", 1.0))

    @opacity.setter
    def opacity(self, value: float) -> None:
        self._map._mutate_layer(self._id, lambda layer: layer.update(opacity=float(value)))

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
