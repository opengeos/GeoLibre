"""Plugin state blocks: swipe, legend and colorbar controls."""

from __future__ import annotations

import json
from typing import Any

from ._constants import _PROJECT_CONSTANTS

# The four corners every map control accepts (CONTROL_POSITIONS in
# components/gui-state.ts; PROJECT_PLUGIN_CONTROL_POSITIONS in core).
CONTROL_POSITIONS = frozenset({"top-left", "top-right", "bottom-left", "bottom-right"})


# Plugin ids registered in apps/geolibre-desktop/src/hooks/usePlugins.ts.
SWIPE_PLUGIN_ID = "maplibre-gl-swipe"


COMPONENTS_PLUGIN_ID = "maplibre-gl-components"


# Plugins the app activates by default (``activeByDefault: true`` in
# packages/plugins/src/plugins/*). When a project carries a `plugins` block,
# PluginManager.restoreProjectState deactivates any active plugin missing from
# `activePluginIds`, so a block built from Python must seed these or it would
# tear down the layer control and the deck.gl overlay that backs raster
# rendering. Kept in sync with EFFECTS_PLUGIN_ID / DECK_VIZ_PLUGIN_ID and
# layer-control.ts.
DEFAULT_ACTIVE_PLUGIN_IDS = (
    "maplibre-layer-control",
    "maplibre-deckgl-viz",
    "maplibre-atmosphere-effects",
)


def ensure_plugins_block(project: dict[str, Any]) -> dict[str, Any]:
    """Return the project's ``plugins`` block, creating it if absent.

    Mirrors ``normalizeProjectPlugins`` in ``packages/core/src/project.ts``: the
    block always carries ``manifestUrls``, ``activePluginIds``,
    ``mapControlPositions``, and ``settings``. A freshly created block is seeded
    with :data:`DEFAULT_ACTIVE_PLUGIN_IDS` so adding a control from Python does
    not deactivate the app's default plugins (an existing block is left as-is,
    honouring whatever the user/app already chose).

    Args:
        project: The project dict to read/extend in place.

    Returns:
        The (possibly newly created) ``plugins`` block dict.
    """
    if "plugins" not in project:
        project["plugins"] = {
            "manifestUrls": [],
            "activePluginIds": list(DEFAULT_ACTIVE_PLUGIN_IDS),
            "mapControlPositions": {},
            "settings": {},
        }
    plugins = project["plugins"]
    plugins.setdefault("manifestUrls", [])
    plugins.setdefault("activePluginIds", [])
    plugins.setdefault("mapControlPositions", {})
    plugins.setdefault("settings", {})
    return plugins


def set_plugin_state(
    project: dict[str, Any],
    plugin_id: str,
    settings: dict[str, Any],
    *,
    position: str | None = None,
    activate: bool = True,
) -> None:
    """Store a map-control plugin's project state in place, optionally activating.

    Writes the settings blob and records the control corner; with
    ``activate=True`` it also adds ``plugin_id`` to ``activePluginIds``. The
    Components plugin (legend/colorbar) restores from its settings alone, so it
    passes ``activate=False`` to avoid mounting the full Components toolbar.

    Args:
        project: The project dict to mutate.
        plugin_id: The plugin id (e.g. ``"maplibre-gl-swipe"``).
        settings: The plugin's project-state settings blob.
        position: Optional control corner; one of :data:`CONTROL_POSITIONS`.
        activate: Whether to add ``plugin_id`` to ``activePluginIds``.
    """
    plugins = ensure_plugins_block(project)
    if activate and plugin_id not in plugins["activePluginIds"]:
        plugins["activePluginIds"].append(plugin_id)
    if position is not None:
        plugins["mapControlPositions"][plugin_id] = position
    plugins["settings"][plugin_id] = settings


