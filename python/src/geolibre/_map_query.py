"""Map methods for querying features and running processing tools."""

from __future__ import annotations

import base64
import pathlib
from typing import Any

from ._layer import Feature as Feature
from ._layer import Layer as Layer


class _MapQueryMixin:
    """Map methods for querying features and running processing tools."""

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
        return self._wrap_features(features)

    @staticmethod
    def _wrap_features(features: Any) -> list[Feature]:
        """Wrap raw GeoJSON feature dicts as :class:`Feature` objects."""
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
        feats = self._wrap_features(features)
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
        feats = self._wrap_features(features)
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

    def run_model_builder(
        self,
        graph: dict[str, Any],
        *,
        timeout: float = 600.0,
    ) -> dict[str, Any]:
        """Run a serialized GeoLibre Model Builder graph in the displayed app.

        Sending the complete graph in one request also makes copied Model
        Builder scripts portable to JupyterLite, whose browser kernel cannot
        synchronously retrieve each intermediate layer id.
        """
        return self.request("runModelBuilder", {"graph": graph}, timeout=timeout)

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
        resolved = self._resolve_tool_params(parameters)
        return self.request(
            "runWhiteboxTool",
            {"id": str(tool_id), "params": resolved},
            timeout=timeout,
        )

    def _resolve_tool_params(self, parameters: dict[str, Any] | None) -> dict[str, Any]:
        """Replace :class:`Layer` handles in tool parameters with their layer ids."""
        return {
            key: self._resolve_layer(value).id if isinstance(value, Layer) else value
            for key, value in (parameters or {}).items()
        }

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
        return self._png_from_data_url(data_url, path)

    @staticmethod
    def _png_from_data_url(data_url: Any, path: str | None) -> bytes | None:
        """Decode a ``toImage`` data URL to PNG bytes, optionally writing ``path``."""
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
