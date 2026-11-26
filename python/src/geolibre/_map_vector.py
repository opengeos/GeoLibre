"""Map methods that add vector data layers."""

from __future__ import annotations

import csv
import io
import math
import os
import pathlib
import warnings
from collections.abc import Sequence
from typing import Any
from urllib.error import URLError

from . import authoring as _authoring
from . import project as _project
from ._map_support import _CSV_RESTKEY as _CSV_RESTKEY
from ._map_support import _MAX_TABULAR_BYTES as _MAX_TABULAR_BYTES
from ._map_support import _read_local_vector as _read_local_vector
from .polyline import polyline_to_geojson


class _MapVectorMixin:
    """Map methods that add vector data layers."""

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

    def add_sql_query_layer(
        self, data: Any, sql: str, name: str = "SQL query", **style: Any
    ) -> str:
        """Add a saved DuckDB query result that can refresh in the app.

        Python stores the supplied result without executing SQL. The embedded
        GeoJSON renders on load, including offline. Refresh re-runs the stored
        query against the other layers in the project using SQL Workspace table
        names; those source layers must be available at refresh time.

        Args:
            data: Result GeoJSON, with the same input forms as add_geojson.
            sql: Non-empty DuckDB SQL statement that produced the result.
            name: Layer display name.
            **style: Style overrides, such as fillColor or circleRadius.

        Returns:
            The id of the added query layer.

        Raises:
            ValueError: If SQL or the result GeoJSON is invalid.
        """
        return self._add_layer(_project.sql_query_layer(name, data, sql, **style))

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

    def add_polyline(
        self,
        polyline: str | Sequence[str],
        name: str = "Polyline",
        *,
        precision: int = 5,
        unescape: bool = False,
        **style: Any,
    ) -> str:
        """Add an Encoded Polyline layer.

        Args:
            polyline: A single polyline string (e.g. Google or Valhalla encoded)
                or a list of polyline strings.
            name: Layer display name.
            precision: Decimal digits of precision (5 for Google/OSRM, 6 for Valhalla/Mapbox).
            unescape: Whether to unescape double-escaped backslashes before decoding.
            **style: Style overrides (e.g. ``lineColor="#ff0000"``, ``lineWidth=3``).

        Returns:
            The id of the added layer.
        """
        fc = polyline_to_geojson(polyline, precision=precision, unescape=unescape)
        return self.add_geojson(fc, name=name, **style)

    def add_marker(
        self,
        lng: float,
        lat: float,
        name: str = "Marker",
        *,
        properties: dict[str, Any] | None = None,
        color: str | None = None,
        opacity: float | None = None,
        radius: float | None = None,
        stroke_color: str | None = None,
        stroke_width: float | None = None,
        shape: str | None = None,
        size: float | None = None,
        icon: str | None = None,
        **style: Any,
    ) -> str:
        """Add a single point marker at ``[lng, lat]``.

        The marker is a GeoJSON point layer; its ``properties`` are shown in a
        popup when the point is clicked while Identify is armed (see
        :meth:`set_identify`). See :meth:`add_markers` for the symbology and
        popup arguments, which behave identically here.

        Args:
            lng: Marker longitude.
            lat: Marker latitude.
            name: Layer display name.
            properties: Optional feature properties (shown in the Identify popup).
            color: Marker color.
            opacity: Fill opacity in ``[0, 1]``.
            radius: Circle radius in pixels.
            stroke_color: Outline color.
            stroke_width: Outline width in pixels.
            shape: Marker shape; switches to sprite rendering.
            size: Sprite size in pixels; switches to sprite rendering.
            icon: SVG markup or data URL for a custom sprite.
            **style: Further style overrides, plus ``popup=``/``tooltip=`` and
                the ``popup_max_width=``/``popup_image_height=`` size
                shorthands (see :meth:`add_markers`).

        Returns:
            The id of the added layer.
        """
        # setdefault, not update: a raw style key passed alongside the named
        # argument is the low-level escape hatch and keeps winning, which is
        # also the precedence add_circle_markers had before these arguments
        # existed.
        for key, value in _project.marker_style(
            color=color,
            opacity=opacity,
            radius=radius,
            stroke_color=stroke_color,
            stroke_width=stroke_width,
            shape=shape,
            size=size,
            icon=icon,
        ).items():
            style.setdefault(key, value)
        fc = {
            "type": "FeatureCollection",
            "features": [self._point_feature(lng, lat, properties)],
        }
        return self._add_layer(_project.geojson_layer(name, fc, **style))

    def add_markers(
        self,
        points: Any,
        name: str = "Markers",
        *,
        color: str | None = None,
        opacity: float | None = None,
        radius: float | None = None,
        stroke_color: str | None = None,
        stroke_width: float | None = None,
        shape: str | None = None,
        size: float | None = None,
        icon: str | None = None,
        **style: Any,
    ) -> str:
        """Add point markers from a collection of points.

        Markers draw as MapLibre circles by default, sized by ``radius``.
        Passing ``shape``, ``size`` or ``icon`` switches the layer to a marker
        sprite instead, sized by ``size``; ``radius`` no longer applies to it,
        and ``color`` must then be a hex color because that is all the sprite
        baker accepts.

        Args:
            points: A sequence of ``(lng, lat)`` pairs or
                ``{"lng"/"lon"/"x", "lat"/"y", **properties}`` mappings, a GeoJSON
                point FeatureCollection/Feature/geometry, a GeoJSON string, or a
                ``__geo_interface__`` object (e.g. a point GeoDataFrame).
            name: Layer display name.
            color: Marker color, e.g. ``"#e11d48"``.
            opacity: Fill opacity in ``[0, 1]``.
            radius: Circle radius in pixels (circle rendering only).
            stroke_color: Outline color.
            stroke_width: Outline width in pixels.
            shape: One of ``"circle"``, ``"square"``, ``"triangle"``,
                ``"diamond"``, ``"star"``, ``"cross"``, ``"pin"``, or
                ``"custom"`` (which needs ``icon``).
            size: Sprite size in pixels.
            icon: Raw SVG markup or a data URL drawn as a custom sprite.
            **style: Further style overrides, plus ``popup=`` and ``tooltip=``
                to configure what a click and a hover show. ``popup`` takes a
                property name, a list of names or field mappings, or a config
                mapping; see :meth:`set_popup`. ``popup_max_width=`` and
                ``popup_image_height=`` size the popup and its pictures, in CSS
                pixels, without spelling out the rest of a config mapping.

        Returns:
            The id of the added layer.

        Example:
            >>> m.add_markers(
            ...     [{"lon": -122.9, "lat": 47.0, "name": "Olympia", "photo": url}],
            ...     shape="pin",
            ...     color="#e11d48",
            ...     size=32,
            ...     popup=["name", {"field": "photo", "kind": "image"}],
            ...     tooltip="name",
            ...     popup_max_width=480,
            ...     popup_image_height=320,
            ... )
        """
        # setdefault, not update: a raw style key passed alongside the named
        # argument is the low-level escape hatch and keeps winning, which is
        # also the precedence add_circle_markers had before these arguments
        # existed.
        for key, value in _project.marker_style(
            color=color,
            opacity=opacity,
            radius=radius,
            stroke_color=stroke_color,
            stroke_width=stroke_width,
            shape=shape,
            size=size,
            icon=icon,
        ).items():
            style.setdefault(key, value)
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
        return self.add_markers(points, name=name, radius=radius, **style)

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
        color_ramp: str = "turbo",
        weight_field: str = "",
        **style: Any,
    ) -> str:
        """Add point data using GeoLibre's density heatmap renderer.

        Args:
            points: Points in any form accepted by :meth:`add_markers`.
            name: Layer display name.
            radius: Heatmap radius in pixels.
            intensity: Heatmap intensity multiplier.
            color_ramp: Name of the built-in heatmap color ramp.
            weight_field: Numeric property used to weight each point, or an
                empty string to give every point equal weight.
            **style: Additional style overrides.

        Returns:
            The id of the added layer.
        """
        # NaN and infinity slip past the comparisons below, so check finiteness
        # first rather than storing an unusable renderer setting.
        if not math.isfinite(float(radius)) or float(radius) <= 0:
            raise ValueError("radius must be a finite number greater than zero")
        if not math.isfinite(float(intensity)) or float(intensity) < 0:
            raise ValueError("intensity must be a finite non-negative number")
        style.setdefault("pointRenderer", "heatmap")
        style.setdefault("heatmapRadius", float(radius))
        style.setdefault("heatmapIntensity", float(intensity))
        style.setdefault("heatmapColorRamp", str(color_ramp))
        style.setdefault("heatmapWeightProperty", str(weight_field))
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
                # Same defences as the remote GeoJSON fetch in project/fetch.py: reject
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
                elif (
                    "\n" not in source
                    and "\r" not in source
                    and "," not in source
                    and (
                        "/" in source
                        or "\\" in source
                        or source.startswith(("~", "."))
                        or path.suffix.lower() in {".csv", ".tsv", ".txt"}
                    )
                ):
                    raise FileNotFoundError(f"CSV file not found: {source}")
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
            # RFC 7946 allows "properties": null, which the .get default misses.
            (feature.get("properties") or {}).get(column)
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
