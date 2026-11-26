"""Builders for GeoLibre project (`.geolibre.json`) dicts and their layers.

The shapes here mirror the TypeScript interfaces in
``packages/core/src/types.ts`` and ``packages/core/src/project.ts``. Keeping the
Python builders faithful to those interfaces is what lets the embedded app load
a project produced entirely from Python.
"""

from __future__ import annotations

import copy
from typing import Any

from ..basemaps import DEFAULT_BASEMAP
from ._constants import (
    _PROJECT_CONSTANTS,
)
from .credentials import (
    _CREDENTIAL_FIELD_NAMES,
    _CREDENTIAL_URL_PARAMS,
    _HEADER_FIELD_NAMES,
    _HEADER_REFERENCE_ONLY,
    _LAYER_CREDENTIAL_FIELDS,
    _MAX_REDACT_DEPTH,
    PUBLISHABLE_PLUGIN_SETTINGS,
    _normalize_credential_name,
    _publishable_plugin_settings,
    _redact_config,
    _redact_url,
    _sweep_layer_credentials,
    redact_credentials,
    redact_layer,
    redact_layer_field,
    redact_url,
)
from .expressions import (
    _LEVEL_MAX_RANGE_STEPS,
    _LEVEL_NUMBER,
    _LEVEL_RANGE,
    _POLYMORPHIC_OPERATORS,
    FILTER_EXPRESSION_OPERATORS,
    LEVEL_FILTER_MODES,
    _level_label,
    _parse_expression,
    _parse_expression_checked,
    _polymorphic_branches,
    _yields_boolean,
    filter_expression,
    level_filter,
    level_value_matches,
    parse_level_value,
)
from .fetch import (
    _GEOJSON_OPENER,
    _MAX_GEOJSON_BYTES,
    _NAT64_LOCAL,
    _NAT64_WELL_KNOWN,
    _assert_public_url,
    _is_public_ip,
    _PublicOnlyRedirectHandler,
    load_featurecollection,
)
from .layers import (
    DEFAULT_LAYER_STYLE,
    _assert_no_url_userinfo,
    _layer_base,
    geojson_layer,
    layer_group,
    pmtiles_layer,
    sql_query_layer,
    tile_layer,
    vector_layer,
    vector_tiles_layer,
    video_layer,
)
from .layout import (
    _CORNERS,
    _INDICATOR_AGGREGATIONS,
    _PAGE_FILTERS,
    _SNAKE_TO_CAMEL,
    _WIDGET_AGGREGATIONS,
    _WIDGET_OPTION_KEYS,
    _WIDGET_STRING_FIELDS,
    _WIDGET_TYPE_ONLY_OPTIONS,
    DASHBOARD_WIDGET_TYPES,
    DEFAULT_DASHBOARD_COLUMNS,
    MAX_DASHBOARD_COLUMNS,
    MIN_DASHBOARD_COLUMNS,
    PRINT_LAYOUT_CHOICES,
    PRINT_LAYOUT_DEFAULTS,
    PRINT_LAYOUT_LAYER_FIELDS,
    PRINT_LAYOUT_RANGES,
    _camel,
    _print_layout_frame,
    _print_layout_number,
    dashboard_widget,
    print_layout_settings,
)
from .metadata import (
    _METADATA_DATE_RE,
    _METADATA_DATETIME_RE,
    _METADATA_EMAIL_RE,
    _METADATA_LINK_PROTOCOLS,
    _METADATA_TEXT_KEYS,
    _clean_text,
    _is_valid_metadata_url,
    _metadata_instant,
    is_valid_metadata_date,
    layer_metadata,
    normalize_layer_metadata,
)
from .plugins import (
    COMPONENTS_PLUGIN_ID,
    CONTROL_POSITIONS,
    DEFAULT_ACTIVE_PLUGIN_IDS,
    PLUGIN_STATE_IDS,
    SWIPE_PLUGIN_ID,
    colorbar_gui_entry,
    colorbar_gui_state,
    ensure_plugins_block,
    json_compatible,
    legend_gui_entry,
    legend_gui_state,
    set_plugin_state,
    swipe_state,
)
from .popups import (
    _POPUP_CONFIG_ARGUMENTS,
    _POPUP_CONFIG_KEYS,
    _POPUP_FIELD_KEYS,
    MARKER_SHAPES,
    POPUP_DATE_FORMATS,
    POPUP_FIELD_KINDS,
    POPUP_IMAGE_HEIGHT_RANGE,
    POPUP_MAX_WIDTH_RANGE,
    _assert_tooltip_can_render,
    _coerce_popup_field,
    _normalize_key,
    _popup_pixel_size,
    apply_tooltip,
    normalize_hex_color,
    normalize_popup,
    popup_config,
    popup_field,
)
from .raster import (
    _ASSET_BAND_REFERENCE,
    _DATE_ONLY,
    PLANETARY_COMPUTER_SOURCE_KIND,
    _finite_number,
    _format_number,
    _planetary_computer_datetime,
    _resolve_bounds,
    cog_layer,
    planetary_computer_layer,
    zarr_layer,
)
from .scene import (
    _BOX_STATUSES,
    _I3S_SCENE_SERVER_PATH_RE,
    _MAX_BOX_ATTRIBUTES,
    _MAX_VECTOR_VERTICES,
    _VECTOR_KINDS,
    ARCGIS_I3S_SOURCE_KIND,
    CESIUM_ION_SOURCE_KIND,
    CUSTOM_CLASS_MAX,
    CUSTOM_CLASS_MIN,
    CZML_SOURCE_KIND,
    LIDAR_SOURCE_KIND,
    MAX_POINT_LABEL_BYTES,
    MAX_POINT_LABEL_EDITS,
    MAX_POINT_LABEL_NODE_BYTES,
    POINT_CLOUD_ANNOTATION_PLUGIN_ID,
    _box_attributes,
    _box_status,
    _clip_utf16,
    _decode_label_sources,
    _decode_point_label_node_sized,
    _hex_color,
    _i3s_scene_layer,
    _point_cloud_vectors,
    apply_point_labels,
    cesium_ion_layer,
    cesium_kml_layer,
    czml_layer,
    decode_point_label_node,
    is_i3s_scene_layer_url,
    lidar_layer,
    point_cloud_annotations,
    point_cloud_class_schema,
    three_d_tiles_layer,
)
from .services import (
    _ARCGIS_EXPORT_TILE_SIZE,
    _ARCGIS_STYLE_LIMIT,
    _ENCODE_URI_SAFE,
    _EPSG_CODE,
    _WMS_GETMAP_KEYS,
    ARCGIS_SERVICES,
    WMS_CRS,
    _append_query,
    _arcgis_export_tile_url,
    _drop_query_keys,
    _finite_float,
    _load_arcgis_cached_source,
    _normalize_wms_crs,
    _normalize_wms_version,
    _read_public_arcgis_json,
    _refuse_non_json_number,
    arcgis_layer,
    arcgis_vector_tile_layer,
    wfs_getfeature_url,
    wfs_layer,
    wms_layer,
    wmts_layer,
)
from .story import (
    _STORY_SETTINGS,
    DEFAULT_STORY_MAP,
    MAX_BOOKMARKS,
    STORY_ALIGNMENTS,
    STORY_ANIMATIONS,
    STORY_INSET_POSITIONS,
    STORY_SETTING_NAMES,
    STORY_SLIDE_MODES,
    STORY_THEMES,
    _opacity_changes,
    _story_number,
    bookmark,
    bookmark_folder,
    story_chapter,
    story_map_settings,
)
from .styles import (
    _LABEL_ENUMS,
    _LABEL_OPTIONS,
    DEFAULT_LABEL_STYLE,
    LABEL_ANCHORS,
    LABEL_DEDUPE_MODES,
    LABEL_NUMBER_LOCALES,
    LABEL_OPTION_NAMES,
    LABEL_PLACEMENTS,
    LABEL_TRANSFORMS,
    _label_value,
    label_style,
    marker_style,
)

