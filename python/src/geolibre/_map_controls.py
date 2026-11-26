"""Map methods for controls, basemaps, projection, legends and colorbars."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from . import authoring as _authoring
from . import project as _project
from ._layer import Layer as Layer
from ._map_support import _COLLAPSIBLE_PANELS as _COLLAPSIBLE_PANELS
from ._map_support import _VALID_PROJECTIONS as _VALID_PROJECTIONS
from ._map_support import MAP_CONTROLS as MAP_CONTROLS
from ._map_support import MAP_PANELS as MAP_PANELS
from ._map_support import MEASURE_AREA_UNITS as MEASURE_AREA_UNITS
from ._map_support import MEASURE_DISTANCE_UNITS as MEASURE_DISTANCE_UNITS
from .basemaps import resolve_basemap


class _MapControlsMixin:
    """Map methods for controls, basemaps, projection, legends and colorbars."""

    def add_basemap(self, basemap: str) -> None:
        """Set the background basemap style.

        Args:
            basemap: A basemap name or MapLibre style URL.
        """
        url = resolve_basemap(basemap)
        self._update_project(lambda p: p.update({"basemapStyleUrl": url}))

    # Name parity with the in-app console's geolibre.set_basemap(url).
    def set_basemap(self, basemap: str) -> None:
        """Set the background basemap style (alias of :meth:`add_basemap`).

        Args:
            basemap: A basemap name or MapLibre style URL.
        """
        self.add_basemap(basemap)

    def set_renderer(self, renderer: str, *, pane_id: str | None = None) -> None:
        """Select maplibre, cesium, mapbox or arcgis for the primary map or a named pane."""
        self._update_project(lambda p: _authoring.set_renderer(p, renderer, pane_id=pane_id))

    def get_renderer(self, *, pane_id: str | None = None) -> str:
        """Read the primary renderer or a secondary pane's ``viewKind``."""
        if pane_id is None:
            return self.project.get("primaryRenderer", "maplibre")
        for pane in _authoring.secondary_panes(self.project):
            if pane["id"] == pane_id:
                return pane.get("viewKind", "maplibre")
        raise ValueError(f"Unknown pane: {pane_id}")

    def set_map_layout(
        self, rows: int, cols: int, *, view_kinds: list[str] | None = None, sync_view: bool = True
    ) -> None:
        """Configure a grid; ``view_kinds`` lists all pane renderers, primary first."""
        self._update_project(
            lambda p: _authoring.set_map_layout(
                p, rows, cols, view_kinds=view_kinds, sync_view=sync_view
            )
        )

    @property
    def basemap(self) -> str | None:
        """The current basemap style URL, embedded credentials redacted.

        MapTiler, Stadia and others put an API key in the style URL itself, so
        this is swept like :attr:`Layer.source` rather than printed into a
        notebook cell. Read :attr:`project` for the URL exactly as stored.
        """
        value = self.project.get("basemapStyleUrl")
        return _project.redact_url(str(value)) if value is not None else None

    def _drop_identify_layers(self, removed: Callable[[str], bool]) -> None:
        """Drop removed layers from the Identify target in ``_ui``.

        A list that keeps one layer narrows to that layer, and one that keeps
        none turns Identify off, matching what the app does when those layers
        are deleted there. ``"all"`` and ``None`` are left alone.

        Args:
            removed: Returns ``True`` for the id of a layer being removed.
        """
        identify = self._ui.get("identify")
        if identify is None or identify == "all":
            return
        if isinstance(identify, str):
            if removed(identify):
                self._set_ui(identify=None)
            return
        kept = [layer_id for layer_id in identify if not removed(layer_id)]
        if len(kept) == len(identify):
            return
        self._set_ui(identify=kept[0] if len(kept) == 1 else (kept or None))

    def set_identify(self, layer: str | Layer | Sequence[str | Layer] | None = "all") -> None:
        """Arm the Identify tool so clicking a feature opens its popup.

        Popups (including those configured with :meth:`set_popup` or the
        ``popup=`` argument of :meth:`add_markers`) open only while Identify is
        armed. This does from Python what the Identify button on a layer, or
        the "Identify visible layers" button in the Layers panel header, does
        in the app. The choice is applied when the map loads, so it can be
        made before the map is displayed.

        Identify is armed on one layer, on a list of layers, or on every
        visible layer, and hover tooltips pause while it is armed, as they do
        in the app. The choice is saved by :meth:`save_project`,
        :meth:`to_project` and :meth:`to_html`, so a shared map opens with
        Identify armed the same way.

        Args:
            layer: A layer id, display name, or :class:`Layer` handle to
                identify on that layer; a list of them to identify only those
                layers (clicking opens popups for them and not for the rest);
                ``"all"`` (the default) to identify every visible queryable
                layer; or ``None`` to turn Identify off. ``"all"`` is matched
                before the lookup, so a layer whose id or display name is
                literally ``"all"`` cannot be targeted on its own.

        Raises:
            ValueError: If ``layer`` (or any entry of a list) matches no layer,
                or a list is empty.
        """
        if layer is None or (isinstance(layer, str) and layer == "all"):
            self._set_ui(identify=layer)
            return
        if isinstance(layer, (str, Layer)):
            self._set_ui(identify=self._resolve_layer(layer).id)
            return
        if not isinstance(layer, Sequence):
            raise ValueError(
                "set_identify: layer must be a layer id, name, handle, a list of them, "
                f'"all", or None, got {type(layer).__name__}'
            )
        ids = list(dict.fromkeys(self._resolve_layer(item).id for item in layer))
        if not ids:
            raise ValueError("set_identify: the list of layers is empty")
        self._set_ui(identify=ids[0] if len(ids) == 1 else ids)

    def show_control(
        self,
        name: str,
        visible: bool = True,
        *,
        collapsed: bool | None = None,
        distance_unit: str | None = None,
        area_unit: str | None = None,
    ) -> None:
        """Show (or hide) a map control or toolbar panel.

        Covers the panels in the app's Controls menu (``"bookmark"``,
        ``"search"``, ``"measure"``, ``"minimap"``, ``"print"``) and the
        built-in map controls (``"navigation"``, ``"fullscreen"``,
        ``"compass"``, ``"geolocate"``, ``"globe"``, ``"scale"``,
        ``"attribution"``, ``"logo"``). The choice is applied when the map
        loads, so it can be made before the map is displayed. It is saved by
        :meth:`save_project`, :meth:`to_project` and :meth:`to_html`, so a
        shared map opens with the same controls.

        Hiding ``"globe"`` removes the globe/flat toggle button only; use
        :meth:`set_projection` to change how the map is drawn.

        The Measure panel opens expanded with the tool active, so a viewer's
        first clicks on the map place measurement points. For a shared map,
        ``m.show_control("measure", collapsed=True)`` shows only its ruler
        button until the viewer clicks it, and ``distance_unit`` /
        ``area_unit`` pick the units it starts in.

        Args:
            name: The control or panel name.
            visible: ``True`` to show it, ``False`` to hide it.
            collapsed: For ``"measure"`` and ``"minimap"``, ``True`` shows only
                the control's on-map button, ``False`` opens it expanded.
                ``None`` (the default) keeps the app's default, expanded.
            distance_unit: For ``"measure"``, the distance unit: one of
                ``"meters"``, ``"kilometers"`` (the app's default),
                ``"miles"``, ``"feet"``, ``"yards"`` or ``"nautical-miles"``.
            area_unit: For ``"measure"``, the area unit: one of
                ``"square-meters"``, ``"square-kilometers"`` (the app's
                default), ``"square-miles"``, ``"hectares"``, ``"acres"`` or
                ``"square-feet"``.

        Raises:
            ValueError: If ``name`` is not a known control or panel, or an
                option does not apply to it or has an unknown value.
        """
        if name not in MAP_PANELS and name not in MAP_CONTROLS:
            raise ValueError(
                f"Unknown control {name!r}; expected one of {sorted(MAP_PANELS | MAP_CONTROLS)}"
            )
        options: dict[str, Any] = {}
        if collapsed is not None:
            if name not in _COLLAPSIBLE_PANELS:
                raise ValueError(f"collapsed applies only to {sorted(_COLLAPSIBLE_PANELS)}")
            if not isinstance(collapsed, bool):
                raise ValueError("collapsed must be a boolean")
            options["collapsed"] = collapsed
        for key, value, units in (
            ("distanceUnit", distance_unit, MEASURE_DISTANCE_UNITS),
            ("areaUnit", area_unit, MEASURE_AREA_UNITS),
        ):
            if value is None:
                continue
            if name != "measure":
                raise ValueError(f"{key} applies only to 'measure'")
            if value not in units:
                raise ValueError(f"Unknown {key} {value!r}; expected one of {sorted(units)}")
            options[key] = value
        shown = bool(visible)
        setting: bool | dict[str, Any] = (
            {"visible": shown, **options} if options and shown else shown
        )
        self._set_ui(controls={**self._ui.get("controls", {}), name: setting})

    def hide_control(self, name: str) -> None:
        """Hide a map control or toolbar panel (see :meth:`show_control`).

        Args:
            name: The control or panel name.
        """
        self.show_control(name, False)

    def set_projection(self, projection: str) -> None:
        """Draw the map as a 3D globe or as a flat Web Mercator map.

        New maps use ``"globe"``, which shows the Earth as a sphere at low
        zooms. The projection is saved in the project.

        Args:
            projection: ``"globe"`` or ``"mercator"``.

        Raises:
            ValueError: If ``projection`` is not one of the two.
        """
        if projection not in _VALID_PROJECTIONS:
            raise ValueError(f"projection must be 'globe' or 'mercator', got {projection!r}")

        self._update_project(lambda p: _authoring.set_projection(p, projection))

    @property
    def projection(self) -> str:
        """The persisted map projection, ``"globe"`` or ``"mercator"``."""
        projection = self.project.get("preferences", {}).get("map", {}).get("projection")
        return "mercator" if projection == "mercator" else "globe"

    def split_map(
        self,
        left_layers: Any = None,
        right_layers: Any = None,
        *,
        orientation: str = "vertical",
        position: float = 50,
        control_position: str = "top-left",
    ) -> None:
        """Add a swipe (split-map) comparison slider between two layer sets.

        Enables the Layer Swipe control, which clips the left/top layers to one
        side of a draggable slider and the right/bottom layers to the other, for
        before/after comparisons. Drives the app's built-in swipe plugin through
        the project, so it appears with no reload.

        Args:
            left_layers: Layer(s) shown on the left/top of the slider, as a layer
                id, a :class:`Layer`, or a list of those. The string
                ``"__basemap__"`` selects the basemap.
            right_layers: Layer(s) shown on the right/bottom of the slider, in the
                same forms as ``left_layers``.
            orientation: ``"vertical"`` (slider moves left/right) or
                ``"horizontal"`` (slider moves up/down).
            position: Initial slider position as a percentage in ``[0, 100]``.
            control_position: Corner for the swipe panel; one of ``"top-left"``,
                ``"top-right"``, ``"bottom-left"``, ``"bottom-right"``.

        Raises:
            ValueError: If ``orientation``, ``control_position``, or a layer
                reference is invalid.
        """
        # Layer objects are resolved to ids here (authoring.py works on plain
        # project dicts and knows nothing about the Layer handle); the rest of
        # the validation and state building is shared with the MCP server.
        left = self._coerce_layer_ids(left_layers)
        right = self._coerce_layer_ids(right_layers)
        self._update_project(
            lambda p: _authoring.add_swipe(
                p,
                left_layers=left,
                right_layers=right,
                orientation=orientation,
                position=position,
                control_position=control_position,
            )
        )

    def add_legend(
        self,
        title: str | None = None,
        *,
        legend_dict: dict[str, str] | None = None,
        labels: list[str] | None = None,
        colors: list[str] | None = None,
        builtin: str | None = None,
        position: str = "bottom-left",
        shape: str = "square",
    ) -> None:
        """Add a legend to the map.

        Supply the legend entries one of three ways: a built-in preset
        (``builtin``), a ``{label: color}`` mapping (``legend_dict``), or parallel
        ``labels`` and ``colors`` lists. Each call adds another legend, so a map
        can carry several at once.

        Args:
            title: Legend title. Defaults to ``"Legend"``, or the preset's title
                when ``builtin`` is given and no title is passed.
            legend_dict: A mapping of label to CSS color (preserves order).
            labels: Item labels, paired position-wise with ``colors``.
            colors: Item CSS colors, paired position-wise with ``labels``.
            builtin: A built-in preset name (e.g. ``"nlcd"``,
                ``"esa_worldcover"``). See
                :func:`geolibre.legends.builtin_legend_names`.
            position: Corner for the legend; one of ``"top-left"``,
                ``"top-right"``, ``"bottom-left"``, ``"bottom-right"``.
            shape: Swatch shape for every item; ``"square"``, ``"circle"``, or
                ``"line"``.

        Raises:
            ValueError: If no entries are supplied, ``labels``/``colors`` lengths
                differ, or ``position``/``shape``/``builtin`` is invalid.
        """
        self._update_project(
            lambda p: _authoring.add_legend(
                p,
                title,
                legend_dict=legend_dict,
                labels=labels,
                colors=colors,
                builtin=builtin,
                position=position,
                shape=shape,
            )
        )

    def set_map_legend(
        self,
        title: str | None = None,
        *,
        position: str | None = None,
        group_by_layer: bool | None = None,
        visible: bool | None = None,
        collapsed: bool | None = None,
    ) -> None:
        """Show the map legend, the panel behind the app's Controls -> Legend.

        Its rows come from each visible layer's symbology, so a classified or
        categorized layer gets a matching legend without restating its colors
        (use :meth:`add_legend` for hand-written entries). A map has one;
        calling this again updates it.

        Args:
            title: Heading drawn above the entries; keeps the current one when
                omitted.
            position: ``"top-left"``, ``"top-right"``, ``"bottom-left"``, or
                ``"bottom-right"``; keeps the current corner when omitted.
            group_by_layer: Group each layer's classes under a layer heading;
                keeps the current setting when omitted.
            visible: Whether the on-map panel is open; keeps the current state
                when omitted, and opens it when the map has no legend yet.
            collapsed: Whether the open panel is collapsed to its header bar;
                keeps the current state when omitted.

        Raises:
            ValueError: If ``position`` is not a map corner.
        """
        self._update_project(
            lambda p: _authoring.set_map_legend(
                p,
                title,
                position=position,
                group_by_layer=group_by_layer,
                visible=visible,
                collapsed=collapsed,
            )
        )

    def add_colorbar(
        self,
        *,
        colormap: str = "viridis",
        vmin: float = 0.0,
        vmax: float = 1.0,
        label: str = "",
        units: str = "",
        colors: list[str] | None = None,
        orientation: str = "vertical",
        position: str = "bottom-right",
    ) -> None:
        """Add a colorbar for a continuous (single-band) raster.

        Renders a gradient with min/max ticks, from either a named colormap or an
        explicit list of CSS colors. Each call adds another colorbar.

        Args:
            colormap: A named colormap (e.g. ``"viridis"``, ``"plasma"``,
                ``"inferno"``, ``"magma"``, ``"cividis"``, ``"turbo"``,
                ``"terrain"``). Ignored when ``colors`` is given.
            vmin: Value at the low end of the colorbar.
            vmax: Value at the high end of the colorbar.
            label: Title shown alongside the colorbar.
            units: Units suffix shown with the values.
            colors: Optional list of CSS colors defining a custom gradient; when
                given, the colorbar uses these instead of ``colormap``.
            orientation: ``"vertical"`` or ``"horizontal"``.
            position: Corner for the colorbar; one of ``"top-left"``,
                ``"top-right"``, ``"bottom-left"``, ``"bottom-right"``.

        Raises:
            ValueError: If ``orientation`` or ``position`` is invalid,
                ``vmin`` is not less than ``vmax``, or ``colors`` is given but
                empty.
        """
        self._update_project(
            lambda p: _authoring.add_colorbar(
                p,
                colormap=colormap,
                vmin=vmin,
                vmax=vmax,
                label=label,
                units=units,
                colors=colors,
                orientation=orientation,
                position=position,
            )
        )

    def add_colormap(
        self,
        colormap: str = "viridis",
        *,
        vmin: float = 0.0,
        vmax: float = 1.0,
        label: str = "",
        **kwargs: Any,
    ) -> None:
        """Add a colorbar from a named colormap (alias of :meth:`add_colorbar`).

        Provided for leafmap parity; ``colormap`` is positional here.

        Args:
            colormap: A named colormap (see :meth:`add_colorbar`).
            vmin: Value at the low end of the colorbar.
            vmax: Value at the high end of the colorbar.
            label: Title shown alongside the colorbar.
            **kwargs: Forwarded to :meth:`add_colorbar` (e.g. ``units``,
                ``orientation``, ``position``).
        """
        self.add_colorbar(colormap=colormap, vmin=vmin, vmax=vmax, label=label, **kwargs)
