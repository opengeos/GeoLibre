"""The GeoLibre Jupyter widget and its leafmap-style Python API."""

from __future__ import annotations

import base64
import copy
import csv
import html as _html
import io
import json
import math
import os
import pathlib
import re
import time
import urllib.parse
import uuid
import warnings
from typing import Any, Callable
from urllib.error import URLError

import anywidget
import traitlets

from . import authoring as _authoring
from . import project as _project
from ._server import app_port, register_local_file, serve_app
from .basemaps import resolve_basemap

_HERE = pathlib.Path(__file__).parent
_STATIC_APP = _HERE / "static" / "app"

# Accepted values for the constructor's layout/theme args, validated up front so
# a typo surfaces immediately instead of silently falling back in the front-end.
_VALID_LAYOUTS = frozenset({"embed", "full", "maponly"})
_VALID_THEMES = frozenset({"light", "dark"})

# CSV/tabular input is inlined into the project exactly like GeoJSON is, so the
# same 50 MB ceiling applies to a fetched response or a local file.
_MAX_TABULAR_BYTES = _project._MAX_GEOJSON_BYTES

# Column name for CSV fields beyond the header row. csv.DictReader's default
# restkey is ``None``, which would put a non-string key in the feature
# properties and break JSON serialization on the way to the widget.
_CSV_RESTKEY = "_extra"


def _read_local_vector(
    path: Any,
    data_format: str | None = None,
    source_layer: str | None = None,
) -> dict[str, Any]:
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
        source_layer: Optional layer/table name for a multi-layer container such
            as a GeoPackage.

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
        # read_parquet has no layer concept, so a source_layer here is a no-op.
        if source_layer is not None:
            warnings.warn(
                "source_layer is ignored for (Geo)Parquet files; it only applies "
                "to multi-layer containers such as GeoPackage.",
                stacklevel=2,
            )
        gdf = geopandas.read_parquet(file_path)
    else:
        gdf = geopandas.read_file(file_path, **({"layer": source_layer} if source_layer else {}))
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
      {app_origin}
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

# Where a standalone export loads the app from by default: the hosted viewer, so
# the exported file stays portable once the kernel is gone.
DEFAULT_HTML_APP_URL = "https://web.geolibre.app/"


