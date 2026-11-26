"""Layer and feature handles returned by :class:`~geolibre.geolibre.Map`."""

from __future__ import annotations

import copy
import math
from typing import TYPE_CHECKING, Any

from . import project as _project

if TYPE_CHECKING:
    from .geolibre import Map


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

    @property
    def popup(self) -> dict[str, Any]:
        """This layer's popup/tooltip config, or ``{}`` when it has none."""
        config = self._layer().get("popup")
        return copy.deepcopy(config) if isinstance(config, dict) else {}

    @property
    def descriptive_metadata(self) -> dict[str, Any]:
        """This layer's descriptive (catalog) metadata, or ``{}`` when it has none."""
        block = self._layer().get("descriptiveMetadata")
        return copy.deepcopy(block) if isinstance(block, dict) else {}

    def set_metadata(self, *, merge: bool = False, **fields: Any) -> dict[str, Any] | None:
        """Set this layer's descriptive metadata (see :meth:`Map.set_layer_metadata`)."""
        return self._map.set_layer_metadata(self, merge=merge, **fields)

    def set_popup(self, fields: Any = None, **kwargs: Any) -> dict[str, Any]:
        """Configure this layer's popup (see :meth:`Map.set_popup`)."""
        return self._map.set_popup(self, fields, **kwargs)

    def set_tooltip(self, fields: Any = True) -> dict[str, Any]:
        """Show a hover tooltip on this layer (see :meth:`Map.set_tooltip`)."""
        return self._map.set_tooltip(self, fields)

    def clear_popup(self) -> None:
        """Drop this layer's popup config, restoring the default popup."""
        self._map.clear_popup(self)

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
