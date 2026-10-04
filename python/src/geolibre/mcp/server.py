"""An MCP server that authors GeoLibre projects.

Every tool reads a ``.geolibre.json`` file, applies one change through
:mod:`geolibre.authoring`, and writes it back, so the project on disk is the
only state. Nothing here needs a browser, a running app, or the bundled web
build: the output is a project file the user opens in GeoLibre (desktop, web, or
Jupyter), or a standalone HTML page exported from it.

The ``mcp`` SDK is an optional dependency (``pip install "geolibre[mcp]"``); it
is imported here and nowhere else in the package, so the rest of ``geolibre``
keeps working without it.
"""

from __future__ import annotations

import argparse
import contextlib
import functools
import inspect
import os
import sys
from pathlib import Path
from typing import Any, Callable, Iterator

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .. import __version__, authoring
from .. import project as _project
from ..geolibre import render_project_html
from ..legends import builtin_legend_names
from . import live
from .workspace import EXPORT_SUFFIXES, PROJECT_SUFFIXES, Workspace, WorkspaceError

INSTRUCTIONS = """\
Use these tools whenever someone asks for a **map**: a choropleth, a web map, a
map of some place or dataset, or to plot/visualize data geographically. Reach
for them before writing plotting code by hand -- they produce a real
interactive map in a few calls, where geopandas/matplotlib/folium would take a
script and still give a flat image.

They author GeoLibre projects: `.geolibre.json` files that open in the GeoLibre
GIS app (desktop, web, or the `geolibre` Jupyter widget), and that `export_html`
turns into a standalone page anyone can open in a browser.

Prefer hand-written plotting code only when the ask is specifically for a static
figure (a PNG for a paper or slide), a projection GeoLibre does not render, or
number-crunching whose output happens to be tabular.

Typical flow: `create_project` -> one or more `add_*_layer` calls -> style and
frame it (`style_layer`, `classify_layer`, `set_view`, `add_legend`) ->
`export_html` if the user wants something they can open in a browser directly.

When GeoLibre Desktop is open, the `live_*` tools change that map on screen.
The user opens Processing → Jupyter Notebook once so the desktop relay is
listening; the panel can be closed after that. Call `live_status` first. Use
the file tools when the deliverable is a saved `.geolibre.json`, and `live_*`
when the user is looking at the app and wants it to move now. A live edit
stays in the open session until the user saves the project in the app.
Processing (buffer, clip, dissolve, ...) runs in the app, so it is live-only:
`live_list_algorithms`, then `live_run_algorithm`.

Beyond layers: `set_labels` and `set_layer_filter` label and filter a layer's
features, `set_plugin_state` stores a plugin's saved state, and
`set_story_map` / `add_story_chapter` build a scroll-driven story map.

Pick the layer tool by what the data *is*, not by file extension alone:
- `add_geojson_layer`  - vector data inlined into the project (a URL, a local
  file, or literal GeoJSON). Best for small/medium vector data you want to
  style, classify, or ship self-contained.
- `add_vector_layer`   - a large remote vector file (FlatGeobuf, GeoParquet,
  GeoJSON) read in place rather than inlined.
- `add_raster_layer`   - a Cloud Optimized GeoTIFF (COG).
- `add_tile_layer`     - a raster XYZ tile template with {z}/{x}/{y}.
- `add_tiles_layer`    - PMTiles or a vector tile service.
- `add_ogc_layer`      - a WMS or WMTS endpoint.
- `add_lidar_layer`    - a LAS/LAZ/COPC/EPT point cloud by URL.
- `add_3d_tiles_layer` - an OGC 3D Tiles tileset (URL or Cesium Ion asset id).
- `add_cesium_ion_layer` - a Cesium Ion asset (tileset or imagery) by id, 3D globe only.
- `add_czml_layer`     - a CZML dynamic 3D scene (orbits, vehicle tracks) by URL or
  inline packets, 3D globe only.

Layers are referenced by id or by display name. `describe_project` is the cheap
way to see what a project currently holds; it never echoes back inlined
feature data.
"""


#: Keys that mark a loaded JSON object as a GeoLibre project. ``load_project``
#: accepts any JSON object and seeds ``layers`` when it is absent, so without
#: this check an edit tool pointed at an unrelated JSON file inside a root —
#: ``package.json``, say — would load it, apply the change, and write a project
#: over it. Every project this package or the app writes carries both keys.
#: ``layers`` is deliberately not among them: it is neither exclusive to this
#: format (other map and style configs use a top-level ``layers`` array) nor
#: reliable, since ``load_project`` normalizes it onto whatever it loaded.
PROJECT_MARKERS = ("mapView", "basemapStyleUrl")


def _require_project(file: Path, project: dict[str, Any]) -> None:
    """Refuse to rewrite a JSON file that is not a GeoLibre project.

    Args:
        file: The resolved path the project was loaded from.
        project: The loaded JSON object.

    Raises:
        WorkspaceError: If the object carries no sign of being a project.
    """
    if any(key in project for key in PROJECT_MARKERS):
        return
    raise WorkspaceError(
        f"{file} does not look like a GeoLibre project (no "
        f"{' or '.join(PROJECT_MARKERS)} key). Refusing to overwrite it; call "
        "create_project to start a new one."
    )