PROJECT_VERSION: str = _PROJECT_CONSTANTS["PROJECT_VERSION"]


# Loaded from project-constants.json (synced with packages/core/src/project-constants.json).
DEFAULT_PROJECT_PREFERENCES: dict[str, Any] = copy.deepcopy(
    _PROJECT_CONSTANTS["DEFAULT_PROJECT_PREFERENCES"]
)

# Built-in vector/raster color ramps shared with @geolibre/core.
VECTOR_COLOR_RAMPS: tuple[dict[str, Any], ...] = tuple(
    copy.deepcopy(_PROJECT_CONSTANTS["VECTOR_COLOR_RAMPS"])
)


def default_map_view() -> dict[str, Any]:
    """Return the app's default camera (createDefaultMapView in project.ts)."""
    return {"center": [-100, 40], "zoom": 2, "bearing": 0, "pitch": 0}


def build_empty_project(
    name: str = "Untitled Project",
    *,
    center: list[float] | tuple[float, float] | None = None,
    zoom: float | None = None,
    basemap_url: str | None = None,
    renderer: str = "maplibre",
) -> dict[str, Any]:
    """Build an empty GeoLibre project dict.

    Args:
        name: Project display name.
        center: Optional ``[lng, lat]`` map center.
        zoom: Optional initial zoom level.
        basemap_url: Optional MapLibre style URL; defaults to the app default.
        renderer: ``"maplibre"`` (default), ``"cesium"``, ``"mapbox"``, or ``"arcgis"``.

    Returns:
        A project dict ready to be assigned to the widget's ``project`` trait.
    """
    if renderer not in {"maplibre", "cesium", "mapbox", "arcgis"}:
        raise ValueError("renderer must be maplibre, cesium, mapbox, or arcgis")
    map_view = default_map_view()
    if center is not None:
        if len(center) != 2:
            raise ValueError("center must be a [lng, lat] sequence with exactly 2 elements")
        map_view["center"] = [float(center[0]), float(center[1])]
    if zoom is not None:
        map_view["zoom"] = float(zoom)
    return {
        "version": PROJECT_VERSION,
        **({"primaryRenderer": renderer} if renderer != "maplibre" else {}),
        "name": name,
        "mapView": map_view,
        "basemapStyleUrl": basemap_url or DEFAULT_BASEMAP,
        "basemapVisible": True,
        "basemapOpacity": 1,
        "layers": [],
        "styles": {},
        "preferences": copy.deepcopy(DEFAULT_PROJECT_PREFERENCES),
        "metadata": {},
    }


