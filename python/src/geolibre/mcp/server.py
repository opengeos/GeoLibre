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
- `add_3d_tiles_layer` - an OGC 3D Tiles tileset.

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
        """List the named basemaps, color ramps, and legend presets available.

        Call this before guessing a basemap or colormap name; the names here are
        the ones the app renders identically.

        Returns:
            The basemap name-to-URL mapping, the color ramp names accepted by
            `classify_layer` and `add_colorbar`, and the built-in legend presets.
        """
        return {
            "basemaps": authoring.basemap_catalog(),
            "colorRamps": authoring.color_ramp_names(),
            "legendPresets": builtin_legend_names(),
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
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        if service == "wmts":
            layer = _project.wmts_layer(name, endpoint, tile_size=tile_size)
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
    def add_3d_tiles_layer(
        path: str,
        name: str,
        url: str,
        altitude_offset: float = 0,
        index: int | None = None,
    ) -> dict[str, Any]:
        """Add an OGC 3D Tiles tileset (photogrammetry meshes, 3D buildings).

        Args:
            path: Path to the `.geolibre.json` file.
            name: The layer's display name.
            url: URL of the tileset's `tileset.json`.
            altitude_offset: Metres to shift the tileset vertically, to correct
                a tileset that floats above or sinks below the terrain.
            index: Draw-order position; appended on top when omitted.

        Returns:
            The new layer's id and the project's updated layer count.
        """
        layer = _project.three_d_tiles_layer(name, url, altitude_offset=altitude_offset)
        return add(path, layer, index)

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
