"""Map methods for plugin state, story maps, bookmarks, groups, dashboards and layouts."""

from __future__ import annotations

from typing import Any

from . import authoring as _authoring
from ._layer import Layer as Layer


class _MapStoryMixin:
    """Map methods for plugin state, story maps, bookmarks, groups, dashboards and layouts."""

    def set_plugin_state(
        self,
        plugin_id: str,
        state: Any = None,
        *,
        position: str | None = None,
        activate: bool = True,
        allow_unknown: bool = False,
        clear: bool = False,
    ) -> dict[str, Any]:
        """Store a plugin's saved state in the project, as the app saves it.

        Each plugin reads its own state shape when the project opens (the
        Time Slider's timeline config, a grid plugin's resolution, ...). Use
        :meth:`add_swipe`, :meth:`add_legend`, and :meth:`add_colorbar` for
        those controls; they build validated state.

        Args:
            plugin_id: A built-in plugin id from
                ``geolibre.project.PLUGIN_STATE_IDS``, or an external plugin's
                id with ``allow_unknown=True``.
            state: The plugin's settings, as plain JSON. ``None`` keeps the
                stored settings (to change only ``position``/``activate``).
            position: Optional control corner (``"top-left"``, ...).
            activate: Start the plugin active when the project opens.
            allow_unknown: Accept an id that is not a built-in plugin.
            clear: Remove the stored settings only, leaving activation and
                position as they were.

        Returns:
            ``{"pluginId", "active", "position", "state"}`` as stored.
        """
        result: dict[str, Any] = {}

        def _apply(project: dict[str, Any]) -> None:
            result.update(
                _authoring.set_plugin_state(
                    project,
                    plugin_id,
                    state,
                    position=position,
                    activate=activate,
                    allow_unknown=allow_unknown,
                    clear=clear,
                )
            )

        self._update_project(_apply)
        return result

    def set_story_map(self, **settings: Any) -> dict[str, Any]:
        """Set the story map's title block and presentation settings.

        Args:
            **settings: ``title``, ``subtitle``, ``byline``, ``footer``,
                ``theme`` (``"light"``/``"dark"``), ``show_markers``,
                ``marker_color``, ``inset``, ``inset_position``,
                ``hide_chapter_nav``, ``start_slide`` and ``end_slide``
                (``"none"``, ``"blank"``, ``"black"``, ``"global"``,
                ``"adjacent"``).

        Returns:
            The story settings with each chapter's id and title.
        """
        result: dict[str, Any] = {}
        self._update_project(lambda p: result.update(_authoring.set_story_map(p, **settings)))
        return result

    def add_story_chapter(
        self,
        title: str,
        *,
        description: str = "",
        center: tuple[float, float] | None = None,
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
        """Add a chapter to the map's story (Project -> Story Map).

        A camera value left out is taken from the map's current saved view.

        Args:
            title: Chapter heading.
            description: Chapter body text.
            center: Camera target ``(lng, lat)``.
            zoom: Camera zoom, 0-24.
            pitch: Camera tilt in degrees, 0-85.
            bearing: Camera rotation in degrees.
            image: Optional image URL shown in the chapter panel.
            alignment: ``"left"``, ``"center"``, ``"right"``, or ``"full"``.
            hidden: Hide the text panel while still moving the map.
            map_animation: ``"flyTo"``, ``"easeTo"``, or ``"jumpTo"``.
            rotate_animation: Slowly rotate the camera once the move settles.
            on_enter: Layer opacity changes on entering the chapter, as
                ``{"layer": <id, name or Layer>, "opacity": 0-1,
                "duration": ms}`` entries.
            on_exit: Layer opacity changes on leaving, in the same form.
            index: Position to insert at; appended when omitted.

        Returns:
            The chapter that was added, including its ``id``.

        Example:
            >>> m.add_story_chapter("Downtown", center=(-83.92, 35.96), zoom=14,
            ...                     description="Where it started.")
        """

        def _layer_refs(entries: Any) -> Any:
            if not isinstance(entries, (list, tuple)):
                return entries
            return [
                {**entry, "layer": entry["layer"].id}
                if isinstance(entry, dict) and isinstance(entry.get("layer"), Layer)
                else entry
                for entry in entries
            ]

        result: dict[str, Any] = {}

        def _apply(project: dict[str, Any]) -> None:
            result.update(
                _authoring.add_story_chapter(
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
                    on_enter=_layer_refs(on_enter),
                    on_exit=_layer_refs(on_exit),
                    index=index,
                )
            )

        self._update_project(_apply)
        return result

    def remove_story_chapter(self, chapter: str | int) -> None:
        """Remove a story chapter by id, title, or 0-based index."""
        self._update_project(lambda p: _authoring.remove_story_chapter(p, chapter))

    def move_story_chapter(self, chapter: str | int, index: int) -> None:
        """Move a story chapter (by id, title, or index) to a new position."""
        self._update_project(lambda p: _authoring.move_story_chapter(p, chapter, index))

    def add_bookmark(
        self,
        name: str,
        *,
        center: tuple[float, float] | None = None,
        zoom: float | None = None,
        pitch: float | None = None,
        bearing: float | None = None,
        folder: str | None = None,
        visible_layers: list[str | Layer] | None = None,
    ) -> dict[str, Any]:
        """Add a saved map view to the Bookmarks panel (Controls -> Bookmarks).

        Bookmarks are saved in the project, so they travel with the file. A
        camera value left out is taken from the map's current saved view.

        Args:
            name: Bookmark name.
            center: Camera target ``(lng, lat)``.
            zoom: Camera zoom, 0-24.
            pitch: Camera tilt in degrees, 0-85.
            bearing: Camera rotation in degrees.
            folder: A folder id or name to file it under; a new name creates
                the folder.
            visible_layers: Layers (ids, names, or handles) to show when the
                bookmark is opened; the others are hidden. Omit to leave layer
                visibility alone.

        Returns:
            The bookmark that was added, including its ``id``.

        Example:
            >>> m.add_bookmark("Downtown", center=(-83.92, 35.96), zoom=14,
            ...                folder="Neighborhoods")
        """
        layer_refs = (
            [layer.id if isinstance(layer, Layer) else layer for layer in visible_layers]
            if visible_layers is not None
            else None
        )
        result: dict[str, Any] = {}

        def _apply(project: dict[str, Any]) -> None:
            result.update(
                _authoring.add_bookmark(
                    project,
                    name,
                    center=center,
                    zoom=zoom,
                    pitch=pitch,
                    bearing=bearing,
                    folder=folder,
                    visible_layers=layer_refs,
                )
            )

        self._update_project(_apply)
        return result

    def remove_bookmark(self, bookmark: str | int) -> None:
        """Remove a bookmark by id, name, or 0-based index."""
        self._update_project(lambda p: _authoring.remove_bookmark(p, bookmark))

    def add_layer_group(
        self,
        name: str,
        *,
        layers: list[str | Layer] | None = None,
        parent: str | None = None,
        collapsed: bool = False,
        visible: bool = True,
        opacity: float = 1.0,
    ) -> dict[str, Any]:
        """Add a group (folder) to the Layers panel.

        Args:
            name: Group name.
            layers: Layers (ids, names, or handles) to move into the group.
            parent: A group id or name to nest this group in.
            collapsed: Start collapsed in the panel.
            visible: Group visibility, ANDed with each member's own.
            opacity: Group opacity in [0, 1], multiplied into each member's.

        Returns:
            The new group, including its ``id`` and member ``layerIds``.
        """
        refs = [
            self._resolve_layer(layer).id if isinstance(layer, Layer) else layer
            for layer in layers or []
        ]
        result: dict[str, Any] = {}
        self._update_project(
            lambda p: result.update(
                _authoring.add_layer_group(
                    p,
                    name,
                    parent=parent,
                    layers=refs,
                    collapsed=collapsed,
                    visible=visible,
                    opacity=opacity,
                )
            )
        )
        return result

    def set_layer_group(self, layers: list[str | Layer], group: str | None) -> None:
        """Move layers into a Layers panel group, or out of every group.

        Args:
            layers: Layers (ids, names, or handles) to move.
            group: A group id or name, or None to ungroup them.
        """
        refs = [
            self._resolve_layer(layer).id if isinstance(layer, Layer) else layer for layer in layers
        ]
        self._update_project(lambda p: _authoring.set_layer_group(p, refs, group))

    def remove_layer_group(self, group: str) -> None:
        """Remove a Layers panel group, keeping its layers and subgroups.

        Args:
            group: A group id or name.
        """
        self._update_project(lambda p: _authoring.remove_layer_group(p, group))

    def add_dashboard_widget(
        self, layer: str | Layer, widget_type: str, **options: Any
    ) -> dict[str, Any]:
        """Add a widget to the Dashboard panel.

        Args:
            layer: The layer the widget reads (id, name, or handle).
            widget_type: ``histogram``, ``scatter``, ``bar``, ``line``, ``box``,
                ``pie``, ``indicator``, ``selector``, or ``list``.
            **options: Widget options, e.g. ``title``, ``field``,
                ``category``, ``aggregation``; see
                :func:`geolibre.project.dashboard_widget`.

        Returns:
            The widget that was added, including its ``id``.
        """
        if "widget_id" in options or "widgetId" in options:
            raise ValueError("options cannot set the widget id")
        if {"project", "layer", "layer_id", "widget_type"} & options.keys():
            raise ValueError("options cannot override project, layer, layer_id, or widget_type")
        ref = self._resolve_layer(layer).id if isinstance(layer, Layer) else layer
        result: dict[str, Any] = {}
        self._update_project(
            lambda p: result.update(_authoring.add_dashboard_widget(p, ref, widget_type, **options))
        )
        return result

    def remove_dashboard_widget(self, widget: str | int) -> None:
        """Remove a dashboard widget by id, title, or 0-based index."""
        self._update_project(lambda p: _authoring.remove_dashboard_widget(p, widget))

    def set_dashboard_columns(self, columns: int) -> None:
        """Set the Dashboard panel's column count (1-6)."""
        self._update_project(lambda p: _authoring.set_dashboard_columns(p, columns))

    def set_print_layout(self, *, reset: bool = False, **settings: Any) -> dict[str, Any]:
        """Change the project's Print Layout composer settings.

        Args:
            reset: Start from the defaults instead of the stored settings.
            **settings: Settings in ``snake_case`` or ``camelCase``, e.g.
                ``title="Flood extent"``, ``paper_size="a3"``,
                ``orientation="portrait"``, ``table_layer_id="Parcels"``.

        Returns:
            The stored Print Layout settings.
        """
        if "project" in settings:
            raise ValueError("settings cannot override project or reset")
        result: dict[str, Any] = {}
        self._update_project(
            lambda p: result.update(_authoring.set_print_layout(p, reset=reset, **settings))
        )
        return result
