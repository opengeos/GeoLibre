"""Constants and file helpers shared by the :class:`~geolibre.geolibre.Map` modules."""

from __future__ import annotations

import json
import os
import pathlib
import warnings
from typing import Any

from . import project as _project
from ._server import unregister_local_file

_HERE = pathlib.Path(__file__).parent


_STATIC_APP = _HERE / "static" / "app"


# Accepted values for the constructor's layout/theme args, validated up front so
# a typo surfaces immediately instead of silently falling back in the front-end.
_VALID_LAYOUTS = frozenset({"embed", "full", "maponly"})


_VALID_THEMES = frozenset({"light", "dark"})


#: App chrome a :class:`Map` can show or hide, keyed by constructor argument:
#: ``(app query param, environment variable)``. The query params are read by
#: ``useLayoutOptions`` in ``apps/geolibre-desktop/src/hooks/useLayoutOptions.ts``.
CHROME_TOGGLES: dict[str, tuple[str, str]] = {
    "toolbar": ("toolbar", "GEOLIBRE_TOOLBAR"),
    "layer_panel": ("layerPanel", "GEOLIBRE_LAYER_PANEL"),
    "style_panel": ("stylePanel", "GEOLIBRE_STYLE_PANEL"),
    "status_bar": ("statusBar", "GEOLIBRE_STATUS_BAR"),
}

#: Environment variables that supply a default ``app_layout`` / ``theme``.
APP_LAYOUT_ENV = "GEOLIBRE_APP_LAYOUT"
THEME_ENV = "GEOLIBRE_THEME"
#: Environment variable that supplies a default ``renderer``.
RENDERER_ENV = "GEOLIBRE_RENDERER"

_TRUE_ENV_VALUES = frozenset({"1", "true", "yes", "on", "show", "shown", "visible"})
_FALSE_ENV_VALUES = frozenset({"0", "false", "no", "off", "hide", "hidden", "none"})


def _env_flag(name: str) -> bool | None:
    """Read a boolean chrome toggle from the environment.

    Args:
        name: The environment variable to read.

    Returns:
        ``True`` or ``False`` for a recognized value, or ``None`` when the
        variable is unset, empty, or unrecognized (which also warns).
    """
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return None
    if raw in _TRUE_ENV_VALUES:
        return True
    if raw in _FALSE_ENV_VALUES:
        return False
    warnings.warn(
        f"Ignoring {name}={os.environ[name]!r}: expected a value such as true/false, "
        "1/0, on/off, or show/hide",
        # _env_flag -> _resolve_chrome -> Map.__init__ -> the caller.
        stacklevel=4,
    )
    return None


def _resolve_chrome(values: dict[str, bool | None]) -> dict[str, bool | None]:
    """Fill unset chrome toggles from their environment variables.

    Args:
        values: Constructor arguments keyed by :data:`CHROME_TOGGLES` name;
            ``None`` means "not given".

    Returns:
        The same keys, each an explicit argument, else its environment
        variable's value, else ``None`` (the app's own default).

    Raises:
        TypeError: If an argument is neither a bool nor ``None``.
    """
    resolved: dict[str, bool | None] = {}
    for key, (_param, env) in CHROME_TOGGLES.items():
        value = values.get(key)
        if value is not None and not isinstance(value, bool):
            raise TypeError(f"{key} must be True, False, or None, got {value!r}")
        resolved[key] = value if value is not None else _env_flag(env)
    return resolved


def _chrome_query_flags(chrome: dict[str, bool | None]) -> list[str]:
    """Translate chrome toggles into the app's query-string flags.

    Args:
        chrome: Toggles keyed by :data:`CHROME_TOGGLES` name. ``None`` adds no
            flag. The toolbar has no "force visible" value, so ``True`` adds
            nothing for it.

    Returns:
        ``key=value`` strings such as ``"layerPanel=hidden"``.
    """
    flags: list[str] = []
    for key, (param, _env) in CHROME_TOGGLES.items():
        value = chrome.get(key)
        if value is None or (key == "toolbar" and value):
            continue
        flags.append(f"{param}={'visible' if value else 'hidden'}")
    return flags


#: Toolbar panels :meth:`Map.show_control` opens. Mirrors ``SCRIPTABLE_PANELS``
#: in ``apps/geolibre-desktop/src/lib/scripting/ui-controls.ts``.
MAP_PANELS = frozenset({"bookmark", "search", "measure", "minimap", "print"})


#: Built-in map controls :meth:`Map.show_control` shows or hides. Mirrors
#: ``SCRIPTABLE_MAP_CONTROLS`` in the same module.
MAP_CONTROLS = frozenset(
    {"navigation", "fullscreen", "compass", "geolocate", "globe", "scale", "attribution", "logo"}
)


_VALID_PROJECTIONS = frozenset({"globe", "mercator"})


#: Units the Measure panel accepts for :meth:`Map.show_control`. Mirrors
#: ``MEASURE_DISTANCE_UNITS`` / ``MEASURE_AREA_UNITS`` in
#: ``packages/plugins/src/plugins/components/measure.ts``.
MEASURE_DISTANCE_UNITS = frozenset(
    {"meters", "kilometers", "miles", "feet", "yards", "nautical-miles"}
)


