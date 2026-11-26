"""Map methods that add raster and web service layers."""

from __future__ import annotations

import math
import os
import pathlib
import tempfile
import warnings
from collections.abc import Mapping
from typing import Any

from . import project as _project
from ._map_support import _EE_VECTOR_STYLE_KEYS as _EE_VECTOR_STYLE_KEYS
from ._server import register_local_file, register_raster_tiles


class _MapRasterMixin:
    """Map methods that add raster and web service layers."""

    def add_tile_layer(
        self,
        url: str,
        name: str = "Tile Layer",
        *,
        tile_size: int = 256,
        attribution: str | None = None,
        bounds: list[float] | None = None,
        **style: Any,
    ) -> str:
        """Add a raster XYZ tile layer.

        Args:
            url: An XYZ tile URL template (``{z}/{x}/{y}``).
            name: Layer display name.
            tile_size: Tile size in pixels.
            attribution: Optional attribution string.
            bounds: Optional ``[west, south, east, north]`` request bounds.
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
                bounds=bounds,
                **style,
            )
        )

    def add_planetary_computer(
        self,
        collection: str,
        item: str | None = None,
        name: str | None = None,
        *,
        datetime: str | tuple[str, str] | list[str] | None = None,
        bbox: list[float] | tuple[float, ...] | None = None,
        preset: str | None = None,
        assets: list[str] | None = None,
        expression: str | None = None,
        rescale: tuple[float, float] | list[float] | None = None,
        colormap: str | None = None,
        max_cloud_cover: float | None = None,
        visible: bool = True,
        opacity: float = 1.0,
    ) -> str:
        """Add Microsoft Planetary Computer imagery as a raster layer.

        With ``item`` the layer draws that one STAC item. Without it the layer
        is a mosaic: every item of the collection matching ``datetime`` and
        ``max_cloud_cover``, composited into one seamless layer. No credentials
        are needed, and nothing is fetched here: the app's Planetary Computer
        panel builds the layer when it opens the project, lists it in its
        Layers tab, and can restyle it. It needs the MapLibre renderer.

        Examples:
            A cloud-free summer composite and an NDVI of one scene::

                m.add_planetary_computer(
                    "sentinel-2-l2a",
                    datetime="2024-06-01/2024-08-31",
                    max_cloud_cover=10,
                )
                m.add_planetary_computer(
                    "sentinel-2-l2a",
                    "S2A_MSIL2A_20240906T190921_R056_T10TET_20240907T023150",
                    preset="ndvi",
                )

        Args:
            collection: STAC collection id, e.g. ``"sentinel-2-l2a"``.
            item: STAC item id to draw. Omit for a mosaic of the collection.
            name: Layer display name. Defaults to the item id, or to the
                collection id with the date range for a mosaic.
            datetime: Mosaic only. The date range to composite: a
                ``"start/end"`` string or a ``(start, end)`` pair.
            bbox: ``[west, south, east, north]`` extent of the layer.
            preset: Name of a render preset for the collection, e.g.
                ``"true-color"``, ``"false-color"``, ``"ndvi"``. The
                collection's default preset is used when no render option is
                given.
            assets: Asset names to render, e.g. ``["B08", "B04", "B03"]``.
            expression: Band-math expression over assets, e.g.
                ``"(B08-B04)/(B08+B04)"``.
            rescale: ``(min, max)`` value range stretched to the output colors.
            colormap: Named colormap, e.g. ``"viridis"``.
            max_cloud_cover: Mosaic only. Keep items at or below this cloud
                cover percentage.
            visible: Whether the layer starts visible.
            opacity: Layer opacity from 0 to 1.

        Returns:
            The id of the added layer.

        Raises:
            ValueError: If the options are inconsistent (see
                :func:`geolibre.project.planetary_computer_layer`) or
                ``opacity`` is outside 0 to 1.
        """
        opacity_value = float(opacity)
        if not 0 <= opacity_value <= 1:
            raise ValueError("opacity must be between 0 and 1")
        layer = _project.planetary_computer_layer(
            collection,
            item,
            name=name,
            datetime=datetime,
            bbox=bbox,
            preset=preset,
            assets=assets,
            expression=expression,
            rescale=rescale,
            colormap=colormap,
            max_cloud_cover=max_cloud_cover,
        )
        layer["visible"] = bool(visible)
        layer["opacity"] = opacity_value
        return self._add_layer(layer)

    def add_ee_layer(
        self,
        ee_object: Any,
        vis_params: dict[str, Any] | None = None,
        name: str = "Earth Engine",
        shown: bool = True,
        opacity: float = 1.0,
    ) -> str:
        """Add a Google Earth Engine object as a raster tile layer.

        This follows the ``geemap``/``leafmap`` convention: Earth Engine is
        evaluated in the Python kernel to obtain a map tile URL, while the
        GeoLibre app renders that URL as a normal raster layer. Earth Engine
        must already be authenticated and initialized (usually with
        ``ee.Authenticate()`` and ``ee.Initialize(project=...)``).

        Args:
            ee_object: An ``ee.Image``, ``ee.ImageCollection``,
                ``ee.FeatureCollection``, ``ee.Feature``, or ``ee.Geometry``.
                A compatible object exposing ``getMapId`` is also accepted.
            vis_params: Earth Engine visualization parameters, such as
                ``bands``, ``min``, ``max``, and ``palette``. For vector
                objects these are ``ee.FeatureCollection.style()`` keys
                instead (``color``, ``fillColor``, ``width``, ``pointSize``,
                ``pointShape``, ``lineType``, ``styleProperty``,
                ``neighborhood``).
            name: Layer display name.
            shown: Whether the layer is initially visible.
            opacity: Initial opacity between 0 and 1.

        Returns:
            The id of the added layer.

        Raises:
            ImportError: If conversion requires the optional Earth Engine
                Python package and it is not installed.
            TypeError: If ``ee_object`` is not a supported Earth Engine object,
                or ``vis_params`` is not a mapping.
            ValueError: If Earth Engine returns no usable tile URL, opacity is
                outside the range 0--1, or ``vis_params`` carries a key
                ``ee.FeatureCollection.style()`` does not accept.
            RuntimeError: If Earth Engine fails to prepare the object or to
                create map tiles (for example when it is not initialized, or
                the request is rejected).

        Note:
            The generated tile URL is tied to the Earth Engine map ID. A saved
            project may need the layer to be regenerated after that map ID
            expires.

            The layer is a plain raster tile layer, not one of the live layers
            the app's own Earth Engine panel manages, so it is listed and
            styled like any other tile layer rather than appearing in that
            panel.
        """
        try:
            opacity_value = float(opacity)
        except (TypeError, ValueError) as exc:
            raise ValueError("opacity must be a finite number between 0 and 1") from exc
        if not math.isfinite(opacity_value) or not 0 <= opacity_value <= 1:
            raise ValueError("opacity must be a finite number between 0 and 1")

        if vis_params is not None and not isinstance(vis_params, Mapping):
            raise TypeError("vis_params must be a mapping of Earth Engine visualization keys")
        params = dict(vis_params or {})
        map_object = ee_object
        map_params = params

        try:
            import ee
        except ImportError:
            ee = None

        # Earth Engine types are classified *before* the duck-typed
        # ``getMapId`` fallback: ``ee.ImageCollection``, ``ee.FeatureCollection``
        # and ``ee.Feature`` all expose ``getMapId`` themselves, so a
        # ``getMapId``-first check would silently skip the mosaic/style step and
        # drop every vector option except ``color``.
        ee_types = (
            (ee.Image, ee.ImageCollection, ee.FeatureCollection, ee.Feature, ee.Geometry)
            if ee is not None
            else ()
        )
        if ee is not None and isinstance(map_object, ee_types):
            is_vector = isinstance(map_object, (ee.FeatureCollection, ee.Feature, ee.Geometry))
            if is_vector:
                unsupported = sorted(set(params) - _EE_VECTOR_STYLE_KEYS)
                if unsupported:
                    raise ValueError(
                        "vis_params for an Earth Engine FeatureCollection, Feature, or "
                        f"Geometry may only contain {sorted(_EE_VECTOR_STYLE_KEYS)}; got "
                        f"{unsupported}"
                    )
            try:
                if isinstance(map_object, ee.ImageCollection):
                    map_object = map_object.mosaic()
                elif is_vector:
                    if isinstance(map_object, ee.Geometry):
                        map_object = ee.Feature(map_object)
                    if isinstance(map_object, ee.Feature):
                        map_object = ee.FeatureCollection([map_object])
                    vector_style = {
                        "color": "000000",
                        "fillColor": "00000000",
                        "width": 2,
                        "pointSize": 3,
                        "pointShape": "circle",
                        **params,
                    }
                    map_object = map_object.style(**vector_style)
                    map_params = {}
            except Exception as exc:
                raise RuntimeError(
                    f"Earth Engine could not prepare this object for display: {exc}"
                ) from exc
        elif not callable(getattr(map_object, "getMapId", None)):
            if ee is None:
                raise ImportError(
                    "Adding this Earth Engine object requires the `earthengine-api` "
                    "package. Install it with `pip install earthengine-api`."
                )
            raise TypeError(
                "ee_object must be an Earth Engine Image, ImageCollection, "
                "FeatureCollection, Feature, or Geometry"
            )

        try:
            map_id = map_object.getMapId(map_params)
        except Exception as exc:
            raise RuntimeError(
                f"Earth Engine could not create map tiles: {exc}. Authenticate and "
                "initialize Earth Engine before calling add_ee_layer(), and check "
                "that vis_params are valid for this object."
            ) from exc

        tile_fetcher = map_id.get("tile_fetcher") if isinstance(map_id, dict) else None
        tile_url = getattr(tile_fetcher, "url_format", None)
        if not tile_url and isinstance(map_id, dict):
            tile_url = map_id.get("tile_url") or map_id.get("url_format")
        if not isinstance(tile_url, str) or not tile_url:
            raise ValueError("Earth Engine returned a map ID without a tile URL")

        layer = _project.tile_layer(
            name,
            tile_url,
            attribution="Google Earth Engine",
        )
        layer["visible"] = bool(shown)
        layer["opacity"] = opacity_value
        layer["metadata"]["provider"] = "earth-engine"
        if isinstance(map_id, dict) and map_id.get("mapid"):
            layer["metadata"]["earthEngineMapId"] = map_id["mapid"]
        return self._add_layer(layer)

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
        url: str | os.PathLike[str],
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
                the raster when reopened later. It is read directly in local
                Jupyter and VS Code. Colab renders it as PNG XYZ tiles in the
                kernel instead, and JupyterHub can route it through the kernel
                port when ``jupyter-server-proxy`` is available; a deployment
                that can only serve the app extension cannot expose kernel
                files, so pass a hosted URL there.
            name: Layer display name.
            bands: Optional 1-based band indices to render.
            colormap: Optional colormap name (single-band rendering).
            rescale: Optional ``[[min, max], ...]`` ranges per band.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        if self._running_on_colab() and not (
            isinstance(url, str) and url.startswith(("http://", "https://"))
        ):
            # Resolve once so rasterio sees the same file the tile route
            # registered; GDAL does not expand "~" on its own.
            local_path = pathlib.Path(url).expanduser().resolve()
            tile_url = register_raster_tiles(
                local_path,
                bands=bands,
                colormap=colormap,
                rescale=rescale,
            )
            try:
                import rasterio
                from rasterio.warp import transform_bounds

                with rasterio.open(local_path) as dataset:
                    bounds = list(
                        transform_bounds(
                            dataset.crs,
                            "EPSG:4326",
                            *dataset.bounds,
                            densify_pts=21,
                        )
                    )
            except Exception:  # pragma: no cover - tile renderer reports invalid rasters
                bounds = None
            return self.add_tile_layer(tile_url, name, bounds=bounds, **style)
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
        source: Any = None,
        name: str = "Raster",
        *,
        url: str | os.PathLike[str] | None = None,
        bands: list[int] | None = None,
        colormap: str | None = None,
        rescale: list[list[float]] | None = None,
        array_args: dict[str, Any] | None = None,
        **style: Any,
    ) -> str:
        """Add a raster from a COG, GeoTIFF, or xarray object.

        URLs and paths are passed to :meth:`add_cog`. An
        ``xarray.DataArray`` or ``xarray.Dataset`` is first materialized as a
        temporary GeoTIFF using rioxarray. Longitude/latitude dimensions imply
        EPSG:4326; other dimension names require georeferencing through the
        object's ``.rio`` accessor or ``array_args``.

        The temporary GeoTIFF is removed by :meth:`close`, and, if that is never
        called, when the ``Map`` is garbage collected or the interpreter exits
        normally. A killed kernel leaves the file in the system temp directory.

        Args:
            source: URL or path of a COG / GeoTIFF, or an
                ``xarray.DataArray`` / ``xarray.Dataset``.
            name: Layer display name.
            url: Deprecated alias of ``source``, kept because this method used
                to name its first parameter ``url`` (as :meth:`add_cog` still
                does). Passing it emits a ``DeprecationWarning``.
            bands: Optional 1-based band indices to render.
            colormap: Optional colormap name (single-band rendering).
            rescale: Optional ``[[min, max], ...]`` ranges per band.
            array_args: Options used only for xarray inputs. ``variable``
                selects one Dataset variable, ``isel`` slices extra dimensions,
                and ``x_dim``, ``y_dim``, ``crs``, and ``nodata`` override the
                corresponding spatial metadata. Remaining options are passed to
                ``rio.to_raster``.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        if url is not None:
            if source is not None:
                raise TypeError("add_raster() got both 'source' and its deprecated alias 'url'")
            warnings.warn(
                "add_raster(url=...) is deprecated; pass the raster as the first "
                "positional argument or as source=...",
                DeprecationWarning,
                stacklevel=2,
            )
            source = url
        if source is None:
            raise TypeError("add_raster() missing required argument: 'source'")

        raster_source = source
        is_xarray = not isinstance(source, (str, os.PathLike))
        if is_xarray:
            raster_source = self._materialize_xarray(source, array_args)
        elif array_args:
            warnings.warn(
                "array_args is ignored unless source is an xarray object",
                UserWarning,
                stacklevel=2,
            )
        return self.add_cog(
            raster_source,
            name,
            bands=bands,
            colormap=colormap,
            rescale=rescale,
            **style,
        )

    def _materialize_xarray(
        self, source: Any, array_args: dict[str, Any] | None = None
    ) -> pathlib.Path:
        """Write an xarray DataArray or Dataset to a session-scoped COG."""
        try:
            import xarray as xr
        except ImportError as exc:  # pragma: no cover - object normally implies install
            raise ImportError(
                "xarray support requires the 'raster' extra: pip install geolibre[raster]"
            ) from exc

        if not isinstance(source, (xr.DataArray, xr.Dataset)):
            raise TypeError(
                "source must be a COG/GeoTIFF URL or path, or an xarray DataArray/Dataset"
            )
        try:
            import rioxarray  # noqa: F401 -- registers the .rio accessor
        except ImportError as exc:
            raise ImportError(
                "xarray raster support requires rioxarray and rasterio; "
                "install them with: pip install geolibre[raster]"
            ) from exc

        options = dict(array_args or {})
        variable = options.pop("variable", None)
        indexers = options.pop("isel", None)
        x_dim = options.pop("x_dim", None)
        y_dim = options.pop("y_dim", None)
        crs = options.pop("crs", None)
        nodata = options.pop("nodata", None)

        data = source
        if variable is not None:
            if not isinstance(data, xr.Dataset):
                raise ValueError("array_args['variable'] is only valid for an xarray Dataset")
            if variable not in data.data_vars:
                raise ValueError(f"Dataset has no data variable named {variable!r}")
            data = data[variable]
        elif isinstance(data, xr.Dataset) and not data.data_vars:
            raise ValueError("Cannot visualize an xarray Dataset with no data variables")
        if indexers is not None:
            if not isinstance(indexers, Mapping):
                raise TypeError(
                    "array_args['isel'] must be a mapping of dimension names to indices"
                )
            data = data.isel(dict(indexers))

        dims = set(data.dims)
        x_dim = x_dim or next((d for d in ("x", "lon", "longitude") if d in dims), None)
        y_dim = y_dim or next((d for d in ("y", "lat", "latitude") if d in dims), None)
        if x_dim is None or y_dim is None:
            raise ValueError(
                "Could not identify x/y dimensions. Set array_args={'x_dim': ..., 'y_dim': ...}."
            )
        data = data.rio.set_spatial_dims(x_dim=x_dim, y_dim=y_dim, inplace=False)
        if crs is not None:
            data = data.rio.write_crs(crs, inplace=False)
        elif data.rio.crs is None:
            if x_dim in {"lon", "longitude"} and y_dim in {"lat", "latitude"}:
                data = data.rio.write_crs("EPSG:4326", inplace=False)
            else:
                raise ValueError(
                    "The xarray object has no CRS. Set it with .rio.write_crs() or "
                    "array_args={'crs': 'EPSG:...'} ."
                )
        if nodata is not None:
            if isinstance(data, xr.Dataset):
                # RasterDataset has no write_nodata method; nodata metadata
                # belongs to each DataArray variable instead. Assign the
                # results explicitly because Dataset.map() discards the
                # per-variable _FillValue attributes written by rioxarray.
                data = data.copy()
                for variable_name in data.data_vars:
                    data[variable_name] = data[variable_name].rio.write_nodata(
                        nodata, inplace=False
                    )
                data = data.rio.set_spatial_dims(x_dim=x_dim, y_dim=y_dim, inplace=False)
            else:
                data = data.rio.write_nodata(nodata, inplace=False)

        handle, raw_path = tempfile.mkstemp(prefix="geolibre-xarray-", suffix=".tif")
        os.close(handle)
        path = pathlib.Path(raw_path)
        try:
            # The browser can range-read a COG directly. A plain GTiff makes
            # the app warn and convert the full file client-side before it can
            # display the layer.
            options.setdefault("driver", "COG")
            data.rio.to_raster(path, **options)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        self._temporary_rasters.append(path)
        return path

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
        crs: str | None = None,
        bounds: list[float] | None = None,
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
            crs: The CRS tiles are requested in, ``"EPSG:3857"`` when None.
                For a server without Web Mercator, a CRS it lists: a
                geographic one (``"EPSG:4326"``, ``"EPSG:4258"``,
                ``"EPSG:6706"``, ``"CRS:84"``) or a projected
                ``"EPSG:<code>"`` such as ``"EPSG:25832"``. The desktop app
                redraws those tiles into Web Mercator.
            bounds: Optional ``[west, south, east, north]`` request bounds, in
                WGS84. A WMS layer has no geometry to derive an extent from,
                so without these "zoom to layer" cannot reach it.
            **style: Style overrides.

        Returns:
            The id of the added layer.

        Raises:
            ValueError: If ``bounds`` is not four finite numbers with valid
                latitudes, or ``crs`` is not a supported CRS.
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
                crs=crs,
                bounds=bounds,
                **style,
            )
        )

    def add_wmts(
        self,
        url: str,
        name: str = "WMTS Layer",
        *,
        tile_size: int = 256,
        bounds: list[float] | None = None,
        **style: Any,
    ) -> str:
        """Add a WMTS layer from a tile URL template.

        Args:
            url: A WMTS tile URL template (``{z}/{y}/{x}``).
            name: Layer display name.
            tile_size: Tile size in pixels.
            bounds: Optional ``[west, south, east, north]`` request bounds, in
                WGS84.
            **style: Style overrides.

        Returns:
            The id of the added layer.

        Raises:
            ValueError: If ``bounds`` is not four finite numbers with valid latitudes.
        """
        return self._add_layer(
            _project.wmts_layer(name, url, tile_size=tile_size, bounds=bounds, **style)
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
        # The builder writes the protocol fields the UI persists, so the Edit
        # Layer panel can pre-populate the WFS form and isWfsLayer() recognizes
        # the layer when round-tripped from a Python-produced project.
        layer = _project.wfs_layer(
            name,
            endpoint,
            type_name,
            version=version,
            output_format=output_format,
            srs_name=srs_name,
            max_features=max_features,
            **style,
        )
        layer["geojson"] = _project.load_featurecollection(layer["sourcePath"])
        layer["metadata"]["featureCount"] = len(layer["geojson"]["features"])
        return self._add_layer(layer)

    def add_arcgis_layer(
        self,
        url: str,
        name: str = "ArcGIS Layer",
        *,
        service: str = "map",
        tiled: bool = False,
        sublayers: str | list[int] | None = None,
        rendering_rule: str | dict[str, Any] | None = None,
        max_features: int | None = None,
        bounds: list[float] | None = None,
        attribution: str | None = None,
        **style: Any,
    ) -> str:
        """Add an ArcGIS REST MapServer, ImageServer, or FeatureServer layer.

        Map and image services draw raster tiles from the export endpoint, or
        their validated image cache with ``tiled=True``. A feature layer loads
        the features in view from the query endpoint when the project opens.

        Args:
            url: The service URL (``.../MapServer``, ``.../ImageServer``, or a
                layer URL such as ``.../FeatureServer/0``).
            name: Layer display name.
            service: ``"map"``, ``"image"``, or ``"feature"``.
            tiled: Use the service's validated public Web Mercator image cache
                instead of its export endpoint. Cannot be combined with
                sublayers or a rendering rule; raw LERC caches are refused.
                Metadata reads are limited to 2 MiB with a 30-second socket
                inactivity timeout and an elapsed-time check between reads.
            sublayers: MapServer sublayer ids to show.
            rendering_rule: ImageServer rendering rule (dict or JSON string).
            max_features: Feature service cap on features loaded per view.
            bounds: ``[west, south, east, north]`` extent for "Zoom to layer".
            attribution: Attribution text.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.arcgis_layer(
                name,
                url,
                service=service,
                tiled=tiled,
                sublayers=sublayers,
                rendering_rule=rendering_rule,
                max_features=max_features,
                bounds=bounds,
                attribution=attribution,
                **style,
            )
        )

    def add_zarr(
        self,
        url: str,
        variable: str,
        name: str | None = None,
        *,
        icechunk_branch: str | None = None,
        selector: dict[str, int | float | str] | None = None,
        clim: list[float] | None = None,
        colormap: str | None = None,
        bounds: list[float] | None = None,
        crs: str | None = None,
        spatial_dimensions: dict[str, str] | None = None,
        **style: Any,
    ) -> str:
        """Add a Zarr data-cube layer, drawn by the app's Zarr control.

        Args:
            url: An ``http(s)://``, ``s3://``, or ``gs://`` Zarr store URL.
            variable: The array to draw.
            name: Layer display name; defaults to the variable name.
            icechunk_branch: Branch of a public HTTP(S) Icechunk repository.
            selector: Non-spatial dimension values to slice, e.g. ``{"time": 0}``.
            clim: ``[min, max]`` color range.
            colormap: Colormap name.
            bounds: ``[west, south, east, north]`` when the store lacks coordinates.
            crs: The store's CRS when it is not EPSG:4326.
            spatial_dimensions: ``{"lat": ..., "lon": ...}`` dimension names.
            **style: Style overrides.

        Returns:
            The id of the added layer. The app assigns the live layer a new id
            when it opens the project.
        """
        return self._add_layer(
            _project.zarr_layer(
                name or variable,
                url,
                variable,
                icechunk_branch=icechunk_branch,
                selector=selector,
                clim=clim,
                colormap=colormap,
                bounds=bounds,
                crs=crs,
                spatial_dimensions=spatial_dimensions,
                **style,
            )
        )
