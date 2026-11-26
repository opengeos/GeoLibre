"""Map methods for managing existing layers: lookup, visibility, popups, labels and order."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

from . import authoring as _authoring
from ._layer import Layer as Layer


class _MapLayersMixin:
    """Map methods for managing existing layers: lookup, visibility, popups, labels and order."""

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

    def set_popup(
        self,
        layer: str | Layer,
        fields: Any = None,
        *,
        click: bool | None = None,
        hover: bool | None = None,
        title: str | None = None,
        title_expression: str | None = None,
        body_expression: str | None = None,
        show_feature_id: bool | None = None,
        max_width: int | None = None,
        image_height: int | None = None,
        tooltip: Any = None,
        merge: bool = False,
    ) -> dict[str, Any]:
        """Configure a layer's click popup (and, with ``tooltip``, its hover tip).

        Without a config a layer shows its name and every visible property; a
        config narrows, orders, relabels and formats those rows.

        Args:
            layer: The layer, by id, name, or handle.
            fields: Property names and/or field mappings, in display order. A
                mapping takes ``field`` plus any of ``label``, ``kind``
                (``"auto"``, ``"text"``, ``"number"``, ``"date"``, ``"link"``,
                ``"image"``), ``hover``, ``decimals``, ``thousands``,
                ``date_format``, ``prefix``, ``suffix``, and ``link_label``.
            click: ``False`` suppresses the click popup.
            hover: ``True`` shows a hover tooltip built from the ``hover`` fields.
            title: Property whose value titles the popup.
            title_expression: MapLibre expression source producing the title.
            body_expression: MapLibre expression source producing the body text.
            show_feature_id: ``False`` drops the synthetic ``id`` row.
            max_width: Widest the click popup may draw, in CSS pixels (288 to
                1200). The viewport still caps it.
            image_height: Tallest an ``"image"`` field's thumbnail may draw
                inside the popup, in CSS pixels (40 to 1200). A thumbnail keeps
                its aspect ratio, so raise ``max_width`` too for a landscape
                photo to use the extra height.
            tooltip: Hover shorthand -- a property name, a sequence of names,
                ``True`` to flag every configured field, or ``False`` to turn
                the tooltip off. The tooltip and the click popup share one
                field list, so naming a tooltip field on a popup that had none
                also narrows the click popup to it; pass ``fields`` too to keep
                the click popup full.
            merge: Merge into the layer's existing popup config rather than
                replacing it.

        Returns:
            The layer's popup config after the change.

        Example:
            >>> m.set_popup(
            ...     "Sites",
            ...     [
            ...         {"field": "name", "label": "Site"},
            ...         {"field": "photo", "kind": "image", "label": "Photo"},
            ...         {"field": "url", "kind": "link", "link_label": "Details"},
            ...         {"field": "pop", "kind": "number", "thousands": True},
            ...     ],
            ...     title="name",
            ...     tooltip="name",
            ...     max_width=480,
            ...     image_height=320,
            ... )
        """
        handle = self._resolve_layer(layer)
        # Delegate rather than re-deriving the merge: authoring.set_popup is the
        # one implementation the MCP server uses too, so the two cannot drift.
        self._update_project(
            lambda project: _authoring.set_popup(
                project,
                handle.id,
                fields,
                click=click,
                hover=hover,
                title=title,
                title_expression=title_expression,
                body_expression=body_expression,
                show_feature_id=show_feature_id,
                max_width=max_width,
                image_height=image_height,
                tooltip=tooltip,
                merge=merge,
            )
        )
        return handle.popup

    def set_tooltip(self, layer: str | Layer, fields: Any = True) -> dict[str, Any]:
        """Show a hover tooltip on a layer, built from ``fields``.

        Args:
            layer: The layer, by id, name, or handle.
            fields: A property name, a sequence of names, ``True`` to use every
                field the layer's popup already configures, or ``False`` to
                turn the tooltip off. On a layer whose popup configures no
                fields, naming one here also narrows the click popup to it --
                see :meth:`set_popup`.

        Returns:
            The layer's popup config after the change.
        """
        return self.set_popup(layer, tooltip=fields, merge=True)

    def clear_popup(self, layer: str | Layer) -> None:
        """Drop a layer's popup config, restoring the default popup."""
        handle = self._resolve_layer(layer)
        self._update_project(lambda project: _authoring.clear_popup(project, handle.id))

    def set_layer_metadata(
        self, layer: str | Layer, *, merge: bool = False, **fields: Any
    ) -> dict[str, Any] | None:
        """Set a layer's descriptive (catalog) metadata.

        The app shows and edits it in the layer's Metadata dialog, exports it
        as a STAC Item, and writes it into GeoParquet exports.

        Args:
            layer: The layer, by id, name, or handle.
            merge: Keep existing fields that ``fields`` does not name.
            **fields: Any of ``title``, ``abstract``, ``keywords`` (list or
                comma-separated string), ``license`` (SPDX id or free text),
                ``attribution``, ``contact`` (mapping with ``name``,
                ``email``, ``organization``), ``lineage``,
                ``temporal_extent`` (``(start, end)`` ISO 8601 dates), and
                ``links`` (URLs or mappings with ``href``, ``rel``, ``title``).

        Returns:
            The layer's metadata block after the change, or ``None`` when empty.

        Raises:
            ValueError: If a value fails validation (email, dates, URLs).

        Example:
            >>> m.set_layer_metadata(
            ...     "Rivers",
            ...     title="Rivers of Tennessee",
            ...     keywords=["hydrology", "rivers"],
            ...     license="CC-BY-4.0",
            ...     contact={"name": "Ada", "email": "ada@example.org"},
            ...     temporal_extent=("2019-01-01", "2019-12-31"),
            ... )
        """
        handle = self._resolve_layer(layer)
        self._update_project(
            lambda project: _authoring.set_layer_metadata(project, handle.id, merge=merge, **fields)
        )
        return handle.descriptive_metadata or None

    def clear_layer_metadata(self, layer: str | Layer) -> None:
        """Drop a layer's descriptive metadata."""
        handle = self._resolve_layer(layer)
        self._update_project(lambda project: _authoring.clear_layer_metadata(project, handle.id))

    def set_layer_filter(self, layer: str | Layer, expression: Any) -> None:
        """Hide a layer's features that do not match a boolean expression.

        Writes the layer's saved ``filterExpression`` -- the same filter the
        app's **Select by Expression -> Filter layer** creates. The data is
        untouched; non-matching features are just not drawn.

        Args:
            layer: The layer, by id, name, or handle.
            expression: A boolean MapLibre expression, as a list or a JSON
                string, e.g. ``[">=", ["get", "population"], 100000]``.
                ``None`` clears the filter.

        Example:
            >>> m.set_layer_filter("Cities", ["==", ["get", "state"], "TN"])
        """
        handle = self._resolve_layer(layer)
        self._update_project(
            lambda project: _authoring.set_layer_filter(project, handle.id, expression)
        )

    def set_floor_picker(
        self,
        layer: str | Layer,
        field: str | None = "level",
        level: Any = None,
        *,
        mode: str | None = None,
    ) -> None:
        """Link a multi-floor layer to the app's on-map floor picker.

        The picker lists the floors in ``field`` across every linked layer and
        draws one floor, or a floor and the ones below it. It reads
        OpenStreetMap ``level`` values (``"0"``, ``"0;1"``, ``"-1-0"``),
        numbers and IMDF ordinals. Combine it with an extrusion base from the
        same field to stack the floors in 3D.

        Args:
            layer: The layer, by id, name, or handle.
            field: The property holding the floor; ``None`` unlinks the layer.
            level: The floor to show, e.g. ``"0"`` or ``-1``. Applies to every
                linked layer. ``None`` keeps the floor already shown; pass
                ``mode="all"`` to show every floor.
            mode: ``"only"`` (the default for a level), ``"below"`` to also
                show the floors under it, or ``"all"``.

        Example:
            >>> m.set_floor_picker("Rooms", "level", "0", mode="below")
        """
        handle = self._resolve_layer(layer)
        self._update_project(
            lambda project: _authoring.set_floor_picker(project, handle.id, field, level, mode=mode)
        )

    def set_labels(
        self,
        layer: str | Layer,
        field: str | None = None,
        *,
        expression: Any = None,
        enabled: bool | None = None,
        **options: Any,
    ) -> dict[str, Any]:
        """Label a vector layer's features from an attribute or an expression.

        Options left out keep the layer's current label settings.

        Args:
            layer: The layer, by id, name, or handle.
            field: Property whose value becomes the label text.
            expression: MapLibre expression for the label text, overriding
                ``field`` (e.g. ``["concat", ["get", "name"], " ", ["get",
                "pop"]]``).
            enabled: ``False`` hides the labels but keeps their settings;
                omitted, they keep their current state (on for a new layer).
            **options: ``placement`` (``"point"``/``"line"``), ``size``,
                ``color``, ``halo_color``, ``halo_width``, ``min_zoom``,
                ``max_zoom``, ``allow_overlap``, ``anchor``, ``offset_x``,
                ``offset_y``, ``rotation``, ``max_width``, ``transform``
                (``"none"``/``"uppercase"``/``"lowercase"``),
                ``number_format``, ``number_decimals``, ``number_locale``,
                ``dedupe`` (``"off"``/``"unique"``/``"concatenate"``), and the
                data-defined ``size_expression``, ``color_expression``,
                ``opacity_expression``, ``visibility_expression``,
                ``priority_expression``.

        Returns:
            The layer's labels object after the change.

        Example:
            >>> m.set_labels("Cities", "name", size=14, halo_width=2, anchor="top")
        """
        handle = self._resolve_layer(layer)
        result: dict[str, Any] = {}

        def _apply(project: dict[str, Any]) -> None:
            result.update(
                _authoring.set_labels(
                    project, handle.id, field, expression=expression, enabled=enabled, **options
                )
            )

        self._update_project(_apply)
        return result

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
        handle = self._resolve_layer(layer)
        created_id: list[str] = []

        def _dup(p: dict[str, Any]) -> None:
            summary = _authoring.duplicate_layer(p, handle.id, name=name)
            created_id.append(str(summary["id"]))

        self._update_project(_dup)
        return created_id[0]

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
        # Disarm before the project sync, not after: the two traits sync
        # independently, so clearing second leaves a window where the front end
        # replays `identify` for a layer the project push just deleted.
        self._drop_identify_layers(lambda layer_id: layer_id == resolved_id)
        self._update_project(lambda p: _authoring.remove_layer(p, resolved_id))

    def clear_layers(self) -> None:
        """Remove all layers from the map."""
        # Disarm first, for the reason given in `remove_layer`.
        self._drop_identify_layers(lambda _layer_id: True)
        self._update_project(lambda p: p.update({"layers": []}))