MEASURE_AREA_UNITS = frozenset(
    {"square-meters", "square-kilometers", "square-miles", "hectares", "acres", "square-feet"}
)


#: Panels that take a ``collapsed`` option in :meth:`Map.show_control`.
_COLLAPSIBLE_PANELS = frozenset({"measure", "minimap"})


# CSV/tabular input is inlined into the project exactly like GeoJSON is, so the
# same 50 MB ceiling applies to a fetched response or a local file. It is its own
# constant (read at import), so tests can lower it without touching the GeoJSON cap.
_MAX_TABULAR_BYTES = _project._MAX_GEOJSON_BYTES


# ``ee.FeatureCollection.style()`` is declared with explicit keyword parameters,
# not ``**kwargs``, so an image-shaped ``vis_params`` (``min``/``max``/``palette``)
# would reach it as ``TypeError: style() got an unexpected keyword argument`` --
# indistinguishable, to the caller, from the ``TypeError`` add_ee_layer raises for
# an unsupported object. Validate against the accepted keys instead.
_EE_VECTOR_STYLE_KEYS = frozenset(
    {
        "color",
        "pointSize",
        "pointShape",
        "width",
        "fillColor",
        "styleProperty",
        "neighborhood",
        "lineType",
    }
)


# Column name for CSV fields beyond the header row. csv.DictReader's default
# restkey is ``None``, which would put a non-string key in the feature
# properties and break JSON serialization on the way to the widget.
_CSV_RESTKEY = "_extra"


def _remove_temporary_rasters(paths: list[pathlib.Path]) -> None:
    """Delete GeoTIFFs materialized from in-memory xarray objects.

    Args:
        paths: Paths to remove. The list is cleared in place so the same
            object can be shared with a ``weakref.finalize`` safety net.
    """
    for path in paths:
        # Drop the static server's token as well: each materialization writes to
        # a fresh temporary path, so the registry would otherwise keep an entry
        # per call for the life of the kernel.
        unregister_local_file(path)
        try:
            path.unlink(missing_ok=True)
        except OSError:  # pragma: no cover - best-effort cleanup at exit
            pass
    paths.clear()


def _read_local_vector(
    path: Any,
    data_format: str | None = None,
    source_layer: str | None = None,
) -> dict[str, Any]:
    """Read a local vector file into a GeoJSON FeatureCollection via GeoPandas.

    The browser cannot read a file that lives on the kernel host, so a local
    vector dataset is read here and inlined as GeoJSON (reprojected to EPSG:4326)
    instead of being streamed by the in-browser vector control. GeoPandas is an
    optional dependency, imported lazily so the rest of the API works without it.

    Args:
        path: Filesystem path to a vector file (Shapefile, GeoParquet,
            FlatGeobuf, GeoPackage, ...).
        data_format: Optional format hint (e.g. ``"parquet"``) that overrides
            filename-suffix detection, so a GeoParquet file saved under a
            non-standard name still uses the dedicated Parquet reader.
        source_layer: Optional layer/table name for a multi-layer container such
            as a GeoPackage.

    Returns:
        A GeoJSON FeatureCollection dict in EPSG:4326.

    Raises:
        ValueError: If the file does not exist or, after conversion to GeoJSON,
            exceeds the 50 MB size limit.
        ImportError: If GeoPandas is not installed.
    """
    file_path = pathlib.Path(str(path)).expanduser()
    if not file_path.exists():
        raise ValueError(f"Vector file not found: {path}")
    try:
        import geopandas
    except ImportError as exc:
        raise ImportError(
            "Reading a local vector file requires GeoPandas. Install it with "
            "`pip install geopandas`, or pass a URL to a hosted dataset instead."
        ) from exc
    # GeoPandas' GDAL-backed read_file may lack the Parquet driver depending on
    # the GDAL build, so dispatch (Geo)Parquet to the dedicated reader. Honour an
    # explicit format hint so a Parquet file under a non-standard name still works.
    is_parquet = (data_format or "").lower() in ("parquet", "geoparquet") or (
        file_path.suffix.lower() in (".parquet", ".geoparquet", ".pq")
    )
    if is_parquet:
        # read_parquet has no layer concept, so a source_layer here is a no-op.
        if source_layer is not None:
            warnings.warn(
                "source_layer is ignored for (Geo)Parquet files; it only applies "
                "to multi-layer containers such as GeoPackage.",
                stacklevel=2,
            )
        gdf = geopandas.read_parquet(file_path)
    else:
        gdf = geopandas.read_file(file_path, **({"layer": source_layer} if source_layer else {}))
    if gdf.crs is not None:
        gdf = gdf.to_crs(epsg=4326)
    # Round-trip through GeoPandas' own GeoJSON writer so numpy/datetime property
    # values become plain JSON the widget bus can serialize.
    geojson = gdf.to_json()
    # Cap the inlined payload like load_featurecollection does for URL/file
    # GeoJSON; a format like Shapefile can expand sharply once converted.
    if len(geojson.encode("utf-8")) > _project._MAX_GEOJSON_BYTES:
        raise ValueError(
            f"Vector file exceeds the 50 MB GeoJSON size limit after conversion: {path}"
        )
    return json.loads(geojson)