def render_project_html(
    project: dict[str, Any],
    *,
    title: str = "GeoLibre Map",
    width: str = "100%",
    height: str = "800px",
    app_url: str | None = None,
) -> str:
    """Render a project dict as a standalone HTML page.

    The page embeds the GeoLibre app in an ``<iframe>`` and injects the project
    into it over the same ``postMessage`` bridge the widget uses, so it renders
    the map as configured. Credentials are stripped from the inlined project on
    the way out, exactly as :meth:`Map.to_html` does.

    This is the widget-free half of :meth:`Map.to_html`; the MCP server calls it
    to export a project that was never attached to a live map.

    Args:
        project: The project dict to embed.
        title: The exported page's ``<title>``.
        width: CSS width of the embedded map (e.g. ``"100%"`` or ``"800px"``).
        height: CSS height of the embedded map.
        app_url: Base URL of the GeoLibre app to embed. Defaults to
            :data:`DEFAULT_HTML_APP_URL`.

    Returns:
        The HTML document as a string.

    Raises:
        ValueError: If ``width`` or ``height`` is not a plain CSS dimension, or
            ``app_url`` is not an ``http``/``https`` URL.
    """
    base_url = app_url or DEFAULT_HTML_APP_URL
    # The project is posted into the frame, so the app URL decides where it
    # lands. Pin it to http(s) with a real host, and post to that exact origin
    # rather than "*": the MCP server takes app_url straight from a tool call,
    # and a model can pick an argument up from content it is reading. A
    # redacted project still carries inlined features and layer URLs.
    origin = urllib.parse.urlsplit(base_url)
    if origin.scheme not in ("http", "https") or not origin.netloc:
        raise ValueError(f"to_html: app_url must be an http(s) URL, got {base_url!r}")
    app_origin = f"{origin.scheme}://{origin.netloc}"
    # Force the embed bridge on (isEmbedded() honours ?embed=1). Insert the
    # parameter into the query string *before* any URL fragment: a "#..."
    # fragment would otherwise swallow a trailing "?embed=1" (browsers read it
    # as part of the fragment), so the app never sees the flag. partition keeps
    # the fragment and its "#" intact when present and yields "" when absent.
    base, hash_sep, fragment = base_url.partition("#")
    separator = "&" if "?" in base else "?"
    iframe_src = f"{base}{separator}embed=1{hash_sep}{fragment}"
    # width/height land inside a <style> rule; _html_escape does not neutralise
    # CSS metacharacters like "}" or ";", so validate them as plain CSS
    # dimensions to keep a stray value from closing the rule and injecting CSS.
    if not _CSS_DIMENSION_RE.match(width):
        raise ValueError(f"to_html: invalid CSS width value {width!r}")
    if not _CSS_DIMENSION_RE.match(height):
        raise ValueError(f"to_html: invalid CSS height value {height!r}")
    # Inline the project inside a JSON <script> block and escape "<" so a
    # property value can never break out of the script element; "<" is valid
    # JSON that JSON.parse restores to "<".
    project_json = json.dumps(_project.redact_credentials(project)).replace("<", "\\u003c")
    return _HTML_EXPORT_TEMPLATE.format(
        title=_html_escape(title),
        width=_html_escape(width),
        height=_html_escape(height),
        iframe_src=_html_escape(iframe_src),
        project_json=project_json,
        # json.dumps supplies the surrounding quotes, so the template field is
        # the whole JS string literal.
        app_origin=json.dumps(app_origin),
    )


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
        values = [float(b) for b in bounds]
        if len(values) != 4:
            raise ValueError("bounds must contain [west, south, east, north]")
        if not all(math.isfinite(value) for value in values):
            raise ValueError("bounds must contain finite numbers")
        west, south, east, north = values
        if west > east or south > north:
            raise ValueError("bounds must satisfy west <= east and south <= north")
        self.request("fitBounds", {"bounds": values}, timeout=timeout)

    def zoom_to_bounds(
        self,
        bounds: list[float] | tuple[float, float, float, float],
        *,
        timeout: float = 10.0,
    ) -> None:
        """Fit the map to bounds (leafmap-style alias of :meth:`fit_bounds`)."""
        self.fit_bounds(bounds, timeout=timeout)

    def zoom_to_layer(self, layer: str | Layer, *, timeout: float = 10.0) -> None:
        """Fit the map to a layer, addressed by id, name, or layer handle."""
        resolved = self._resolve_layer(layer)
        self.request("zoomToLayer", {"layerId": resolved.id}, timeout=timeout)

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

    def list_whitebox_tools(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        """List the bundled Whitebox/GeoLibre WASM tools and their parameters.

        The catalog is resolved by the displayed app because the same browser
        runtime executes the tools. Display the map before calling this method.
        """
        return self.request("listWhiteboxTools", timeout=timeout)

    def run_whitebox_tool(
        self,
        tool_id: str,
        parameters: dict[str, Any] | None = None,
        *,
        timeout: float = 300.0,
    ) -> dict[str, Any]:
        """Run a bundled Whitebox tool locally in the browser via WASM.

        Dataset parameters may be layer ids or :class:`Layer` handles. Vector
        and raster outputs are added to the map automatically; a tool that
        writes a plain file instead (a CSV, GeoParquet, PMTiles, …) reports it
        in ``logs``, since only the Processing panel can download one.

        Args:
            tool_id: An id from :meth:`list_whitebox_tools`, such as ``"slope"``.
            parameters: Tool parameters. Pass a :class:`Layer` handle for an
                input-layer parameter, or its id as a string.
            timeout: Seconds to wait; terrain and LiDAR tools may need several
                minutes for large inputs.

        Returns:
            ``{"logs": [...], "resultLayerIds": [...]}``.
        """
        resolved = {
            key: self._resolve_layer(value).id if isinstance(value, Layer) else value
            for key, value in (parameters or {}).items()
        }
        return self.request(
            "runWhiteboxTool",
            {"id": str(tool_id), "params": resolved},
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
        html = render_project_html(
            self.project,
            title=title,
            width=width,
            height=height or self.height,
            app_url=app_url,
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

    @property
    def layer_names(self) -> list[str]:
        """Return layer display names in map order."""
        return [str(layer.name) for layer in self.layers]

    def get_layer(self, layer_id: str) -> Layer:
        """Return a :class:`Layer` handle for ``layer_id``.

        Raises:
            ValueError: If no layer with that id exists.
        """
        for layer in self.project.get("layers", []):
            if isinstance(layer, dict) and layer.get("id") == layer_id:
                return Layer(self, layer_id)
        raise ValueError(f"No layer with id {layer_id!r}")

    def find_layer(self, name: str) -> Layer | None:
        """Return the first layer named ``name``, or ``None`` when absent."""
        return next((layer for layer in self.layers if layer.name == name), None)

    def find_layer_index(self, name: str) -> int:
        """Return the index of the first layer named ``name``, or ``-1``."""
        return next((i for i, layer in enumerate(self.layers) if layer.name == name), -1)

    def _resolve_layer(self, layer: str | Layer) -> Layer:
        """Resolve a layer handle, id, or display name to a live layer."""
        if isinstance(layer, Layer):
            if layer._map is not self:
                raise ValueError("Layer belongs to a different map")
            # Access verifies that a stale handle has not been removed.
            layer._layer()
            return layer
        # Share the authoring resolver so scripting and the MCP tools agree on
        # what a reference means: an id wins outright, then an exact name, then a
        # case-insensitive one, and a name several layers share is an error rather
        # than an arbitrary pick. `find_layer` returns the first name match by
        # design (leafmap compatibility), so it is not the resolver for mutations.
        return Layer(self, str(_authoring.find_layer(self.project, str(layer))["id"]))

    def set_layer_visibility(self, layer: str | Layer, visible: bool = True) -> None:
        """Show or hide a layer addressed by id, name, or layer handle."""
        self._resolve_layer(layer).visible = visible

    def set_layer_opacity(self, layer: str | Layer, opacity: float) -> None:
        """Set a layer's opacity in ``[0, 1]``."""
        self._resolve_layer(layer).opacity = opacity

    def rename_layer(self, layer: str | Layer, name: str) -> None:
        """Rename a layer addressed by id, name, or handle.

        Args:
            layer: The layer to rename, by id, name, or handle.
            name: The new display name, surrounding whitespace stripped.

        Raises:
            ValueError: If ``name`` is blank or the reserved basemap pseudo-id.
        """
        handle = self._resolve_layer(layer)
        clean = self._clean_layer_name(name)
        self._update_project(lambda p: _authoring.update_layer(p, handle.id, name=clean))

    @staticmethod
    def _clean_layer_name(name: str) -> str:
        """Strip a display name and refuse a blank one.

        `authoring.update_layer` guards only the reserved basemap pseudo-id, so
        emptiness is checked here, matching the `name` setter. A layer named ""
        or "   " renders as a blank row that cannot be referenced back by name.
        """
        clean = str(name).strip()
        if not clean:
            raise ValueError("name must be a non-empty string")
        return clean

    def move_layer(self, layer: str | Layer, index: int) -> None:
        """Move a layer to ``index`` in the project's draw order.

        Negative indices count from the end the way sequence *indexing* does, so
        ``-1`` moves the layer to the last position (not ``list.insert(-1, ...)``,
        which would leave it second to last). Out-of-range indices are clamped.
        """
        handle = self._resolve_layer(layer)

        def _move(project: dict[str, Any]) -> None:
            destination = int(index)
            if destination < 0:
                destination = max(0, len(project.get("layers", [])) + destination)
            _authoring.update_layer(project, handle.id, index=destination)

        self._update_project(_move)

    def duplicate_layer(self, layer: str | Layer, *, name: str | None = None) -> str:
        """Duplicate a layer, returning the new layer id.

        The copy is appended to the draw order (drawn on top), the same place a
        newly added layer lands, rather than next to its source. Use
        :meth:`move_layer` to put it elsewhere.

        Args:
            layer: The layer to copy, by id, name, or handle.
            name: Name for the copy, surrounding whitespace stripped; defaults
                to the source name plus ``copy``.

        Raises:
            ValueError: If ``name`` is blank or the reserved basemap pseudo-id.
        """
        if name is not None:
            name = self._clean_layer_name(name)
        source = copy.deepcopy(self._resolve_layer(layer)._layer())
        source["id"] = str(uuid.uuid4())
        source["name"] = name if name is not None else f"{source.get('name', 'Layer')} copy"
        # `_add_layer` appends raw; `authoring.add_layer` is the entry point that
        # applies the reserved-name check `rename_layer` gets from `update_layer`.
        self._update_project(lambda p: _authoring.add_layer(p, source))
        return str(source["id"])

    def show_layer(self, layer: str | Layer) -> None:
        """Show a layer."""
        self.set_layer_visibility(layer, True)

    def hide_layer(self, layer: str | Layer) -> None:
        """Hide a layer."""
        self.set_layer_visibility(layer, False)

    def layer_properties(self, layer: str | Layer) -> dict[str, list[Any]]:
        """Return sampled property values for an inlined GeoJSON layer."""
        return _authoring.layer_properties(self._resolve_layer(layer)._layer())

    def column_values(self, layer: str | Layer, column: str) -> list[Any]:
        """Return one property column from an inlined GeoJSON layer."""
        return _authoring.column_values(self._resolve_layer(layer)._layer(), column)

    def describe(self) -> dict[str, Any]:
        """Return a compact, JSON-serializable project summary."""
        # Copy the summary, not the project: `describe_project` hands back the
        # live `mapView`, so the result needs detaching, but deep-copying the
        # project first would duplicate every inlined GeoJSON blob only to
        # report a feature count.
        return copy.deepcopy(_authoring.describe_project(self.project))

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

    def add_gdf(
        self,
        gdf: Any,
        name: str = "GeoDataFrame",
        *,
        column: str | None = None,
        **style: Any,
    ) -> str:
        """Add a GeoDataFrame, optionally styled by a numeric column."""
        if not hasattr(gdf, "__geo_interface__"):
            raise TypeError("gdf must provide a __geo_interface__")
        return self.add_data(gdf, column=column, name=name, **style)

    def add_kml(self, data: Any, name: str = "KML", **style: Any) -> str:
        """Add a local or remote KML/KMZ dataset."""
        return self.add_vector(data, name=name, data_format="kml", **style)

    def add_gpkg(
        self,
        data: Any,
        name: str = "GeoPackage",
        *,
        layer: str | None = None,
        **style: Any,
    ) -> str:
        """Add a local or remote GeoPackage, optionally selecting a table."""
        return self.add_vector(
            data,
            name=name,
            data_format="gpkg",
            source_layer=layer,
            **style,
        )

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

    def add_heatmap(
        self,
        points: Any,
        name: str = "Heatmap",
        *,
        radius: float = 30,
        intensity: float = 1,
        **style: Any,
    ) -> str:
        """Add point data using GeoLibre's density heatmap renderer."""
        # NaN and infinity slip past the comparisons below, so check finiteness
        # first rather than storing an unusable renderer setting.
        if not math.isfinite(float(radius)) or float(radius) <= 0:
            raise ValueError("radius must be a finite number greater than zero")
        if not math.isfinite(float(intensity)) or float(intensity) < 0:
            raise ValueError("intensity must be a finite non-negative number")
        style.setdefault("pointRenderer", "heatmap")
        style.setdefault("heatmapRadius", float(radius))
        style.setdefault("heatmapIntensity", float(intensity))
        return self.add_markers(points, name=name, **style)

    @staticmethod
    def _tabular_records(data: Any) -> list[dict[str, Any]]:
        """Convert a DataFrame, CSV path/URL/text, or row iterable to records."""
        if hasattr(data, "to_dict"):
            try:
                records = data.to_dict(orient="records")
            except TypeError:
                records = data.to_dict("records")
            if isinstance(records, list):
                return [dict(row) for row in records]
        if isinstance(data, (str, os.PathLike)):
            source = str(data)
            if source.startswith(("http://", "https://")):
                # Same defences as the remote GeoJSON fetch in project.py: reject
                # non-public hosts up front, re-check every redirect hop through
                # the shared opener, and bound the response. read(limit + 1)
                # detects an over-limit body without buffering the whole thing.
                _project._assert_public_url(source)
                try:
                    with _project._GEOJSON_OPENER.open(  # noqa: S310 - user URL
                        source, timeout=30
                    ) as response:
                        raw = response.read(_MAX_TABULAR_BYTES + 1)
                except (URLError, TimeoutError) as exc:
                    raise ValueError(f"Could not load CSV from URL: {source}") from exc
                if len(raw) > _MAX_TABULAR_BYTES:
                    raise ValueError("CSV response exceeds the 50 MB size limit")
                text = raw.decode("utf-8-sig")
            else:
                path = pathlib.Path(source).expanduser()
                if path.exists():
                    if path.stat().st_size > _MAX_TABULAR_BYTES:
                        raise ValueError(f"CSV file exceeds the 50 MB size limit: {source}")
                    text = path.read_text(encoding="utf-8-sig")
                else:
                    text = source
            reader = csv.DictReader(io.StringIO(text), restkey=_CSV_RESTKEY)
            return [dict(row) for row in reader]
        return [dict(row) for row in data]

    def add_xy_data(
        self,
        data: Any,
        x: str = "longitude",
        y: str = "latitude",
        name: str = "XY Data",
        **style: Any,
    ) -> str:
        """Add points from a DataFrame, CSV path/URL/text, or row mappings."""
        records = self._tabular_records(data)
        points: list[dict[str, Any]] = []
        for index, row in enumerate(records, start=1):
            if x not in row or y not in row:
                raise ValueError(f"Row {index} is missing coordinate columns {x!r} and/or {y!r}")
            point = {key: value for key, value in row.items() if key not in (x, y)}
            try:
                lng, lat = float(row[x]), float(row[y])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Row {index} has invalid coordinates") from exc
            # float() happily parses "nan"/"inf", which would produce a feature
            # with coordinates no renderer can place.
            if not math.isfinite(lng) or not math.isfinite(lat):
                raise ValueError(f"Row {index} has invalid coordinates")
            point.update(lng=lng, lat=lat)
            points.append(point)
        return self.add_markers(points, name=name, **style)

    def add_csv(
        self,
        data: Any,
        x: str = "longitude",
        y: str = "latitude",
        name: str = "CSV",
        **style: Any,
    ) -> str:
        """Add a CSV containing longitude and latitude columns."""
        return self.add_xy_data(data, x=x, y=y, name=name, **style)

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
        # build_choropleth_style rejects a wholly non-numeric column: graduated
        # stops would otherwise fall back to index-based breaks and succeed with
        # misleading symbology.
        choropleth_style = _authoring.build_choropleth_style(
            values,
            column,
            class_count=class_count,
            colormap=colormap,
            scheme=scheme,
        )
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
        # A local file is read and inlined as GeoJSON. Tile rendering is a
        # browser-only option, while source_layer is forwarded to GeoPandas for
        # multi-layer containers such as GeoPackage.
        if render_mode != "geojson":
            warnings.warn(
                "render_mode is ignored for local files; it only applies to "
                "remote URLs handled by the in-browser vector control.",
                stacklevel=2,
            )
        fc = _read_local_vector(data, data_format=data_format, source_layer=source_layer)
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

    def remove_layer(self, layer_id: str | Layer) -> None:
        """Remove a layer by id, display name, or handle.

        Args:
            layer_id: A layer id, display name, or :class:`Layer` handle.

        Raises:
            ValueError: If the reference matches no layer, or matches a display
                name several layers share. Removing an unknown layer used to be
                a silent no-op; it now reports the miss.
        """

        resolved_id = self._resolve_layer(layer_id).id
        self._update_project(lambda p: _authoring.remove_layer(p, resolved_id))

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
        self._update_project(
            lambda p: _authoring.set_view(p, center=(lng, lat), zoom=zoom),
        )

    # leafmap compatibility alias for set_center
    set_center_zoom = set_center

    def set_zoom(self, zoom: float) -> None:
        """Set the map zoom while preserving the other camera fields."""
        self._update_project(lambda p: _authoring.set_view(p, zoom=zoom))

    def set_bearing(self, bearing: float) -> None:
        """Set clockwise camera bearing in degrees."""
        self._update_project(lambda p: _authoring.set_view(p, bearing=bearing))

    def set_pitch(self, pitch: float) -> None:
        """Set camera pitch in degrees (clamped to the supported range)."""
        self._update_project(lambda p: _authoring.set_view(p, pitch=pitch))

    def fit_project_bounds(self, bounds: list[float] | tuple[float, float, float, float]) -> None:
        """Persist a fitted camera for ``[west, south, east, north]`` bounds.

        Unlike :meth:`fit_bounds`, this is a pure project mutation and does not
        require a live browser connection.
        """
        self._update_project(lambda p: _authoring.fit_bounds(p, bounds))

    @property
    def center(self) -> tuple[float, float]:
        """The persisted ``(longitude, latitude)`` camera center."""
        center = self.project.get("mapView", {}).get("center", [0, 0])
        return float(center[0]), float(center[1])

    @property
    def zoom(self) -> float:
        """The persisted camera zoom."""
        return float(self.project.get("mapView", {}).get("zoom", 0))

    @property
    def bearing(self) -> float:
        """The persisted clockwise camera bearing in degrees."""
        return float(self.project.get("mapView", {}).get("bearing", 0))

    @property
    def pitch(self) -> float:
        """The persisted camera pitch in degrees."""
        return float(self.project.get("mapView", {}).get("pitch", 0))

    @property
    def basemap(self) -> str | None:
        """The current basemap style URL, embedded credentials redacted.

        MapTiler, Stadia and others put an API key in the style URL itself, so
        this is swept like :attr:`Layer.source` rather than printed into a
        notebook cell. Read :attr:`project` for the URL exactly as stored.
        """
        value = self.project.get("basemapStyleUrl")
        return _project.redact_url(str(value)) if value is not None else None

    @property
    def name(self) -> str:
        """The project name."""
        return str(self.project.get("name", ""))

    @name.setter
    def name(self, value: str) -> None:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("name must be a non-empty string")
        self._update_project(lambda p: p.update(name=value.strip()))

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
        # Layer objects are resolved to ids here (authoring.py works on plain
        # project dicts and knows nothing about the Layer handle); the rest of
        # the validation and state building is shared with the MCP server.
        left = self._coerce_layer_ids(left_layers)
        right = self._coerce_layer_ids(right_layers)
        self._update_project(
            lambda p: _authoring.add_swipe(
                p,
                left_layers=left,
                right_layers=right,
                orientation=orientation,
                position=position,
                control_position=control_position,
            )
        )

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
        self._update_project(
            lambda p: _authoring.add_legend(
                p,
                title,
                legend_dict=legend_dict,
                labels=labels,
                colors=colors,
                builtin=builtin,
                position=position,
                shape=shape,
            )
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
        self._update_project(
            lambda p: _authoring.add_colorbar(
                p,
                colormap=colormap,
                vmin=vmin,
                vmax=vmax,
                label=label,
                units=units,
                colors=colors,
                orientation=orientation,
                position=position,
            )
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

    def to_project(self, *, keep_credentials: bool = False) -> dict[str, Any]:
        """Return a detached project dict.

        Credentials are removed by default so a returned project is safe to
        serialize or commit. Pass ``keep_credentials=True`` only for a trusted
        local workflow that must preserve authenticated layer configuration.
        """
        if keep_credentials:
            return copy.deepcopy(self.project)
        return _project.redact_credentials(self.project)

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

    def save_project(self, path: str, *, keep_credentials: bool = False) -> None:
        """Write the current project to a ``.geolibre.json`` file.

        Args:
            path: Destination file path. Parent directories are created if
                they do not already exist.
            keep_credentials: Preserve credentials for a trusted local file.
                Defaults to ``False`` so saved projects are safe to share.
        """
        out = pathlib.Path(path).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        project = (
            copy.deepcopy(self.project)
            if keep_credentials
            else _project.redact_credentials(self.project)
        )
        out.write_text(json.dumps(project, indent=2), encoding="utf-8")


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
        self._map.rename_layer(self, value)

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
        opacity = float(value)
        if not math.isfinite(opacity) or not 0 <= opacity <= 1:
            raise ValueError("opacity must be a finite number between 0 and 1")
        self._map._mutate_layer(self._id, lambda layer: layer.update(opacity=opacity))

    @property
    def style(self) -> dict[str, Any]:
        """A copy of the layer's style object."""
        return copy.deepcopy(self._layer().get("style", {}))

    @property
    def source(self) -> Any:
        """A detached copy of the layer source configuration.

        Credentials are swept the way :meth:`Map.to_project` sweeps them: a
        notebook auto-displays whatever a cell returns, and a source built with
        ``request_headers`` or a signed URL would otherwise print its secrets
        into an output that often gets committed or shared. Read
        :attr:`Map.project` for the record exactly as stored.
        """
        # Sweep the one field rather than the whole layer: `redact_layer` would
        # copy an inlined geojson blob first, only to discard it here.
        return _project.redact_layer_field(self._layer().get("source"))

    @property
    def data(self) -> dict[str, Any]:
        """A detached copy of the complete layer record.

        Credentials are swept, as in :attr:`source`. "Complete" is literal: an
        inlined ``geojson`` blob is copied whole, which for a large layer is
        tens of megabytes to copy and to display. Use :meth:`properties` or
        :meth:`Map.describe` when a summary will do.
        """
        return _project.redact_layer(self._layer())

    @property
    def index(self) -> int:
        """The layer's current index in draw order.

        Raises:
            ValueError: If the layer has been removed, matching the other
                accessors rather than raising ``StopIteration``.
        """
        self._layer()
        return next(i for i, layer in enumerate(self._map.layers) if layer.id == self._id)

    def set_style(self, **style: Any) -> None:
        """Merge style overrides into the layer (e.g. ``fillColor="#ff0000"``)."""

        def _apply(layer: dict[str, Any]) -> None:
            layer.setdefault("style", {}).update(style)

        self._map._mutate_layer(self._id, _apply)

    def get_features(self, *, timeout: float = 10.0) -> list[Feature]:
        """Return this layer's features (see :meth:`Map.get_features`)."""
        return self._map.get_features(self._id, timeout=timeout)

    def properties(self) -> dict[str, list[Any]]:
        """Return sampled property values for inlined GeoJSON."""
        return self._map.layer_properties(self)

    def column(self, name: str) -> list[Any]:
        """Return a property column from inlined GeoJSON."""
        return self._map.column_values(self, name)

    def move(self, index: int) -> None:
        """Move this layer to an index in draw order."""
        self._map.move_layer(self, index)

    def duplicate(self, *, name: str | None = None) -> Layer:
        """Duplicate this layer and return its new handle."""
        return self._map.get_layer(self._map.duplicate_layer(self, name=name))

    def zoom_to(self, *, timeout: float = 10.0) -> None:
        """Fit the map camera to this layer's extent."""
        self._map.zoom_to_layer(self, timeout=timeout)

    def remove(self) -> None:
        """Remove this layer from the map."""
        self._map.remove_layer(self._id)

    def __repr__(self) -> str:
        try:
            return f"Layer(id={self._id!r}, name={self.name!r}, type={self.type!r})"
        except ValueError:
            return f"Layer(id={self._id!r}, removed)"