# -- popups, tooltips, and marker symbology ------------------------------
#
# Mirrors LayerPopupConfig / PopupFieldConfig in packages/core/src/types.ts and
# the resolution rules in packages/core/src/popup.ts. The stored JSON is
# camelCase because the app reads it straight off the layer; the builders below
# take snake_case Python arguments and translate, so a notebook never has to
# hand-write the camelCase shape.


# ---------------------------------------------------------------------------
# Descriptive (catalog) layer metadata -- mirrors packages/core's
# layer-descriptive-metadata.ts. Stored on the layer as `descriptiveMetadata`,
# separate from the internal `metadata` record the app's renderers key off.
# ---------------------------------------------------------------------------


# -- plugin (map control) state -----------------------------------------------
# The split-map (swipe), legend, and colorbar helpers are thin wrappers over the
# app's built-in map-control plugins, configured through the project's `plugins`
# block. The shapes here mirror the plugin project-state interfaces in
# packages/plugins/src/plugins/* (maplibre-swipe.ts, components/gui-state.ts),
# so the app replays them via PluginManager.restoreProjectState on load.


# -- layer filters -------------------------------------------------------------


# -- floor picker ----------------------------------------------------------------


# -- labels --------------------------------------------------------------------


# -- plugin state --------------------------------------------------------------


# -- story maps ----------------------------------------------------------------


# -- WFS, ArcGIS services, Zarr ------------------------------------------------


# -- layer groups --------------------------------------------------------------


# -- dashboards and print layouts -----------------------------------------------
