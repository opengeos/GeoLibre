"""Map methods that add 3D, point cloud, Cesium and video layers."""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import Any

from . import authoring as _authoring
from . import project as _project


class _MapSceneMixin:
    """Map methods that add 3D, point cloud, Cesium and video layers."""

    def add_3d_tiles(
        self,
        url: str | None = None,
        name: str = "3D Tiles",
        *,
        ion_asset_id: int | None = None,
        altitude_offset: float = 0,
        request_headers: dict[str, str] | None = None,
        **style: Any,
    ) -> str:
        """Add a 3D Tiles layer, an ArcGIS I3S scene layer, or a Cesium Ion asset.

        Args:
            url: URL of the 3D Tiles ``tileset.json``, or of an ArcGIS I3S
                scene layer (``.../SceneServer/layers/<n>``), which is added as
                a scene layer. Omit for an Ion asset.
            name: Layer display name.
            ion_asset_id: A Cesium Ion asset id (for example 96188, Cesium OSM
                Buildings). Renders on the 3D globe only, with the app's Ion token.
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
                ion_asset_id=ion_asset_id,
                altitude_offset=altitude_offset,
                request_headers=request_headers,
                **style,
            )
        )

    def add_lidar(self, url: str, name: str | None = None, **style: Any) -> str:
        """Add a LiDAR point cloud from a LAS, LAZ, COPC or EPT URL.

        COPC and EPT stream by level of detail; LAS/LAZ download whole. Open the
        app's **Plugins → Point Cloud Annotation** to label its points.

        Args:
            url: HTTP(S) URL of a ``.las``, ``.laz``, ``.copc.laz`` file or an
                EPT ``ept.json``.
            name: Layer display name (defaults to the file name).
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        if name is None and isinstance(url, str):
            tail = url.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
            name = tail or "LiDAR"
        return self._add_layer(_project.lidar_layer(name, url, **style))

    def add_icesat2(
        self,
        source: str | os.PathLike[str],
        name: str | None = None,
        *,
        beams: Sequence[str] | None = None,
        fields: Sequence[Any] | None = None,
        quality_filter: bool = True,
        bbox: Sequence[float] | None = None,
        max_points: int | None = 100_000,
        color_by: str | None = None,
        colormap: str = "viridis",
        **style: Any,
    ) -> str:
        """Add ICESat-2 ATL06 or ATL08 footprints from an HDF5 granule.

        Reads the granule locally (with h5py) the way the app's Add Data →
        ICESat-2 / GEDI does: one point per along-track segment in each ground
        track, the product's quality filter applied, and ``beam``,
        ``beam_type`` (strong/weak), ``time`` and ``distance_km`` on every
        point, colored by the main field (``h_li`` for ATL06,
        ``h_te_best_fit`` for ATL08). Download granules with ``earthaccess``
        (``earthaccess.download(...)``) or from NASA Earthdata Search.

        Args:
            source: Path to an ATL06 or ATL08 ``.h5`` granule.
            name: Layer name; ``"<product> <file name>"`` by default.
            beams: Ground tracks to read, e.g. ``["gt1l", "gt2l"]`` (all by default).
            fields: Fields to attach: default names (``"h_canopy"``) or dataset
                paths relative to the ground track (the product defaults when
                omitted).
            quality_filter: Drop segments the product's quality flag rejects.
            bbox: ``[west, south, east, north]`` to keep only segments inside.
            max_points: Cap on points; every beam is thinned evenly to stay
                under it. ``None`` keeps every segment.
            color_by: Field to color by; ``""`` for a single color.
            colormap: Color ramp for the graduated colors.
            **style: Style overrides (e.g. ``circleRadius=4``).

        Returns:
            The id of the added layer.

        Raises:
            ImportError: Without h5py (``pip install "geolibre[spaceborne]"``).
            ValueError: For a GEDI or unsupported granule, or no footprints kept.
        """
        return self._add_spaceborne_lidar(
            ("ICESat-2",),
            source,
            name,
            beams=beams,
            fields=fields,
            quality_filter=quality_filter,
            bbox=bbox,
            max_points=max_points,
            color_by=color_by,
            colormap=colormap,
            **style,
        )

    def add_gedi(
        self,
        source: str | os.PathLike[str],
        name: str | None = None,
        *,
        beams: Sequence[str] | None = None,
        fields: Sequence[Any] | None = None,
        quality_filter: bool = True,
        bbox: Sequence[float] | None = None,
        max_points: int | None = 100_000,
        color_by: str | None = None,
        colormap: str = "viridis",
        **style: Any,
    ) -> str:
        """Add GEDI L2A, L2B or L4A shots from an HDF5 granule.

        Reads the granule locally (with h5py) the way the app's Add Data →
        ICESat-2 / GEDI does: one point per shot in each beam, the product's
        quality flag applied, and ``beam``, ``beam_type`` (power/coverage),
        ``time`` and ``distance_km`` on every point, colored by the main field
        (``rh98`` for L2A, ``cover`` for L2B, ``agbd`` for L4A). A full orbit
        holds millions of shots, so pass ``bbox`` for a regional subset.

        Args:
            source: Path to a GEDI L2A, L2B or L4A ``.h5`` granule.
            name: Layer name; ``"<product> <file name>"`` by default.
            beams: Beams to read, e.g. ``["BEAM0101"]`` (all by default).
            fields: Fields to attach: default names (``"rh50"``) or dataset
                paths relative to the beam (the product defaults when omitted).
            quality_filter: Drop shots the product's quality flag rejects.
            bbox: ``[west, south, east, north]`` to keep only shots inside.
            max_points: Cap on points; every beam is thinned evenly to stay
                under it. ``None`` keeps every shot.
            color_by: Field to color by; ``""`` for a single color.
            colormap: Color ramp for the graduated colors.
            **style: Style overrides (e.g. ``circleRadius=4``).

        Returns:
            The id of the added layer.

        Raises:
            ImportError: Without h5py (``pip install "geolibre[spaceborne]"``).
            ValueError: For an ICESat-2 or unsupported granule, or no shots kept.
        """
        return self._add_spaceborne_lidar(
            ("GEDI",),
            source,
            name,
            beams=beams,
            fields=fields,
            quality_filter=quality_filter,
            bbox=bbox,
            max_points=max_points,
            color_by=color_by,
            colormap=colormap,
            **style,
        )

    def _add_spaceborne_lidar(
        self,
        missions: tuple[str, ...],
        source: str | os.PathLike[str],
        name: str | None,
        **options: Any,
    ) -> str:
        """Build and add a footprint layer for :meth:`add_icesat2` / :meth:`add_gedi`.

        Args:
            missions: The missions the calling method accepts.
            source: Path to the granule.
            name: Layer name, or None for the default.
            **options: Reader and style options.

        Returns:
            The id of the added layer.
        """
        from .spaceborne_lidar import spaceborne_lidar_layer

        layer, _result = spaceborne_lidar_layer(source, name, missions=missions, **options)
        return self._add_layer(layer)

    def point_cloud_annotations(self) -> dict[str, Any]:
        """The point labels and 3D boxes saved by the app's point cloud annotator.

        Returns:
            ``{"labels", "instances", "boxes", "classes"}``; see
            :func:`geolibre.project.point_cloud_annotations`. Apply the
            labels of a whole-file LAS/LAZ source to ``laspy`` data with
            :func:`geolibre.project.apply_point_labels`.
        """
        return _project.point_cloud_annotations(self.project)

    def prelabel_point_cloud(
        self,
        url: str,
        input_file: str,
        tool: str = "ground",
        *,
        only_unclassified: bool = True,
    ) -> dict[str, int]:
        """Pre-label a LiDAR layer with a Whitebox classifier, without the app.

        Runs the app's Pre-label classifiers on a local copy of the layer's file
        and saves the changed classes as annotator labels for the layer, so
        they show when the project opens. Needs ``geolibre[pointcloud]``.

        Args:
            url: The LiDAR layer's source URL (as passed to :meth:`add_lidar`).
            input_file: A local copy of that point cloud (LAS/LAZ/COPC).
            tool: ``"ground"`` or ``"ground-vegetation"``.
            only_unclassified: Only relabel points still 0 or 1.

        Returns:
            Class code -> number of points relabelled into it.

        Raises:
            ValueError: When no LiDAR layer uses ``url``, or for an unknown tool.
        """
        from . import pointcloud as _pointcloud

        if url not in _authoring.lidar_source_urls(self.project):
            raise ValueError("No LiDAR layer in this map uses that URL; add it with add_lidar().")
        current, _ = _pointcloud.labels_for_source(self.project, url)
        labels = _pointcloud.prelabel_point_cloud(
            input_file, tool, current=current, only_unclassified=only_unclassified
        )
        self._update_project(lambda project: _authoring.merge_point_labels(project, url, labels))
        counts: dict[int, int] = {}
        for edits in labels.values():
            for code in edits.values():
                counts[code] = counts.get(code, 0) + 1
        return counts

    def write_labeled_point_cloud(
        self, url: str, input_file: str, output_file: str
    ) -> dict[str, int]:
        """Write a LiDAR layer's file with this map's point labels applied.

        Streams ``input_file`` (a local copy of the layer's LAS/LAZ/COPC file)
        and writes every point with the annotator's saved classes and instance
        ids applied. Needs ``geolibre[pointcloud]``.

        Args:
            url: The LiDAR layer's source URL whose labels to apply.
            input_file: A local copy of that point cloud.
            output_file: The ``.las`` or ``.laz`` file to write.

        Returns:
            ``{"points", "relabelled", "instanced"}`` counts.
        """
        from . import pointcloud as _pointcloud

        if url not in _authoring.lidar_source_urls(self.project):
            raise ValueError("No LiDAR layer in this map uses that URL; add it with add_lidar().")
        labels, instances = _pointcloud.labels_for_source(self.project, url)
        return _pointcloud.write_labeled_point_cloud(input_file, output_file, labels, instances)

    def set_point_cloud_classes(self, classes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Define custom point cloud classes for the app's annotator.

        Custom classes (codes 19-255) extend the ASPRS standard classes: the
        annotator can assign them, and the LiDAR layer draws them in their
        colour and names them in its legend.

        Args:
            classes: ``{"code", "name", "color"}`` dicts, e.g.
                ``[{"code": 64, "name": "Car", "color": "#e11d48"}]``;
                ``color`` may also be an ``(r, g, b)`` triple. An empty list
                clears them.

        Returns:
            The validated classes as saved.

        Raises:
            ValueError: For an invalid class.
        """
        # Validate first so a bad class raises before the project changes.
        schema = _project.point_cloud_class_schema(classes)
        self._update_project(lambda project: _authoring.set_point_cloud_classes(project, schema))
        return schema

    def add_cesium_ion(
        self,
        asset_id: int,
        name: str = "Cesium Ion asset",
        *,
        kind: str = "3d-tiles",
        altitude_offset: float = 0,
        **style: Any,
    ) -> str:
        """Add a Cesium Ion asset (a 3D Tiles tileset or imagery) by asset id.

        The layer renders on the 3D globe only, which loads it with the app's
        Cesium Ion token; the token is never written to the project.

        Args:
            asset_id: The Cesium Ion asset id (a positive integer).
            name: Layer display name.
            kind: ``"3d-tiles"`` for a tileset or ``"imagery"`` for an imagery asset.
            altitude_offset: Vertical offset applied to a tileset, in meters.
            **style: Style overrides.

        Returns:
            The id of the added layer.
        """
        return self._add_layer(
            _project.cesium_ion_layer(
                name, asset_id, kind=kind, altitude_offset=altitude_offset, **style
            )
        )

    def add_czml(
        self,
        url: str | None = None,
        name: str = "CZML scene",
        *,
        data: list[dict[str, Any]] | dict[str, Any] | None = None,
        source_path: str | None = None,
        **style: Any,
    ) -> str:
        """Add a CZML (Cesium Language) dynamic 3D scene.

        CZML describes time-varying scenes (satellite orbits, vehicle tracks,
        moving models with paths). The 3D globe loads it natively and follows
        the document's clock; the 2D map badges the layer "3D only".

        Args:
            url: URL of a ``.czml`` document.
            name: Layer display name.
            data: Inline CZML packets (a list, or one packet dict) instead of
                a URL.
            source_path: Local path the document was loaded from, if any.
            **style: Style overrides.

        Returns:
            The id of the added layer.

        Raises:
            ValueError: If neither ``url`` nor ``data`` is given.
        """
        return self._add_layer(
            _project.czml_layer(name, url=url, data=data, source_path=source_path, **style)
        )

    def add_cesium_kml(
        self,
        url: str | None = None,
        name: str = "KML / KMZ",
        *,
        data: str | None = None,
        source_path: str | None = None,
        **style: Any,
    ) -> str:
        """Add native KML/KMZ on the globe, preserving document styling.

        Supply a URL, inline XML, or a KMZ data URL. Use ``add_kml`` for the
        vector conversion that works on both rendering engines.
        """
        return self._add_layer(
            _project.cesium_kml_layer(name, url=url, data=data, source_path=source_path, **style)
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
