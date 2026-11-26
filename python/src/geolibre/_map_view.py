"""Map methods for reading and moving the camera."""

from __future__ import annotations

import math
from typing import Any

from . import authoring as _authoring
from ._layer import Layer as Layer


class _MapViewMixin:
    """Map methods for reading and moving the camera."""

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
        self.request(
            "flyTo",
            self._fly_to_params(lng, lat, zoom, bearing, pitch, duration),
            timeout=timeout,
        )

    @staticmethod
    def _fly_to_params(
        lng: float | None,
        lat: float | None,
        zoom: float | None,
        bearing: float | None,
        pitch: float | None,
        duration: float | None,
    ) -> dict[str, Any]:
        """Build the ``flyTo`` command params; only provided fields change."""
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
        return params

    def fit_bounds(
        self,
        bounds: list[float] | tuple[float, float, float, float],
        *,
        timeout: float = 10.0,
    ) -> None:
        """Fit the camera to ``[west, south, east, north]``."""
        values = self._validate_bounds(bounds)
        self.request("fitBounds", {"bounds": values}, timeout=timeout)

    @staticmethod
    def _validate_bounds(
        bounds: list[float] | tuple[float, float, float, float],
    ) -> list[float]:
        """Validate ``[west, south, east, north]`` bounds and return them as floats."""
        values = [float(b) for b in bounds]
        if len(values) != 4:
            raise ValueError("bounds must contain [west, south, east, north]")
        if not all(math.isfinite(value) for value in values):
            raise ValueError("bounds must contain finite numbers")
        west, south, east, north = values
        if west > east or south > north:
            raise ValueError("bounds must satisfy west <= east and south <= north")
        return values

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