def _build_layer(
    builder: Callable[..., dict[str, Any]],
    *args: Any,
    style: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Call a layer builder, reporting a colliding `style` key as a ValueError.

    Every builder takes ``**style``, so an unrecognized key is simply carried
    into the layer's style. A key that names one of the builder's own
    parameters (``source_url``, ``render_mode``, ``colormap``, ``picker``, ...)
    is different: it either arrives as a duplicate keyword and raises
    ``TypeError``, or — for a parameter this tool does not forward — binds to
    real behavior while the docstring promised style overrides. A model driving
    these tools sees only "style: object" in the schema, so guessing such a key
    is realistic, and either outcome should read back as a plain message naming
    the offending key.

    Args:
        builder: The ``geolibre.project`` layer builder to call.
        *args: Positional arguments for the builder.
        style: The caller-supplied style dict, merged in last.
        **kwargs: The tool's own keyword arguments for the builder.

    Returns:
        The built layer dict.

    Raises:
        ValueError: If a style key collides with a parameter of the builder.
    """
    style = style or {}
    # Compare against the builder's whole signature, not just the arguments this
    # tool forwards. A builder takes parameters the tool does not expose
    # (vector_layer's `picker`/`ingest_mode`, vector_tiles_layer's singular
    # `source_layer`), and those bind to real behavior rather than to **style —
    # so a model treating `style` as paint-only would silently flip them.
    reserved = {
        parameter.name
        for parameter in inspect.signature(builder).parameters.values()
        if parameter.kind is not inspect.Parameter.VAR_KEYWORD
    }
    collisions = sorted(set(style) & reserved)
    if collisions:
        raise ValueError(
            f"style keys {collisions} name parameters of this layer type, not style "
            "properties; pass them as their own arguments, or drop them."
        )
    try:
        return builder(*args, **kwargs, **style)
    except TypeError as exc:
        # A style key colliding with one of the builder's *positional*
        # parameters (name, url, data) lands here rather than above.
        raise ValueError(
            f"style contains a key this layer type takes as its own "
            f"parameter — pass it as that parameter instead ({exc})."
        ) from exc


def _reports_its_errors(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a tool so a rejected call tells the caller why it was rejected.

    Every validation failure in this package is a ``ValueError`` (``WorkspaceError``
    subclasses it), raised where the rule lives -- in :mod:`geolibre.authoring`,
    :mod:`geolibre.project`, :mod:`geolibre.mcp.workspace`, or a tool body here --
    so none of those modules has to import the MCP SDK. But the SDK reserves
    ``ToolError`` for a failure the tool *anticipated* and treats anything else as
    a crash, withholding its message: from mcp 2.1 the caller of, say,
    ``add_ogc_layer`` without ``layers`` sees only "Error executing tool
    add_ogc_layer" instead of the sentence naming the missing argument. An agent
    that cannot read why a call was rejected cannot correct it, so it retries the
    same call or gives up.

    Restating each failure as a ``ToolError`` at the tool boundary keeps the rules
    SDK-free and the messages intact. A crash still surfaces as a crash: only
    ``ValueError`` is translated, and the original stays attached as ``__cause__``
    for the server log.

    Every tool is synchronous. An ``async def`` one would return an unawaited
    coroutine from the wrapper and raise its ``ValueError`` after the ``try``
    below has exited, so its messages would be withheld again with nothing to
    show for the wrapper -- it is refused here rather than registered that way.

    Args:
        fn: The tool function to wrap.

    Returns:
        The same function, with anticipated failures restated as ``ToolError``.

    Raises:
        TypeError: If *fn* is a coroutine function.
    """
    if inspect.iscoroutinefunction(fn):
        raise TypeError(
            f"{fn.__name__} is async, which this wrapper cannot report errors for; "
            "give _reports_its_errors a coroutine branch that awaits fn inside the "
            "same try, and register the tool through that."
        )

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except ValueError as exc:
            raise ToolError(str(exc)) from exc

    return wrapper


def _summarize(path: Path, project: dict[str, Any], **extra: Any) -> dict[str, Any]:
    """Build a tool result: what changed, plus where the project now stands."""
    return {
        "path": str(path),
        "name": project.get("name"),
        "layerCount": len(authoring.layers_of(project)),
        **extra,
    }


def build_server(workspace: Workspace) -> MCPServer:
    """Create the MCP server, with every tool bound to *workspace*.

    Args:
        workspace: The directories the server may read and write within.

    Returns:
        A configured :class:`mcp.server.MCPServer`, not yet running.
    """
    server = MCPServer(
        name="geolibre",
        title="GeoLibre project authoring",
        instructions=INSTRUCTIONS,
        version=__version__,
    )

    def tool(**kwargs: Any) -> Callable[[Callable[..., Any]], Any]:
        """Register a tool, restating its anticipated failures for the caller.

        Stands in for ``@server.tool()`` on every tool below, so none of them can
        be registered without :func:`_reports_its_errors`; a bare
        ``@server.tool()`` would silently mask that tool's validation messages.

        Args:
            **kwargs: Forwarded to :meth:`MCPServer.tool` unchanged.

        Returns:
            The decorator to apply to the tool function.
        """
        register = server.tool(**kwargs)
        return lambda fn: register(_reports_its_errors(fn))

    @contextlib.contextmanager
    def edit(path: str) -> Iterator[tuple[Path, dict[str, Any]]]:
        """Load a project, yield it for mutation, and save it back.

        The write happens only if the body returns normally, so a tool that
        raises part-way leaves the file on disk untouched. The destination has
        to pass the same extension allowlist `create_project` writes through,
        and to look like a project, so no tool can rewrite an unrelated JSON
        file that happens to sit inside a root.
        """
        file = workspace.resolve_output(path, suffixes=PROJECT_SUFFIXES, overwrite=True)
        if not file.is_file():
            raise WorkspaceError(f"File not found: {file}")
        project = authoring.load_project(file)
        _require_project(file, project)
        yield file, project
        authoring.save_project(file, project)

    def load_geojson(data: Any) -> tuple[dict[str, Any], str | None]:
        """Coerce a GeoJSON input to a FeatureCollection and its source URL.

        A remote URL is fetched by ``load_featurecollection`` (which rejects
        non-public hosts); a local path is confined to the workspace first,
        since that helper would otherwise read anywhere the process can.
        """
        if isinstance(data, str):
            text = data.strip()
            if text.startswith(("http://", "https://")):
                return _project.load_featurecollection(text), text
            if not text.startswith(("{", "[")):
                local = workspace.resolve(text, must_exist=True)
                return _project.load_featurecollection(str(local)), None
        return _project.load_featurecollection(data), None

    def add(path: str, layer: dict[str, Any], index: int | None) -> dict[str, Any]:
        """Insert a built layer into the project at *path* and save."""
        with edit(path) as (file, project):
            layer_id = authoring.add_layer(project, layer, index=index)
        return _summarize(file, project, layerId=layer_id, layerName=layer.get("name"))

    # -- project lifecycle ----------------------------------------------------

    @tool()
    def create_project(
        path: str,
        name: str = "Untitled Project",
        center: list[float] | None = None,
        zoom: float | None = None,
        basemap: str | None = None,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        """Start a new map. The first call whenever someone asks for one.

        Use this for "make me a map of X", "a choropleth of Y", "show this data
        on a map", "build a web map", or any request whose deliverable is a map
        rather than a number or a static figure. Call it before writing any
        plotting code: the map that comes out is interactive and styleable, and
        `export_html` turns it into a page anyone can open in a browser.

        Creates a GeoLibre project (`.geolibre.json`). Follow it with the
        `add_*_layer` tools to put data on the map.

        Args:
            path: Where to write the project, ending in `.json` (conventionally
                `.geolibre.json`).
            name: The project's display name.
            center: Initial map center as `[longitude, latitude]`.
            zoom: Initial zoom level (0 is the whole world, ~14 is a city).
            basemap: A basemap name (`liberty`, `bright`, `positron`, `dark`,
                `fiord`) or a MapLibre style JSON URL. See `list_catalog`.
            overwrite: Replace the file if it already exists.

        Returns:
            The path written and the project's starting state.
        """
        file = workspace.resolve_output(path, suffixes=PROJECT_SUFFIXES, overwrite=overwrite)
        # `overwrite` says "replace the project there", not "replace whatever is
        # there". PROJECT_SUFFIXES admits any `.json`, so without this an agent
        # retrying with overwrite=True after an "already exists" error could
        # destroy an unrelated config. A file that cannot be read as a project
        # at all — malformed, not an object, oversized — is the case to refuse
        # hardest, not the one where the check falls away.
        if file.exists():
            try:
                existing = authoring.load_project(file)
            except ValueError as exc:
                raise WorkspaceError(
                    f"{file} exists and could not be read as a GeoLibre project ({exc}). "
                    "Refusing to overwrite it; delete it first if it is not wanted."
                ) from exc
            _require_project(file, existing)
        project = _project.build_empty_project(name, center=center)
        if zoom is not None:
            # Through set_view so the initial zoom is clamped to [0, 24] exactly
            # as a later set_view call would clamp it.
            authoring.set_view(project, zoom=zoom)
        if basemap:
            authoring.set_basemap(project, basemap)
        authoring.save_project(file, project)
        return _summarize(file, project, mapView=project["mapView"])

    @tool()
    def describe_project(path: str) -> dict[str, Any]:
        """Summarize a project: its camera, basemap, layers, and map controls.

        Inlined feature data is reported as a count, never echoed back, so this
        is safe to call on a project holding a large GeoJSON layer.

        Args:
            path: Path to the `.geolibre.json` file.

        Returns:
            The project overview, including one summary per layer.
        """
        file = workspace.resolve(path, must_exist=True)
        project = authoring.load_project(file)
        return {"path": str(file), **authoring.describe_project(project)}

    @tool()
    def list_catalog() -> dict[str, Any]:
        """List the named basemaps, color ramps, legend presets, and plugin ids.

        Call this before guessing a basemap or colormap name; the names here are
        the ones the app renders identically.

        Returns:
            The basemap name-to-URL mapping, the color ramp names accepted by
            `classify_layer` and `add_colorbar`, the built-in legend presets,
            and the built-in plugin ids `set_plugin_state` accepts.
        """
        return {
            "basemaps": authoring.basemap_catalog(),
            "colorRamps": authoring.color_ramp_names(),
            "legendPresets": builtin_legend_names(),
            "pluginStateIds": sorted(_project.PLUGIN_STATE_IDS),
            "workspaceRoots": [str(root) for root in workspace.roots],
        }

    # -- adding layers --------------------------------------------------------

    @tool()
    def add_geojson_layer(
        path: str,
        name: str,
        data: str,
        style: dict[str, Any] | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Put vector data on the map: points, lines, or polygons.

        The usual way to add a dataset you want to see and style, from a URL, a
        file, or GeoJSON you built yourself. The data travels inside the project
        file, so the result is self-contained and is the only kind
        `classify_layer` can turn into a choropleth. For a large remote file you
        would rather not inline, use `add_vector_layer`.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            data: An `http(s)://` URL, a file path inside the workspace, or
                literal GeoJSON text (a FeatureCollection, Feature, or bare
                geometry). Capped at 50 MB.
            style: Style overrides, e.g. `{"fillColor": "#ff0000",
                "strokeWidth": 1, "circleRadius": 4}`.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        # `data` is loaded inside the edit context, so the destination clears
        # every check `edit` makes — confinement, extension, and that the file
        # really is a project — before a 50 MB fetch or read is paid for.
        with edit(path) as (file, project):
            collection, source_url = load_geojson(data)
            layer = _build_layer(
                _project.geojson_layer,
                name,
                collection,
                source_url=source_url,
                style=style,
            )
            layer_id = authoring.add_layer(project, layer, index=index)
        return _summarize(file, project, layerId=layer_id, layerName=layer.get("name"))

    @tool()
    def add_vector_layer(
        path: str,
        name: str,
        url: str,
        render_mode: str = "geojson",
        data_format: str | None = None,
        source_layer: str | None = None,
        style: dict[str, Any] | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a remote vector file read in place instead of inlined.

        Use for FlatGeobuf, GeoParquet, or large GeoJSON served over HTTP, where
        copying the data into the project would be wasteful.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            url: URL of the vector file.
            render_mode: How the app renders it: `geojson` (load into a GeoJSON
                source) or `tiles` (tile it in the browser as you pan).
            data_format: Override the format detected from the URL (e.g.
                `flatgeobuf`, `geoparquet`, `geojson`).
            source_layer: Source layer name, for multi-layer sources.
            style: Style overrides.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        layer = _build_layer(
            _project.vector_layer,
            name,
            url,
            render_mode=render_mode,
            data_format=data_format,
            source_layer=source_layer,
            style=style,
        )
        return add(path, layer, index)

    @tool()
    def add_raster_layer(
        path: str,
        name: str,
        url: str,
        bands: list[int] | None = None,
        colormap: str | None = None,
        rescale: list[list[float]] | None = None,
        style: dict[str, Any] | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a Cloud Optimized GeoTIFF (COG) raster layer.

        The URL must be publicly readable and CORS-enabled: the app fetches the
        tiles from the browser.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            url: URL of the COG.
            bands: 1-based band indices to render, e.g. `[1]` for single-band or
                `[1, 2, 3]` for RGB.
            colormap: A ramp name for single-band data (see `list_catalog`).
            rescale: Per-band `[min, max]` value ranges, e.g. `[[0, 3000]]`.
            style: Style overrides.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        layer = _build_layer(
            _project.cog_layer,
            name,
            url,
            bands=bands,
            colormap=colormap,
            rescale=rescale,
            style=style,
        )
        return add(path, layer, index)

    @tool()
    def add_tile_layer(
        path: str,
        name: str,
        url: str,
        tile_size: int = 256,
        attribution: str | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a raster XYZ tile layer from a `{z}/{x}/{y}` URL template.

        This is how you add OpenStreetMap-style raster basemaps and imagery
        services. A vector *style* (as opposed to tiles) belongs in
        `set_basemap` instead.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            url: Tile URL template containing `{z}`, `{x}`, and `{y}`.
            tile_size: Tile edge in pixels, usually 256.
            attribution: Attribution text to credit the source.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        layer = _project.tile_layer(name, url, tile_size=tile_size, attribution=attribution)
        return add(path, layer, index)

    @tool()
    def add_ogc_layer(
        path: str,
        name: str,
        service: str,
        endpoint: str,
        layers: str | None = None,
        styles: str = "",
        image_format: str = "image/png",
        transparent: bool = True,
        tile_size: int = 256,
        version: str | None = "1.1.1",
        crs: str | None = None,
        bounds: list[float] | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a WMS or WMTS service layer.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            service: `wms` or `wmts`.
            endpoint: The service endpoint. For `wmts`, a full tile URL
                template.
            layers: WMS layer name(s), comma-separated. Required for `wms`.
            styles: WMS style name(s); the server default when empty.
            image_format: WMS image MIME type.
            transparent: Request a transparent background (WMS).
            tile_size: Tile edge in pixels.
            version: WMS protocol version, e.g. `1.1.1` or `1.3.0`.
            crs: The CRS WMS tiles are requested in; `EPSG:3857` when
                omitted. Check the capabilities first: if the layer does not
                list EPSG:3857, pass a CRS it does list, preferably a
                geographic one (`EPSG:4326`, `EPSG:4258`, `EPSG:6706`,
                `CRS:84`), otherwise a projected `EPSG:<code>` such as
                `EPSG:25832`. The desktop app redraws those tiles into Web
                Mercator; the web build and `export_html` pages cannot show
                them.
            bounds: The layer's extent as `[west, south, east, north]` in
                WGS84. A service layer has no geometry to derive it from, so
                without this "zoom to layer" cannot reach it. Read it from the
                capabilities document: `EX_GeographicBoundingBox` for WMS,
                `ows:WGS84BoundingBox` for WMTS. Both are already lon/lat,
                unlike a WMS 1.3.0 `BoundingBox CRS="EPSG:4326"`.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.

        Raises:
            ValueError: If `service` is not `wms` or `wmts`, if `layers` is
                missing for `wms`, if `bounds` is not four finite numbers
                with valid latitudes, or if `crs` is not a supported CRS or
                is given for `wmts`.
        """
        if service == "wmts":
            if crs is not None:
                # A WMTS template carries its own tile matrix set; there is no
                # GetMap request for a CRS to change.
                raise ValueError("add_ogc_layer: 'crs' applies only to service='wms'")
            layer = _project.wmts_layer(name, endpoint, tile_size=tile_size, bounds=bounds)
        elif service == "wms":
            if not layers:
                raise ValueError("add_ogc_layer: 'layers' is required when service='wms'")
            layer = _project.wms_layer(
                name,
                endpoint,
                layers,
                styles=styles,
                image_format=image_format,
                transparent=transparent,
                tile_size=tile_size,
                version=version,
                crs=crs,
                bounds=bounds,
            )
        else:
            raise ValueError(f"service must be 'wms' or 'wmts', got {service!r}")
        return add(path, layer, index)

    @tool()
    def add_tiles_layer(
        path: str,
        name: str,
        url: str,
        kind: str = "pmtiles",
        tile_type: str = "vector",
        source_layers: list[str] | None = None,
        style: dict[str, Any] | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a PMTiles archive or a vector tile service.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            url: PMTiles archive URL, or a `{z}/{x}/{y}.pbf` template for
                `kind="vector-tiles"`.
            kind: `pmtiles` or `vector-tiles`.
            tile_type: For PMTiles, whether the archive holds `vector` or
                `raster` tiles.
            source_layers: Named layers within the tileset to draw.
            style: Style overrides.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        if kind == "pmtiles":
            layer = _build_layer(
                _project.pmtiles_layer,
                name,
                url,
                tile_type=tile_type,
                source_layers=source_layers,
                style=style,
            )
        elif kind == "vector-tiles":
            layer = _build_layer(
                _project.vector_tiles_layer,
                name,
                url,
                source_layers=source_layers,
                style=style,
            )
        else:
            raise ValueError(f"kind must be 'pmtiles' or 'vector-tiles', got {kind!r}")
        return add(path, layer, index)

    @tool()
    def add_lidar_layer(
        path: str,
        name: str,
        url: str,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a LiDAR point cloud from a LAS, LAZ, COPC or EPT URL.

        COPC and EPT stream by level of detail; LAS/LAZ download whole. The app
        re-streams it when the project opens, and its Point Cloud Annotation
        plugin can label its points.

        Args:
            path: Path to the `.geolibre.json` file.
            name: Layer display name.
            url: HTTP(S) URL of a `.las`, `.laz`, `.copc.laz` file or an EPT
                `ept.json`.
            index: Draw-order position; omit to add on top.

        Returns:
            A summary of the added layer.
        """
        return add(path, _project.lidar_layer(name, url), index)

    @tool()
    def get_point_cloud_annotations(path: str) -> dict[str, Any]:
        """Read the point labels and 3D boxes saved by the point cloud annotator.

        Args:
            path: Path to the `.geolibre.json` file.

        Returns:
            Per source URL, how many points were relabelled per class and how
            many points each instance (object) id holds; the project's custom
            classes; the 3D vectors (`kind` polyline/polygon/keypoint with
            `points` [lng, lat, elevation m]); and every saved 3D box
            (`class_code`, `center` [lng, lat, elevation m], `size` [length,
            width, height] m, `yaw` radians from east, `status`
            new/reviewed/flagged, and free-form `attributes`).
        """
        file = workspace.resolve(path, must_exist=True)
        project = authoring.load_project(file)
        annotations = _project.point_cloud_annotations(project)
        # Source URLs can be signed (e.g. a presigned S3 link); report them the
        # way the rest of the project is shared, with credentials stripped.
        labels: dict[str, dict[str, int]] = {}
        for url, nodes in annotations["labels"].items():
            url = _project.redact_url(url)
            # Two signed links to one cloud redact to the same URL: merge them.
            counts = labels.setdefault(url, {})
            for edits in nodes.values():
                for code in edits.values():
                    counts[str(code)] = counts.get(str(code), 0) + 1
        boxes = [{**box, "url": _project.redact_url(box["url"])} for box in annotations["boxes"]]
        # Instances as point counts per id, like the labels, not every point.
        instances: dict[str, dict[str, int]] = {}
        for url, nodes in annotations["instances"].items():
            counts = instances.setdefault(_project.redact_url(url), {})
            for edits in nodes.values():
                for instance in edits.values():
                    counts[str(instance)] = counts.get(str(instance), 0) + 1
        return {
            "labels": labels,
            "instances": instances,
            "boxes": boxes,
            "vectors": [
                {**vector, "url": _project.redact_url(vector["url"])}
                for vector in annotations["vectors"]
            ],
            "classes": annotations["classes"],
        }

    @tool()
    def set_point_cloud_classes(path: str, classes: list[dict[str, Any]]) -> dict[str, Any]:
        """Define the point cloud annotator's custom classes (its label schema).

        Custom classes extend the ASPRS standard classes (0-18) with codes the
        annotator can assign; the LiDAR layer draws them in their colour and
        names them in its legend. Existing labels, instances and boxes are kept.

        Args:
            path: Path to the `.geolibre.json` file.
            classes: `{"code", "name", "color"}` objects: `code` an integer
                19-255 (64-255 are the ASPRS user range), `name` text, `color`
                `"#rrggbb"`. An empty list clears them.

        Returns:
            The project summary with the classes as saved.
        """
        with edit(path) as (file, project):
            saved = authoring.set_point_cloud_classes(project, classes)
        return _summarize(file, project, classes=saved)

    def lidar_source(project: dict[str, Any], url: str) -> str:
        """Check `url` is one of the project's LiDAR layers and return it."""
        urls = authoring.lidar_source_urls(project)
        if url not in urls:
            listed = ", ".join(_project.redact_url(item) for item in urls) or "none"
            raise ValueError(
                f"No LiDAR layer in the project uses that URL (LiDAR layers: {listed})."
            )
        return url

    def point_cloud_file(path: str) -> Path:
        """Resolve an existing LAS/LAZ/COPC file inside the workspace."""
        file = workspace.resolve(path, must_exist=True)
        if file.suffix.lower() not in (".las", ".laz"):
            raise ValueError("The point cloud file must be a .las or .laz (COPC) file.")
        return file

    @tool()
    def prelabel_point_cloud(
        path: str,
        url: str,
        input_file: str,
        tool: str = "ground",
        only_unclassified: bool = True,
    ) -> dict[str, Any]:
        """Pre-label a LiDAR layer's points with a Whitebox classifier, headlessly.

        Runs the same classifiers as the app's Pre-label on a local copy of the
        layer's LAS/LAZ/COPC file and saves the changed classes as annotator
        labels for that layer (keyed by COPC node and index, so they apply when
        the app streams the layer). Needs `geolibre[pointcloud]`.

        Args:
            path: Path to the `.geolibre.json` file.
            url: The LiDAR layer's source URL the labels belong to.
            input_file: A local copy of that point cloud (same file as `url`).
            tool: `ground` (ground vs. other) or `ground-vegetation` (also marks
                vegetation).
            only_unclassified: Only relabel points still 0 or 1, keeping every
                class the survey or a user already set.

        Returns:
            How many points were relabelled into each class.
        """
        from geolibre import pointcloud as _pointcloud

        file = point_cloud_file(input_file)
        with edit(path) as (project_file, project):
            source = lidar_source(project, url)
            current, _ = _pointcloud.labels_for_source(project, source)
            labels = _pointcloud.prelabel_point_cloud(
                file, tool, current=current, only_unclassified=only_unclassified
            )
            authoring.merge_point_labels(project, source, labels)
        counts: dict[str, int] = {}
        for edits in labels.values():
            for code in edits.values():
                counts[str(code)] = counts.get(str(code), 0) + 1
        return _summarize(
            project_file,
            project,
            url=_project.redact_url(source),
            tool=tool,
            relabelled=sum(counts.values()),
            classes=counts,
        )

    @tool()
    def write_labeled_point_cloud(
        path: str,
        url: str,
        input_file: str,
        output_file: str,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        """Write a LiDAR layer's file with the project's point labels applied.

        Streams a local copy of the layer's LAS/LAZ/COPC file chunk by chunk and
        writes every point with the annotator's saved classes (and instance ids,
        as a uint32 `instance` dimension) applied, so labels made on the
        streamed view cover the full-resolution file. COPC input is written as
        plain LAS/LAZ. Needs `geolibre[pointcloud]`.

        Args:
            path: Path to the `.geolibre.json` file.
            url: The LiDAR layer's source URL whose labels to apply.
            input_file: A local copy of that point cloud.
            output_file: The `.las` or `.laz` file to write.
            overwrite: Replace an existing output file.

        Returns:
            How many points were written, relabelled and given an instance.
        """
        from geolibre import pointcloud as _pointcloud

        file = point_cloud_file(input_file)
        output = workspace.resolve_output(
            output_file, suffixes=(".las", ".laz"), overwrite=overwrite
        )
        if output == file:
            raise ValueError("The output must be a different file from the input.")
        project = authoring.load_project(workspace.resolve(path, must_exist=True))
        source = lidar_source(project, url)
        labels, instances = _pointcloud.labels_for_source(project, source)
        result = _pointcloud.write_labeled_point_cloud(file, output, labels, instances)
        return {"output": str(output), "url": _project.redact_url(source), **result}

    @tool()
    def add_3d_tiles_layer(
        path: str,
        name: str,
        url: str | None = None,
        ion_asset_id: int | None = None,
        altitude_offset: float = 0,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add an OGC 3D Tiles tileset (photogrammetry meshes, 3D buildings).

        Pass either a `tileset.json` URL or a Cesium Ion asset id. An Ion asset
        (for example 96188, Cesium OSM Buildings) renders on the 3D globe only,
        which loads it with the app's Cesium Ion token.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            url: URL of the tileset's `tileset.json`.
            ion_asset_id: A Cesium Ion asset id, instead of `url`.
            altitude_offset: Metres to shift the tileset vertically, to correct
                a tileset that floats above or sinks below the terrain.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        layer = _project.three_d_tiles_layer(
            name, url, ion_asset_id=ion_asset_id, altitude_offset=altitude_offset
        )
        return add(path, layer, index)

    @tool()
    def add_cesium_ion_layer(
        path: str,
        name: str,
        asset_id: int,
        kind: str = "3d-tiles",
        altitude_offset: float = 0,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a Cesium Ion asset (a 3D Tiles tileset or imagery) by asset id.

        Renders on the 3D globe only (set the project's `primaryRenderer` to
        `"cesium"`), which loads the asset with the app's Cesium Ion token; the
        token is never written to the project.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            asset_id: The Cesium Ion asset id (a positive integer).
            kind: `"3d-tiles"` for a tileset or `"imagery"` for an imagery asset.
            altitude_offset: Metres to shift a tileset vertically.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        layer = _project.cesium_ion_layer(
            name, asset_id, kind=kind, altitude_offset=altitude_offset
        )
        return add(path, layer, index)

    @tool()
    def add_czml_layer(
        path: str,
        name: str,
        url: str | None = None,
        data: list[dict[str, Any]] | dict[str, Any] | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a CZML (Cesium Language) dynamic 3D scene: orbits, tracks, moving models.

        Pass either the URL of a `.czml` document or its packets inline. Renders
        on the 3D globe only (set the project's `primaryRenderer` to
        `"cesium"`), which follows the document's `clock` packet for playback.

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            url: An `http(s)://` URL of a `.czml` document.
            data: The CZML packet array (or a single packet) to inline instead
                of a URL; the first packet is normally
                `{"id": "document", "version": "1.0"}`.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        layer = _project.czml_layer(name, url=url, data=data)
        return add(path, layer, index)

    @tool()
    def add_cesium_kml_layer(
        path: str,
        name: str,
        url: str | None = None,
        data: str | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add native KML/KMZ with document styles, overlays, and network links.

        Supply a document URL, inline XML, or a KMZ data URL. Renders on the
        globe only; set the project's primaryRenderer to "cesium".
        """
        return add(path, _project.cesium_kml_layer(name, url=url, data=data), index)

    # -- editing layers -------------------------------------------------------

    @tool()
    def update_layer(
        path: str,
        layer: str,
        name: str | None = None,
        visible: bool | None = None,
        opacity: float | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Rename a layer, toggle it, set its opacity, or reorder it.

        Only the arguments you pass take effect; the rest are left alone.

        Args:
            path: Path to the `.geolibre.json` file.
            layer: The layer's id or display name.
            name: A new display name.
            visible: Whether the layer draws.
            opacity: Opacity from 0 (invisible) to 1 (opaque).
            index: New draw-order position; 0 is the bottom of the stack.

        Returns:
            A summary of the updated layer.
        """
        with edit(path) as (file, project):
            summary = authoring.update_layer(
                project, layer, name=name, visible=visible, opacity=opacity, index=index
            )
        return _summarize(file, project, layer=summary)

    @tool()
    def remove_layer(path: str, layer: str) -> dict[str, Any]:
        """Remove a layer from the project.

        Args:
            path: Path to the `.geolibre.json` file.
            layer: The layer's id or display name.

        Returns:
            The removed layer's id and the project's updated layer count.
        """
        with edit(path) as (file, project):
            layer_id = authoring.remove_layer(project, layer)
        return _summarize(file, project, removedLayerId=layer_id)

    @tool()
    def style_layer(path: str, layer: str, style: dict[str, Any]) -> dict[str, Any]:
        """Set style properties on a layer, merging with what is already there.

        Common keys: `fillColor`, `fillOpacity`, `strokeColor`, `strokeWidth`,
        `circleRadius` (point size), `textColor`, `textSize`, `minZoom`,
        `maxZoom`. For a data-driven choropleth use `classify_layer` instead of
        writing the `vectorStyle*` keys by hand.

        Args:
            path: Path to the `.geolibre.json` file.
            layer: The layer's id or display name.
            style: The style keys to set. Keys you omit keep their values.

        Returns:
            The layer's full style after the merge.
        """
        with edit(path) as (file, project):
            merged = authoring.apply_style(project, layer, style)
        return _summarize(file, project, style=merged)

    @tool()
    def set_layer_popup(
        path: str,
        layer: str,
        fields: list[Any] | None = None,
        click: bool | None = None,
        title: str | None = None,
        title_expression: str | None = None,
        body_expression: str | None = None,
        show_feature_id: bool | None = None,
        max_width: int | None = None,
        image_height: int | None = None,
        tooltip: list[str] | None = None,
        merge: bool = False,
    ) -> dict[str, Any]:
        """Choose what a layer shows when a feature is clicked or hovered.

        Without a popup config a layer shows its name and every visible
        property. A config narrows that to the fields you list, in your order,
        under your labels and formats.

        Each entry of `fields` is either a property name or an object with
        `field` plus any of: `label`, `kind` (`auto`, `text`, `number`, `date`,
        `link`, or `image` — `link` renders an http(s) URL as an anchor and
        `image` renders one as a thumbnail), `hover`, `decimals`, `thousands`,
        `date_format` (`date`, `datetime`, `time`, `iso`, `year`), `prefix`,
        `suffix`, and `link_label`.

        Args:
            path: Path to the `.geolibre.json` file.
            layer: The layer's id or display name.
            fields: The fields to show, in display order.
            click: False suppresses the click popup for this layer.
            title: Property whose value titles the popup instead of the name.
            title_expression: MapLibre expression source producing the title.
            body_expression: MapLibre expression source producing the body as
                one block of text instead of the field rows.
            show_feature_id: False drops the synthetic `id` row.
            max_width: Widest the click popup may draw, in CSS pixels (288 to
                1200). The viewport still caps it.
            image_height: Tallest an `image` field's thumbnail may draw inside
                the popup, in CSS pixels (40 to 1200). Thumbnails keep their
                aspect ratio, so raise `max_width` too for a landscape photo to
                use the extra height.
            tooltip: Property names to show in a hover tooltip. An empty list
                turns the tooltip off.
            merge: Merge into the layer's existing popup config instead of
                replacing it.

        Returns:
            The layer's popup config after the change.
        """
        with edit(path) as (file, project):
            config = authoring.set_popup(
                project,
                layer,
                fields,
                click=click,
                title=title,
                title_expression=title_expression,
                body_expression=body_expression,
                show_feature_id=show_feature_id,
                max_width=max_width,
                image_height=image_height,
                tooltip=tooltip,
                merge=merge,
            )
        return _summarize(file, project, popup=config)

    @tool()
    def classify_layer(
        path: str,
        layer: str,
        column: str,
        class_count: int = 5,
        colormap: str = "viridis",
        scheme: str = "equal-interval",
    ) -> dict[str, Any]:
        """Color a layer by the values in one numeric column: a choropleth.

        This is the tool for "choropleth", "thematic map", "color the states by
        population", "shade by density", or any request to map a quantity onto
        existing shapes. It computes the class breaks and colors for you, so you
        do not need to build a color scale by hand.

        Works on layers whose GeoJSON is inlined in the project (those added
        with `add_geojson_layer`). Use `list_layer_properties` first if you do
        not know the column names.

        Args:
            path: Path to the `.geolibre.json` file.
            layer: The layer's id or display name.
            column: The numeric feature property to classify.
            class_count: Number of classes, clamped to 2-12.
            colormap: A color ramp name (see `list_catalog`).
            scheme: `equal-interval` (even value ranges) or `quantile` (even
                feature counts per class).

        Returns:
            The computed symbology, including its class breaks and colors.
        """
        with edit(path) as (file, project):
            fragment = authoring.classify_layer(
                project,
                layer,
                column,
                class_count=class_count,
                colormap=colormap,
                scheme=scheme,
            )
        return _summarize(file, project, symbology=fragment)

    @tool()
    def list_layer_properties(path: str, layer: str) -> dict[str, Any]:
        """List the feature properties of a layer, with sample values.

        Reveals what a layer can be styled or classified by. Only works on
        layers whose GeoJSON is inlined in the project.

        Args:
            path: Path to the `.geolibre.json` file.
            layer: The layer's id or display name.

        Returns:
            A mapping of property name to up to 25 distinct sample values.
        """
        file = workspace.resolve(path, must_exist=True)
        project = authoring.load_project(file)
        target = authoring.find_layer(project, layer)
        return {
            "path": str(file),
            "layerId": target.get("id"),
            "layerName": target.get("name"),
            "properties": authoring.layer_properties(target),
        }

    # -- camera, basemap, and controls ---------------------------------------

    @tool()
    def set_renderer(path: str, renderer: str, pane_id: str | None = None) -> dict[str, Any]:
        """Select maplibre, cesium, mapbox, or arcgis for the primary map or a secondary pane ID."""
        with edit(path) as (file, project):
            authoring.set_renderer(project, renderer, pane_id=pane_id)
        return _summarize(file, project, renderer=renderer, paneId=pane_id)

    @tool()
    def set_map_layout(
        path: str, rows: int, cols: int, view_kinds: list[str] | None = None, sync_view: bool = True
    ) -> dict[str, Any]:
        """Set a 1–4 row/column grid; view_kinds lists each pane renderer, primary first."""
        with edit(path) as (file, project):
            panes = authoring.set_map_layout(
                project, rows, cols, view_kinds=view_kinds, sync_view=sync_view
            )
        return _summarize(file, project, secondaryMapViews=panes)

    @tool()
    def set_view(
        path: str,
        center: list[float] | None = None,
        zoom: float | None = None,
        bearing: float | None = None,
        pitch: float | None = None,
        bbox: list[float] | None = None,
    ) -> dict[str, Any]:
        """Set the camera the project opens at.

        Pass `bbox` to frame an area and have the center and zoom computed for
        it; the fit assumes a typical desktop map pane, so treat the resulting
        zoom as approximate. Pass `center`/`zoom` to set them exactly.

        Args:
            path: Path to the `.geolibre.json` file.
            center: `[longitude, latitude]`.
            zoom: Zoom level, 0 (world) to 24 (building).
            bearing: Map rotation in degrees; 0 is north-up.
            pitch: Tilt in degrees, 0 (straight down) to 85.
            bbox: `[min_lng, min_lat, max_lng, max_lat]` to frame. Applied
                before `center`/`zoom`, so those still win if both are given
                (and the framed box is then dropped, not left describing an
                extent the camera no longer shows).

        Returns:
            The project's camera after the change.
        """
        with edit(path) as (file, project):
            if bbox is not None:
                authoring.fit_bounds(project, bbox)
            view = authoring.set_view(
                project, center=center, zoom=zoom, bearing=bearing, pitch=pitch
            )
        return _summarize(file, project, mapView=view)

    @tool()
    def set_basemap(path: str, basemap: str) -> dict[str, Any]:
        """Set the project's background basemap.

        Args:
            path: Path to the `.geolibre.json` file.
            basemap: A basemap name (`liberty`, `bright`, `positron`, `dark`,
                `fiord`) or a MapLibre style JSON URL.

        Returns:
            The resolved basemap style URL.
        """
        with edit(path) as (file, project):
            url = authoring.set_basemap(project, basemap)
        return _summarize(file, project, basemapStyleUrl=url)

    @tool()
    def add_legend(
        path: str,
        title: str | None = None,
        legend_dict: dict[str, str] | None = None,
        labels: list[str] | None = None,
        colors: list[str] | None = None,
        builtin: str | None = None,
        position: str = "bottom-left",
        shape: str = "square",
    ) -> dict[str, Any]:
        """Add a legend control to the map.

        Supply the entries exactly one way: `builtin` for a preset, or
        `legend_dict` as `{label: color}`, or matching `labels` and `colors`
        lists.

        Args:
            path: Path to the `.geolibre.json` file.
            title: The legend's title. Defaults to the preset's title, or
                "Legend".
            legend_dict: Label-to-CSS-color mapping, in display order.
            labels: Item labels, paired position-wise with `colors`.
            colors: Item CSS colors, paired position-wise with `labels`.
            builtin: A preset name, e.g. `nlcd` or `esa_worldcover` (see
                `list_catalog`).
            position: `top-left`, `top-right`, `bottom-left`, or
                `bottom-right`.
            shape: Swatch shape: `square`, `circle`, or `line`.

        Returns:
            The legend that was added.
        """
        with edit(path) as (file, project):
            entry = authoring.add_legend(
                project,
                title,
                legend_dict=legend_dict,
                labels=labels,
                colors=colors,
                builtin=builtin,
                position=position,
                shape=shape,
            )
        return _summarize(file, project, legend=entry)

    @tool()
    def set_map_legend(
        path: str,
        title: str | None = None,
        position: str | None = None,
        group_by_layer: bool | None = None,
        visible: bool | None = None,
        collapsed: bool | None = None,
    ) -> dict[str, Any]:
        """Show the map legend, built from the layers' own symbology.

        This is the app's Controls > Legend panel: its rows come from each
        visible layer's style (graduated classes, categories, ramps), so it
        needs no entries. Use `add_legend` for hand-written entries instead. A
        project has one map legend; calling this again updates it.

        Args:
            path: Path to the `.geolibre.json` file.
            title: Heading above the entries. Keeps the current one when
                omitted.
            position: `top-left`, `top-right`, `bottom-left`, or
                `bottom-right`. Keeps the current corner when omitted.
            group_by_layer: Group each layer's classes under a layer heading.
                Keeps the current setting when omitted.
            visible: Whether the on-map panel is open. Keeps the current
                state when omitted; a new legend opens.
            collapsed: Whether the open panel is collapsed to its header.
                Keeps the current state when omitted.

        Returns:
            The project's map legend config.
        """
        with edit(path) as (file, project):
            legend = authoring.set_map_legend(
                project,
                title,
                position=position,
                group_by_layer=group_by_layer,
                visible=visible,
                collapsed=collapsed,
            )
        return _summarize(file, project, mapLegend=legend)

    @tool()
    def add_colorbar(
        path: str,
        colormap: str = "viridis",
        vmin: float = 0.0,
        vmax: float = 1.0,
        label: str = "",
        units: str = "",
        colors: list[str] | None = None,
        orientation: str = "vertical",
        position: str = "bottom-right",
    ) -> dict[str, Any]:
        """Add a colorbar control, for a continuous raster or graduated layer.

        Args:
            path: Path to the `.geolibre.json` file.
            colormap: A ramp name (see `list_catalog`). Ignored if `colors` is
                given.
            vmin: Value at the low end. Must be less than `vmax`.
            vmax: Value at the high end.
            label: Title shown alongside the bar.
            units: Units suffix shown with the values, e.g. `m` or `degC`.
            colors: CSS colors defining a custom gradient instead of a ramp.
            orientation: `vertical` or `horizontal`.
            position: `top-left`, `top-right`, `bottom-left`, or
                `bottom-right`.

        Returns:
            The colorbar that was added.
        """
        with edit(path) as (file, project):
            entry = authoring.add_colorbar(
                project,
                colormap=colormap,
                vmin=vmin,
                vmax=vmax,
                label=label,
                units=units,
                colors=colors,
                orientation=orientation,
                position=position,
            )
        return _summarize(file, project, colorbar=entry)

    @tool()
    def add_swipe(
        path: str,
        left_layers: list[str],
        right_layers: list[str],
        orientation: str = "vertical",
        position: float = 50,
        control_position: str = "top-right",
    ) -> dict[str, Any]:
        """Configure the split-map (swipe) comparison control.

        Args:
            path: Path to the `.geolibre.json` file.
            left_layers: Layer ids or names shown left of (or above) the
                slider. Use `__basemap__` for the basemap.
            right_layers: Layer ids or names shown right of (or below) it.
            orientation: `vertical` (slider moves left/right) or `horizontal`.
            position: Starting slider position, 0-100 percent.
            control_position: Corner for the swipe panel.

        Returns:
            The swipe configuration that was written.
        """
        with edit(path) as (file, project):
            state = authoring.add_swipe(
                project,
                left_layers=authoring.resolve_layer_ids(project, left_layers),
                right_layers=authoring.resolve_layer_ids(project, right_layers),
                orientation=orientation,
                position=position,
                control_position=control_position,
            )
        return _summarize(file, project, swipe=state)

    # -- filters, labels, plugin state ----------------------------------------

    @tool()
    def set_layer_filter(
        path: str, layer: str, expression: list[Any] | str | None = None
    ) -> dict[str, Any]:
        """Hide a layer's features that do not match a boolean expression.

        This is the saved filter the app's Select by Expression → Filter layer
        writes. The data is untouched; non-matching features are not drawn.

        Args:
            path: Path to the `.geolibre.json` file.
            layer: The layer's id or display name.
            expression: A boolean MapLibre expression, as an array or a JSON
                string, e.g. `[">=", ["get", "population"], 100000]` or
                `["all", ["==", ["get", "state"], "TN"], [">", ["get", "pop"], 0]]`.
                Omit it (or pass null) to clear the filter.

        Returns:
            The layer summary with the filter now set.
        """
        with edit(path) as (file, project):
            summary = authoring.set_layer_filter(project, layer, expression)
        return _summarize(file, project, layer=summary)

    @tool()
    def set_labels(
        path: str,
        layer: str,
        field: str | None = None,
        expression: list[Any] | str | None = None,
        enabled: bool | None = None,
        placement: str | None = None,
        size: float | None = None,
        color: str | None = None,
        halo_color: str | None = None,
        halo_width: float | None = None,
        min_zoom: float | None = None,
        max_zoom: float | None = None,
        allow_overlap: bool | None = None,
        anchor: str | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Label a vector layer's features from a property or an expression.

        Settings you omit keep the layer's current label settings, so a call
        can restyle labels without restating the field.

        Args:
            path: Path to the `.geolibre.json` file.
            layer: The layer's id or display name.
            field: Property whose value becomes the label text.
            expression: MapLibre expression for the label text, overriding
                `field`, e.g. `["concat", ["get", "name"], " (", ["get", "pop"], ")"]`.
                An empty string clears it.
            enabled: False hides the labels but keeps their settings, true
                shows them. Omitted, they keep their current state (on for a
                layer that had no labels).
            placement: `point` (at the feature or centroid) or `line` (along
                lines).
            size: Text size in pixels.
            color: Text color (CSS).
            halo_color: Halo color drawn behind the text.
            halo_width: Halo width in pixels.
            min_zoom: Lowest zoom labels show at (0-24).
            max_zoom: Highest zoom labels show at (0-24).
            allow_overlap: Draw colliding labels instead of hiding them.
            anchor: Where the text sits relative to its point: `center`,
                `left`, `right`, `top`, `bottom`, `top-left`, `top-right`,
                `bottom-left`, `bottom-right`.
            options: Further settings by name: `offset_x`, `offset_y`,
                `rotation`, `max_width`, `transform` (`none`, `uppercase`,
                `lowercase`), `number_format`, `number_decimals`,
                `number_locale`, `dedupe` (`off`, `unique`, `concatenate`),
                and the data-defined `size_expression`, `color_expression`,
                `opacity_expression`, `visibility_expression`,
                `priority_expression`.

        Returns:
            The layer's full label settings after the change.
        """
        named = {
            "placement": placement,
            "size": size,
            "color": color,
            "halo_color": halo_color,
            "halo_width": halo_width,
            "min_zoom": min_zoom,
            "max_zoom": max_zoom,
            "allow_overlap": allow_overlap,
            "anchor": anchor,
        }
        extra = dict(options or {})
        clash = sorted(set(extra) & ({"field", "expression", "enabled"} | set(named)))
        if clash:
            raise ValueError(f"pass {clash} as arguments, not inside options")
        with edit(path) as (file, project):
            labels = authoring.set_labels(
                project,
                layer,
                field,
                expression=expression,
                enabled=enabled,
                **named,
                **extra,
            )
        return _summarize(file, project, labels=labels)

    @tool()
    def set_plugin_state(
        path: str,
        plugin_id: str,
        state: Any = None,
        position: str | None = None,
        activate: bool = True,
        allow_unknown: bool = False,
        clear: bool = False,
    ) -> dict[str, Any]:
        """Store a plugin's saved state in the project, as the app saves it.

        Each plugin reads its own state shape when the project opens -- the
        Time Slider (`maplibre-gl-time-slider`) its timeline config, a grid
        plugin its resolution, and so on. Use `add_swipe`, `add_legend` and
        `add_colorbar` for those three controls instead; they validate their
        state. `list_catalog` lists the built-in plugin ids.

        Args:
            path: Path to the `.geolibre.json` file.
            plugin_id: A built-in plugin id, or an external plugin's id with
                `allow_unknown`.
            state: The plugin's settings object, as plain JSON. Omit it to
                keep the stored settings and change only `position` or
                `activate`.
            position: Control corner: `top-left`, `top-right`, `bottom-left`,
                or `bottom-right`.
            activate: Start the plugin active when the project opens.
            allow_unknown: Accept an id that is not a built-in plugin (one
                loaded from a manifest URL).
            clear: Remove the stored settings only; activation and position
                are left as they were.

        Returns:
            The plugin id, whether it is active, its position, and its state.
        """
        with edit(path) as (file, project):
            stored = authoring.set_plugin_state(
                project,
                plugin_id,
                state,
                position=position,
                activate=activate,
                allow_unknown=allow_unknown,
                clear=clear,
            )
        return _summarize(file, project, plugin=stored)

    # -- story map ------------------------------------------------------------

    @tool()
    def set_story_map(
        path: str,
        title: str | None = None,
        subtitle: str | None = None,
        byline: str | None = None,
        footer: str | None = None,
        theme: str | None = None,
        show_markers: bool | None = None,
        marker_color: str | None = None,
        inset: bool | None = None,
        inset_position: str | None = None,
        hide_chapter_nav: bool | None = None,
        start_slide: str | None = None,
        end_slide: str | None = None,
    ) -> dict[str, Any]:
        """Set a story map's title block and presentation settings.

        A story map is the scroll-driven narrative presented from Project →
        Story Map; add its chapters with `add_story_chapter`.

        Args:
            path: Path to the `.geolibre.json` file.
            title: Story title.
            subtitle: Subtitle under the title.
            byline: Author line.
            footer: Closing text.
            theme: `light` or `dark`.
            show_markers: Drop a marker at each chapter's location.
            marker_color: Marker color (CSS).
            inset: Show an overview inset map.
            inset_position: Inset corner: `top-left`, `top-right`,
                `bottom-left`, or `bottom-right`.
            hide_chapter_nav: Start with the chapter list hidden.
            start_slide: Intro slide: `none`, `blank`, `black`, `global`, or
                `adjacent`.
            end_slide: Closing slide, same choices as `start_slide`.

        Returns:
            The story settings and each chapter's id and title.
        """
        with edit(path) as (file, project):
            story = authoring.set_story_map(
                project,
                title=title,
                subtitle=subtitle,
                byline=byline,
                footer=footer,
                theme=theme,
                show_markers=show_markers,
                marker_color=marker_color,
                inset=inset,
                inset_position=inset_position,
                hide_chapter_nav=hide_chapter_nav,
                start_slide=start_slide,
                end_slide=end_slide,
            )
        return _summarize(file, project, storymap=story)

    @tool()
    def add_story_chapter(
        path: str,
        title: str,
        description: str = "",
        center: list[float] | None = None,
        zoom: float | None = None,
        pitch: float | None = None,
        bearing: float | None = None,
        image: str | None = None,
        alignment: str = "left",
        hidden: bool = False,
        map_animation: str = "flyTo",
        rotate_animation: bool = False,
        on_enter: list[dict[str, Any]] | None = None,
        on_exit: list[dict[str, Any]] | None = None,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add a chapter to the project's story map.

        A camera value you omit is taken from the project's saved view.

        Args:
            path: Path to the `.geolibre.json` file.
            title: Chapter heading.
            description: Chapter body text.
            center: Camera target `[lng, lat]`.
            zoom: Camera zoom (0-24).
            pitch: Camera tilt in degrees (0-85).
            bearing: Camera rotation in degrees.
            image: Image URL shown in the chapter panel.
            alignment: Text panel position: `left`, `center`, `right`, or
                `full`.
            hidden: Hide the text panel while still moving the map.
            map_animation: `flyTo`, `easeTo`, or `jumpTo`.
            rotate_animation: Slowly rotate the camera after arriving.
            on_enter: Layer opacity changes on entering the chapter, as
                `{"layer": <id or name>, "opacity": 0-1, "duration": ms}`.
            on_exit: Layer opacity changes on leaving the chapter.
            index: 0-based position to insert at; appended when omitted.

        Returns:
            The chapter that was added, including its id.
        """
        with edit(path) as (file, project):
            chapter = authoring.add_story_chapter(
                project,
                title,
                description=description,
                center=center,
                zoom=zoom,
                pitch=pitch,
                bearing=bearing,
                image=image,
                alignment=alignment,
                hidden=hidden,
                map_animation=map_animation,
                rotate_animation=rotate_animation,
                on_enter=on_enter,
                on_exit=on_exit,
                index=index,
            )
        return _summarize(file, project, chapter=chapter)

    @tool()
    def remove_story_chapter(path: str, chapter: str | int) -> dict[str, Any]:
        """Remove a story chapter.

        Args:
            path: Path to the `.geolibre.json` file.
            chapter: The chapter's id, title, or 0-based index.

        Returns:
            The story settings and the remaining chapters.
        """
        with edit(path) as (file, project):
            story = authoring.remove_story_chapter(project, chapter)
        return _summarize(file, project, storymap=story)

    @tool()
    def move_story_chapter(path: str, chapter: str | int, index: int) -> dict[str, Any]:
        """Reorder a story chapter.

        Args:
            path: Path to the `.geolibre.json` file.
            chapter: The chapter's id, title, or 0-based index.
            index: The 0-based position to move it to.

        Returns:
            The story settings and the chapters in their new order.
        """
        with edit(path) as (file, project):
            story = authoring.move_story_chapter(project, chapter, index)
        return _summarize(file, project, storymap=story)

    # -- export ---------------------------------------------------------------

    @tool()
    def export_html(
        path: str,
        out_path: str,
        title: str = "GeoLibre Map",
        width: str = "100%",
        height: str = "800px",
        app_url: str | None = None,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        """Turn the map into a single HTML file anyone can open in a browser.

        Call this to finish the job whenever the user wants something they can
        look at, share, or send on, rather than a project file they would need
        the GeoLibre app to open.

        The page embeds the hosted GeoLibre viewer and injects the project into
        it, so it needs no install. Layers pointing at local files will not load
        for anyone but the author; use hosted URLs for a shareable export.
        Credentials in the project are stripped on the way out.

        Args:
            path: Path to the `.geolibre.json` file.
            out_path: Where to write the `.html` file.
            title: The page's browser-tab title.
            width: CSS width of the embedded map, e.g. `100%` or `960px`.
            height: CSS height of the embedded map.
            app_url: Base URL of the GeoLibre app to embed. Defaults to the
                hosted viewer; pass a self-hosted deployment to pin a version.
            overwrite: Replace the file if it already exists.

        Returns:
            The path written and its size in bytes.
        """
        file = workspace.resolve(path, must_exist=True)
        destination = workspace.resolve_output(
            out_path, suffixes=EXPORT_SUFFIXES, overwrite=overwrite
        )
        project = authoring.load_project(file)
        html = render_project_html(
            project, title=title, width=width, height=height, app_url=app_url
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(html, encoding="utf-8")
        return {
            "path": str(destination),
            "sourceProject": str(file),
            "bytes": len(html.encode("utf-8")),
        }

    # -- live desktop session -------------------------------------------------
    # These talk to the Jupyter relay GeoLibre Desktop already runs. They do
    # not write the project file; the user saves in the app when the session
    # should persist.

    @tool()
    def live_status() -> dict[str, Any]:
        """Report whether GeoLibre Desktop is listening for live commands.

        Open Processing → Jupyter Notebook once if this reports no relay. The
        panel can be closed afterwards; the server keeps running until the app
        quits.

        Returns:
            ``connected``, how many windows are subscribed, and the loopback
            relay URL with the token removed.
        """
        try:
            relay = live.discover()
        except live.LiveError as exc:
            return {"connected": False, "listeners": 0, "hint": str(exc)}
        if relay is None:
            return {"connected": False, "listeners": 0, "hint": live.NOT_CONNECTED}
        try:
            listeners = relay.listeners()
        except live.LiveError as exc:
            return {
                "connected": False,
                "listeners": 0,
                "url": relay.redacted_url,
                "hint": str(exc),
            }
        return {
            "connected": listeners > 0,
            "listeners": listeners,
            "url": relay.redacted_url,
        }

    @tool()
    def live_list_layers() -> list[dict[str, Any]]:
        """List the layers on the map open in GeoLibre Desktop.

        Returns:
            One dict per layer, with ``id``, ``name``, ``type``, ``visible``,
            and ``opacity``, in draw order.
        """
        value = live.require().call("listLayers")
        if not isinstance(value, list):
            raise ValueError(f"GeoLibre returned an unexpected layer list: {value!r}")
        return value

    @tool()
    def live_fly_to(
        lng: float | None = None,
        lat: float | None = None,
        zoom: float | None = None,
    ) -> dict[str, Any]:
        """Animate the camera of the map open in GeoLibre Desktop.

        Args:
            lng: Longitude. Pass it together with ``lat``.
            lat: Latitude. Pass it together with ``lng``.
            zoom: Zoom level. ``0`` is the world, about ``14`` is a city.

        Returns:
            The center and zoom that were sent.
        """
        if (lng is None) != (lat is None):
            raise ValueError("Pass both lng and lat, or neither.")
        params: dict[str, Any] = {}
        if lng is not None and lat is not None:
            params["center"] = [float(lng), float(lat)]
        if zoom is not None:
            params["zoom"] = float(zoom)
        if not params:
            raise ValueError("Pass a center, a zoom, or both.")
        live.require().call("flyTo", params)
        return {"center": params.get("center"), "zoom": zoom}

    @tool()
    def live_fit_bounds(bounds: list[float]) -> dict[str, Any]:
        """Fit the open map to ``[west, south, east, north]`` in degrees.

        Args:
            bounds: West, south, east, north.

        Returns:
            The bounds that were sent.
        """
        if len(bounds) != 4:
            raise ValueError("bounds must be [west, south, east, north].")
        sent = [float(value) for value in bounds]
        live.require().call("fitBounds", {"bounds": sent})
        return {"bounds": sent}

    @tool()
    def live_zoom_to_layer(layer_id: str) -> dict[str, Any]:
        """Fit the open map to one layer already on it.

        Args:
            layer_id: The layer id from ``live_list_layers``.

        Returns:
            The layer id that was framed.
        """
        live.require().call("zoomToLayer", {"layerId": layer_id})
        return {"layerId": layer_id}

    @tool()
    def live_set_basemap(basemap: str) -> dict[str, Any]:
        """Switch the basemap of the map open in GeoLibre Desktop.

        Args:
            basemap: A catalog name (``liberty``, ``bright``, ``positron``,
                ``dark``, ``fiord``) or an ``http(s)`` MapLibre style URL.

        Returns:
            The style URL applied.
        """
        from ..basemaps import resolve_basemap

        url = resolve_basemap(basemap)
        live.require().call("setBasemap", {"url": url})
        return {"basemap": url}

    @tool()
    def live_add_geojson(
        data: Any,
        name: str = "GeoJSON",
        style: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Add GeoJSON to the map open in GeoLibre Desktop.

        A local path is confined to the MCP workspace, the same way
        ``add_geojson_layer`` confines one. The layer is on the open map only
        until the user saves the project in the app.

        Args:
            data: A FeatureCollection, a JSON string, a workspace path, or an
                ``http(s)`` URL of public GeoJSON.
            name: The layer's display name.
            style: Style overrides such as ``fillColor`` and ``strokeColor``.

        Returns:
            The new layer id and name.
        """
        collection, _source = load_geojson(data)
        layer_id = live.require().call(
            "addGeoJsonLayer",
            {"name": name, "geojson": collection, "style": style or {}},
        )
        if not isinstance(layer_id, str) or not layer_id:
            raise ValueError(f"GeoLibre returned an unexpected layer id: {layer_id!r}")
        return {"layerId": layer_id, "layerName": name}

    @tool()
    def live_set_visibility(layer_id: str, visible: bool) -> dict[str, Any]:
        """Show or hide a layer on the open map.

        Args:
            layer_id: The layer id from ``live_list_layers``.
            visible: Whether the layer is shown.

        Returns:
            The layer id and the visibility that was sent.
        """
        live.require().call("setVisibility", {"layerId": layer_id, "visible": bool(visible)})
        return {"layerId": layer_id, "visible": bool(visible)}

    @tool()
    def live_set_opacity(layer_id: str, opacity: float) -> dict[str, Any]:
        """Set a layer's opacity on the open map.

        Args:
            layer_id: The layer id from ``live_list_layers``.
            opacity: A number from 0 (transparent) to 1 (opaque).

        Returns:
            The layer id and the opacity that was sent.
        """
        opacity = float(opacity)
        if not 0 <= opacity <= 1:
            raise ValueError(f"opacity must be between 0 and 1, got {opacity}")
        live.require().call("setOpacity", {"layerId": layer_id, "opacity": opacity})
        return {"layerId": layer_id, "opacity": opacity}

    @tool()
    def live_set_style(layer_id: str, style: dict[str, Any]) -> dict[str, Any]:
        """Update a layer's style on the open map.

        Args:
            layer_id: The layer id from ``live_list_layers``.
            style: Style keys such as ``fillColor`` and ``strokeWidth``.

        Returns:
            The layer id and the style that was sent.
        """
        live.require().call("setStyle", {"layerId": layer_id, "style": dict(style)})
        return {"layerId": layer_id, "style": dict(style)}

    @tool()
    def live_remove_layer(layer_id: str) -> dict[str, Any]:
        """Remove a layer from the open map.

        Args:
            layer_id: The layer id from ``live_list_layers``.

        Returns:
            The layer id that was removed.
        """
        live.require().call("removeLayer", {"layerId": layer_id})
        return {"layerId": layer_id}

    @tool()
    def live_list_algorithms(query: str | None = None) -> list[dict[str, Any]]:
        """List the processing algorithms the open GeoLibre Desktop can run.

        The catalog lives in the app (buffer, clip, dissolve, centroids, ...),
        so this needs the live relay. Pass `query` to narrow a long list.

        Args:
            query: Case-insensitive text matched against each algorithm's id,
                name, group, and description.

        Returns:
            One dict per algorithm with `id`, `name`, `group`, `description`,
            and `parameters` (each parameter's id, type, and default), the
            shape `live_run_algorithm` expects.
        """
        value = live.require().call("listAlgorithms")
        if not isinstance(value, list):
            raise ValueError(f"GeoLibre returned an unexpected algorithm list: {value!r}")
        if query:
            needle = query.casefold()
            value = [
                algorithm
                for algorithm in value
                if isinstance(algorithm, dict)
                and any(
                    needle in str(algorithm.get(key, "")).casefold()
                    for key in ("id", "name", "group", "description")
                )
            ]
        return value

    @tool()
    def live_run_algorithm(
        algorithm_id: str, parameters: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Run a processing algorithm on the map open in GeoLibre Desktop.

        Result layers are added to the open map, and the run is recorded in
        the app's Processing History. Layer parameters take a layer id from
        `live_list_layers`. The relay waits about five seconds for a result:
        a longer run keeps going in the app and reports that it did not
        finish in time, so check `live_list_layers` before retrying.

        Args:
            algorithm_id: An id from `live_list_algorithms` (e.g. `buffer`).
            parameters: The algorithm's parameters, keyed by parameter id.

        Returns:
            The algorithm's `logs` and the `resultLayerIds` it added.
        """
        value = live.require().call(
            "runAlgorithm", {"id": algorithm_id, "params": dict(parameters or {})}
        )
        if not isinstance(value, dict):
            raise ValueError(f"GeoLibre returned an unexpected run result: {value!r}")
        return value

    return server


def main(argv: list[str] | None = None) -> int:
    """Run the MCP server over stdio.

    Args:
        argv: Command-line arguments; ``sys.argv[1:]`` when omitted.

    Returns:
        A process exit code.
    """
    parser = argparse.ArgumentParser(
        prog="geolibre-mcp",
        description="MCP server that authors GeoLibre (.geolibre.json) projects.",
    )
    parser.add_argument(
        "--root",
        action="append",
        metavar="DIR",
        help=(
            "A directory the server may read and write within. Repeatable. "
            "Defaults to $GEOLIBRE_MCP_ROOTS, then the current directory."
        ),
    )
    parser.add_argument(
        "--transport",
        default="stdio",
        choices=("stdio", "streamable-http", "sse"),
        help="MCP transport (default: stdio, what desktop clients spawn).",
    )
    args = parser.parse_args(argv)

    try:
        workspace = Workspace(args.root)
    except WorkspaceError as exc:
        # stdout carries the protocol on stdio, so diagnostics go to stderr.
        print(f"geolibre-mcp: {exc}", file=sys.stderr)
        return 2
    print(
        f"geolibre-mcp {__version__} serving {os.pathsep.join(str(r) for r in workspace.roots)}",
        file=sys.stderr,
    )
    build_server(workspace).run(transport=args.transport)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
