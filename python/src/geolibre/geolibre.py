"""The GeoLibre Jupyter widget and its leafmap-style Python API."""

from __future__ import annotations

import copy
import json
import os
import pathlib
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


def _read_local_vector(path: Any) -> dict[str, Any]:
    """Read a local vector file into a GeoJSON FeatureCollection via GeoPandas.

    The browser cannot read a file that lives on the kernel host, so a local
    vector dataset is read here and inlined as GeoJSON (reprojected to EPSG:4326)
    instead of being streamed by the in-browser vector control. GeoPandas is an
    optional dependency, imported lazily so the rest of the API works without it.

    Args:
        path: Filesystem path to a vector file (Shapefile, GeoParquet,
            FlatGeobuf, GeoPackage, ...).

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
    # the GDAL build, so dispatch (Geo)Parquet to the dedicated reader.
    if file_path.suffix.lower() in (".parquet", ".geoparquet", ".pq"):
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
        max_features: int | None = None,
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
            max_features: Optional cap on the number of returned features.
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
            return self.add_geojson(data, name=name, **style)
        fc = _read_local_vector(data)
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