def swipe_state(
    *,
    left_layers: list[str],
    right_layers: list[str],
    orientation: str = "vertical",
    position: float = 50,
) -> dict[str, Any]:
    """Build the Layer Swipe plugin state (``SwipeState`` in maplibre-swipe.ts).

    Args:
        left_layers: Layer ids shown on the left/top of the slider. The string
            ``"__basemap__"`` selects the basemap.
        right_layers: Layer ids shown on the right/bottom of the slider.
        orientation: ``"vertical"`` or ``"horizontal"``.
        position: Slider position as a percentage in ``[0, 100]``.

    Returns:
        A swipe-state dict for the project's plugin settings.
    """
    return {
        "orientation": orientation,
        "position": position,
        "collapsed": False,
        "active": True,
        "leftLayers": list(left_layers),
        "rightLayers": list(right_layers),
        "isDragging": False,
    }


def legend_gui_entry(
    title: str,
    items: list[dict[str, Any]],
    position: str,
) -> dict[str, Any]:
    """Build one legend entry (``ComponentLegendGuiEntryState``)."""
    return {"title": title, "items": items, "legendPosition": position}


def legend_gui_state(
    entry: dict[str, Any],
    *,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the Legend control state, appending ``entry`` to any existing one.

    The control renders one on-map legend per item in its ``legends`` array
    (see ``LegendGuiControl.setState`` in maplibre-gl-components), so each call
    appends rather than replaces, and the top-level fields mirror the latest
    entry for the editing form.

    Args:
        entry: A legend entry from :func:`legend_gui_entry`.
        existing: The current ``legend`` state to append to, if any.

    Returns:
        A ``ComponentLegendGuiState`` dict.
    """
    prior = existing.get("legends", []) if isinstance(existing, dict) else []
    legends = [*prior, entry]
    return {
        **entry,
        "visible": True,
        "collapsed": False,
        "hasLegend": True,
        "selectedLegendIndex": len(legends) - 1,
        "legends": legends,
    }


def colorbar_gui_entry(
    *,
    mode: str,
    colormap: str,
    custom_colors: str,
    vmin: float,
    vmax: float,
    label: str,
    units: str,
    orientation: str,
    position: str,
) -> dict[str, Any]:
    """Build one colorbar entry (``ComponentColorbarGuiEntryState``)."""
    return {
        "mode": mode,
        "colormap": colormap,
        "customColors": custom_colors,
        "vmin": vmin,
        "vmax": vmax,
        "label": label,
        "units": units,
        "orientation": orientation,
        "colorbarPosition": position,
    }


def colorbar_gui_state(
    entry: dict[str, Any],
    *,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the Colorbar control state, appending ``entry`` to any existing one.

    Like :func:`legend_gui_state`, the control renders one colorbar per item in
    its ``colorbars`` array, so calls accumulate.

    Args:
        entry: A colorbar entry from :func:`colorbar_gui_entry`.
        existing: The current ``colorbar`` state to append to, if any.

    Returns:
        A ``ComponentColorbarGuiState`` dict.
    """
    prior = existing.get("colorbars", []) if isinstance(existing, dict) else []
    colorbars = [*prior, entry]
    return {
        **entry,
        "visible": True,
        "collapsed": False,
        "hasColorbar": True,
        "selectedColorbarIndex": len(colorbars) - 1,
        "colorbars": colorbars,
    }


#: Built-in plugins that restore saved project state (they implement
#: ``applyProjectState`` in ``packages/plugins/src/plugins/*``). A settings blob
#: stored under any other id is ignored by the app unless an external plugin
#: with that id is loaded from a manifest URL, so callers refuse unknown ids
#: unless asked not to. A repo test checks every id here still appears in the
#: plugin sources.
PLUGIN_STATE_IDS: frozenset[str] = frozenset(_PROJECT_CONSTANTS["PLUGIN_STATE_IDS"])


def json_compatible(value: Any, what: str) -> Any:
    """Return a deep copy of ``value`` after checking it is plain JSON.

    Mirrors ``isJsonCompatible`` in project.ts, which drops a plugin's settings
    on load when they are not.

    Args:
        value: The value to check.
        what: The argument name, for error messages.

    Returns:
        A deep copy of the value.

    Raises:
        ValueError: If the value holds something JSON cannot represent.
    """
    try:
        return json.loads(json.dumps(value, allow_nan=False))
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{what} must be plain JSON (objects, lists, strings, numbers): {exc}"
        ) from exc
