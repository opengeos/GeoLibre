"""Builders for GeoLibre project (`.geolibre.json`) dicts and their layers.

The shapes here mirror the TypeScript interfaces in
``packages/core/src/types.ts`` and ``packages/core/src/project.ts``. Keeping the
Python builders faithful to those interfaces is what lets the embedded app load
a project produced entirely from Python.
"""

from __future__ import annotations

import base64
import copy
import ipaddress
import json
import math
import re
import socket
import uuid
import warnings
import zlib
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, unquote_plus, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from .basemaps import DEFAULT_BASEMAP


def _normalize_credential_name(name: str) -> str:
    """Fold the spellings of one credential name together.

    Mirrors ``normalizeCredentialName`` in ``packages/core/src/credentials.ts``
    so ``apiKey``, ``api_key``, ``api-key``, and ``APIKEY`` are one entry.

    Args:
        name: An object key or URL parameter name.

    Returns:
        The lowercased name with ``-`` and ``_`` removed.
    """
    return name.lower().replace("-", "").replace("_", "")


# Mirrors PROJECT_CREDENTIAL_FIELDS.layerConfiguration in
# packages/core/src/credentials.ts. Keep the two in sync: this module exists to
# keep the Python and JS project builders faithful to each other, and an entry
# missing here ships a credential the JS egress path would have stripped.
_CREDENTIAL_FIELD_NAMES = {
    _normalize_credential_name(name)
    for name in (
        "requestHeaders",
        "headers",
        "authorization",
        "apiKey",
        "apiKeys",
        "accessToken",
        "token",
        "password",
        "clientSecret",
        "connectionString",
        "secret",
        "bearer",
        "auth",
        "authKey",
        "sasToken",
        "subscriptionKey",
        "signature",
        "pwd",
    )
}
# Wider than the field registry by design, and for the same reason as the JS
# side: `key` and the Azure SAS positional parameters are credentials only
# inside a query string. As configuration field names they collide with ordinary
# state (`sr` is a spatial reference on an ArcGIS source).
_CREDENTIAL_URL_PARAMS = _CREDENTIAL_FIELD_NAMES | {
    _normalize_credential_name(name)
    for name in ("key", "sig", "se", "sp", "sv", "sr", "st", "skoid")
}
_MAX_REDACT_DEPTH = 12
# A header value that only names an environment variable (`Bearer ${TOKEN}`)
# carries no secret and survives redaction. Mirrors `isHeaderReferenceOnly` in
# packages/core/src/header-references.ts.
_HEADER_REFERENCE_ONLY = re.compile(r"(?:[A-Za-z][A-Za-z0-9._-]*\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}")
_HEADER_FIELD_NAMES = {"requestheaders", "headers"}


def _redact_url(value: str) -> str:
    """Strip URL userinfo and credential parameters without re-encoding it."""

    def keep_params(params: str) -> str:
        return "&".join(
            pair
            for pair in params.split("&")
            if pair
            and _normalize_credential_name(name := unquote_plus(pair.split("=", 1)[0]).lower())
            not in _CREDENTIAL_URL_PARAMS
            and not name.startswith("x-amz-")
        )

    before_hash, separator, fragment = value.partition("#")
    base, query_separator, query = before_hash.partition("?")
    scheme_match = re.match(r"(?i)([a-z][a-z0-9+.-]*://)", base)
    if scheme_match:
        authority_start = scheme_match.end()
        authority_end = base.find("/", authority_start)
        if authority_end == -1:
            authority_end = len(base)
        authority = base[authority_start:authority_end]
        if "@" in authority:
            base = base[:authority_start] + authority.rsplit("@", 1)[1] + base[authority_end:]
    kept_query = keep_params(query) if query_separator else ""
    kept_fragment = keep_params(fragment) if separator and "=" in fragment else fragment
    return (
        base
        + (f"?{kept_query}" if kept_query else "")
        + (f"#{kept_fragment}" if kept_fragment else "")
    )


def _redact_config(value: Any, depth: int = 0) -> Any:
    """Return project configuration with credential-named fields removed."""
    if depth >= _MAX_REDACT_DEPTH:
        return None
    if isinstance(value, str):
        return _redact_url(value)
    if isinstance(value, list):
        return [_redact_config(item, depth + 1) for item in value]
    if not isinstance(value, dict):
        return copy.deepcopy(value)
    if value.get("type") in {"FeatureCollection", "Feature", "GeometryCollection"}:
        return copy.deepcopy(value)
    result: dict[str, Any] = {}
    for key, nested in value.items():
        name = _normalize_credential_name(key)
        if name in _HEADER_FIELD_NAMES and isinstance(nested, dict):
            kept = {
                header: header_value
                for header, header_value in nested.items()
                if isinstance(header_value, str)
                and _HEADER_REFERENCE_ONLY.fullmatch(header_value.strip())
            }
            if kept:
                result[key] = kept
            continue
        if name not in _CREDENTIAL_FIELD_NAMES:
            result[key] = _redact_config(nested, depth + 1)
    return result


def _publishable_plugin_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Keep only the plugin settings listed in PUBLISHABLE_PLUGIN_SETTINGS.

    What survives is still swept by :func:`_redact_config`, the same pass layer
    configuration gets, so a credentialed URL or a credential-named field
    inside a kept blob is scrubbed rather than trusted.

    Args:
        settings: The project's ``plugins.settings`` mapping.

    Returns:
        The publishable subset, scrubbed.
    """
    kept: dict[str, Any] = {}
    for plugin_id, value in settings.items():
        if plugin_id not in PUBLISHABLE_PLUGIN_SETTINGS:
            continue
        allowed = PUBLISHABLE_PLUGIN_SETTINGS[plugin_id]
        if allowed is None:
            kept[plugin_id] = _redact_config(value)
        elif isinstance(value, dict):
            # An unexpected shape is dropped rather than passed through.
            subset = {key: item for key, item in value.items() if key in allowed}
            if subset:
                kept[plugin_id] = _redact_config(subset)
    return kept


def redact_url(url: str) -> str:
    """Return a URL with its userinfo and credential parameters stripped.

    The public entry point to the sweep :func:`redact_credentials` applies to
    every URL it finds, for the single-value reads (:attr:`Map.basemap`) that
    hand one back rather than writing a whole project out.
    """
    return _redact_url(url)


#: The layer fields that can carry credentials: request headers, signed URLs,
#: and API keys all live under these. ``connection.lastError`` is free-form text
#: taken from a caught error, which a future refresh path could easily build
#: from the request URL. Sweeping it costs nothing and keeps the no-secret
#: guarantee from depending on how an error message is worded.
_LAYER_CREDENTIAL_FIELDS = ("source", "metadata", "sourcePath", "connection")


def _sweep_layer_credentials(layer: dict[str, Any]) -> None:
    """Redact a layer's credential-bearing config fields in place."""
    for field in _LAYER_CREDENTIAL_FIELDS:
        if field in layer:
            layer[field] = _redact_config(layer[field])


def redact_layer_field(value: Any) -> Any:
    """Return one of a layer's config fields, detached and swept.

    The single-field counterpart to :func:`redact_layer`, for a read that wants
    only ``source`` and should not pay to copy an inlined GeoJSON blob first.
    """
    return _redact_config(value)


def redact_layer(layer: dict[str, Any]) -> dict[str, Any]:
    """Return a detached copy of one layer, safe to display or hand to others.

    The same sweep :func:`redact_credentials` applies to every layer, for the
    single-layer reads (:attr:`Layer.source`, :attr:`Layer.data`) that hand a
    layer record back to a caller rather than writing a whole project out.
    """
    safe = copy.deepcopy(layer)
    _sweep_layer_credentials(safe)
    return safe


def redact_credentials(project: dict[str, Any]) -> dict[str, Any]:
    """Return a detached project safe to publish, export, or hand to others."""
    safe = copy.deepcopy(project)
    if isinstance(safe.get("basemapStyleUrl"), str):
        safe["basemapStyleUrl"] = _redact_url(safe["basemapStyleUrl"])
    preferences = safe.get("preferences")
    if isinstance(preferences, dict):
        # Only rows explicitly marked non-secret travel (same rule as the app's
        # redactProjectCredentials); everything else is a credential.
        variables = preferences.get("environmentVariables")
        preferences["environmentVariables"] = (
            [v for v in variables if isinstance(v, dict) and v.get("secret") is False]
            if isinstance(variables, list)
            else []
        )
        geocoding = preferences.get("geocoding")
        if isinstance(geocoding, dict):
            geocoding["apiKeys"] = {}
            for field in ("forwardEndpoint", "reverseEndpoint"):
                if isinstance(geocoding.get(field), str):
                    geocoding[field] = _redact_url(geocoding[field])
    layers = safe.get("layers")
    if isinstance(layers, list):
        for layer in layers:
            if not isinstance(layer, dict):
                continue
            _sweep_layer_credentials(layer)
    plugins = safe.get("plugins")
    if isinstance(plugins, dict):
        manifest_urls = plugins.get("manifestUrls")
        if isinstance(manifest_urls, list):
            plugins["manifestUrls"] = [
                _redact_url(url) if isinstance(url, str) else url for url in manifest_urls
            ]
        # Drop every plugin's settings except the first-party map controls; see
        # PUBLISHABLE_PLUGIN_SETTINGS. Wiping these too silently stripped the
        # legend, colorbar, and swipe from every exported and saved project.
        settings = plugins.get("settings")
        plugins["settings"] = (
            _publishable_plugin_settings(settings) if isinstance(settings, dict) else {}
        )
    if "metadata" in safe:
        safe["metadata"] = _redact_config(safe["metadata"])
    return safe


PROJECT_VERSION = "0.1.0"

# Characters JavaScript's encodeURIComponent leaves unescaped on top of the
# always-unreserved set (alphanumerics and ``-_.~``), so _append_query produces
# byte-identical query strings to the app's appendQuery helper.
_ENCODE_URI_SAFE = "!*'()"

# Cap GeoJSON inputs (URL fetches and local files alike) so a huge source cannot
# silently exhaust kernel memory when inlined into the project.
_MAX_GEOJSON_BYTES = 50 * 1024 * 1024  # 50 MB


def _assert_public_url(url: str) -> None:
    """Reject a URL whose host resolves to a non-public address.

    Guards the kernel-side fetch against SSRF: without this a redirect (or a
    crafted URL) could reach a private/loopback/link-local address such as a
    cloud metadata endpoint (``169.254.169.254``) and inline the response into
    the project. Every address the host resolves to must be globally routable.

    Args:
        url: The URL about to be fetched (or a redirect target).

    Raises:
        ValueError: If the host is missing, unresolvable, or maps to any
            non-public address.
    """
    host = urlsplit(url).hostname
    if not host:
        raise ValueError(f"URL has no host: {url}")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve host for URL: {url}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError(f"Refusing to fetch from a non-public address ({ip}): {url}")


class _PublicOnlyRedirectHandler(HTTPRedirectHandler):
    """Redirect handler that re-validates every hop against ``_assert_public_url``."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        _assert_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Opener used for all remote GeoJSON fetches: follows redirects but rejects any
# hop that points at a non-public address (SSRF defence).
_GEOJSON_OPENER = build_opener(_PublicOnlyRedirectHandler)

# Mirror of DEFAULT_LAYER_STYLE in packages/core/src/types.ts. The app fills in
# any missing fields on load, so layers only need to override what differs, but
# carrying the full default keeps round-tripped projects stable.
DEFAULT_LAYER_STYLE: dict[str, Any] = {
    "minZoom": 0,
    "maxZoom": 24,
    "fillColor": "#3b82f6",
    "strokeColor": "#1e40af",
    "strokeWidth": 2,
    "fillOpacity": 0.6,
    "circleRadius": 6,
    "textColor": "#111827",
    "textHaloColor": "#ffffff",
    "textHaloWidth": 2,
    "textSize": 16,
    "extrusionEnabled": False,
    "extrusionColor": "#3b82f6",
    "extrusionOpacity": 0.8,
    "extrusionHeightProperty": "height",
    "extrusionHeightScale": 1,
    "extrusionBase": 0,
    "extrusionAdvancedStyleEnabled": False,
    "extrusionColorExpression": "",
    "extrusionHeightExpression": "",
    "vectorStyleMode": "single",
    "vectorStyleProperty": "",
    "vectorStyleClassCount": 5,
    "vectorStyleColorRamp": "viridis",
    "vectorStyleClassificationScheme": "equal-interval",
    "vectorStyleStops": [
        {"value": 0, "color": "#dbeafe"},
        {"value": 1, "color": "#2563eb"},
    ],
    "vectorStyleExpression": "",
    "pointRenderer": "single",
    "heatmapRadius": 30,
    "heatmapIntensity": 1,
    "heatmapColorRamp": "turbo",
    "heatmapWeightProperty": "",
    "clusterRadius": 50,
    "clusterMaxZoom": 14,
    "rasterBrightnessMin": 0,
    "rasterBrightnessMax": 1,
    "rasterSaturation": 0,
    "rasterContrast": 0,
    "rasterHueRotate": 0,
    # How the layer composites onto the map beneath it. "normal" is ordinary
    # alpha compositing; see BLEND_MODES in packages/core/src/types.ts for the
    # full set the app accepts.
    "blendMode": "normal",
}

# Mirror of DEFAULT_PROJECT_PREFERENCES in packages/core/src/types.ts.
DEFAULT_PROJECT_PREFERENCES: dict[str, Any] = {
    "map": {
        "restrictBounds": False,
        "bounds": [-180, -85, 180, 85],
        "minZoom": 0,
        "maxZoom": 24,
        "maxPitch": 85,
        "renderWorldCopies": True,
    },
    "environmentVariables": [],
}


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

#: How a popup value renders. ``"auto"`` stringifies (and draws an inline
#: base64 image or sanitized KML description markup as itself).
POPUP_FIELD_KINDS = frozenset({"auto", "text", "number", "date", "link", "image"})

#: Rendering choices for a ``"date"`` field.
POPUP_DATE_FORMATS = frozenset({"date", "datetime", "time", "iso", "year"})

#: Inclusive bounds for a popup's ``max_width``, in CSS pixels. Mirrors
#: ``POPUP_MAX_WIDTH_RANGE`` in ``packages/core/src/popup.ts``: the floor is the
#: popup's own minimum width, the ceiling stops a popup blanketing the map.
POPUP_MAX_WIDTH_RANGE = (288, 1200)

#: Inclusive bounds for a popup's ``image_height``, in CSS pixels. Mirrors
#: ``POPUP_IMAGE_HEIGHT_RANGE`` in ``packages/core/src/popup.ts``.
POPUP_IMAGE_HEIGHT_RANGE = (40, 1200)

#: Built-in marker shapes, plus ``"custom"`` for a caller-supplied SVG.
MARKER_SHAPES = frozenset(
    {"circle", "square", "triangle", "diamond", "star", "cross", "pin", "custom"}
)

# Popup config keys accepted from a caller's dict, keyed by the normalized
# spelling (lowercased, underscores dropped) so ``title_field``, ``titleField``
# and ``titlefield`` are one key. "tooltip" is sugar handled by normalize_popup.
_POPUP_CONFIG_KEYS = {
    "click": "click",
    "hover": "hover",
    "fields": "fields",
    "title": "titleField",
    "titlefield": "titleField",
    "titleexpression": "titleExpression",
    "bodyexpression": "bodyExpression",
    "showfeatureid": "showFeatureId",
    "maxwidth": "maxWidth",
    "imageheight": "imageHeight",
    "tooltip": "tooltip",
}

# Popup *field* keys accepted from a caller's dict, same normalization. The
# format parts are accepted flat (``decimals=2``) as well as nested under
# ``format``, because flat is what a notebook reaches for first.
_POPUP_FIELD_KEYS = {
    "field": "field",
    "label": "label",
    "kind": "kind",
    "hover": "hover",
    "format": "format",
    "decimals": "decimals",
    "thousands": "thousands",
    "dateformat": "date_format",
    "prefix": "prefix",
    "suffix": "suffix",
    "linklabel": "link_label",
}


# The snake_case spellings a popup mapping accepts, derived from the table above
# so an added or removed key cannot leave the error message behind.
_POPUP_CONFIG_ARGUMENTS = sorted(
    {
        "titleField": "title",
        "titleExpression": "title_expression",
        "bodyExpression": "body_expression",
        "showFeatureId": "show_feature_id",
        "maxWidth": "max_width",
        "imageHeight": "image_height",
    }.get(value, value)
    for value in set(_POPUP_CONFIG_KEYS.values())
)


def _normalize_key(key: Any) -> str:
    """Fold a mapping key's spelling: lowercased, ``-``/``_`` removed."""
    return str(key).lower().replace("-", "").replace("_", "")


def normalize_hex_color(value: str) -> str | None:
    """Return ``value`` as ``#rrggbb``, or ``None`` if it is not a hex color.

    Mirrors ``normalizeHexColor`` in ``packages/core/src/color-ramp.ts``, which
    is what the marker sprite baker runs a ``markerColor`` through: a value it
    rejects silently draws the default blue.

    Args:
        value: A color token such as ``"#f00"``, ``"FF0000"``, or ``"red"``.

    Returns:
        The canonical ``#rrggbb`` form, or ``None`` for a non-hex token.
    """
    token = str(value).strip().lower()
    if not token:
        return None
    if not token.startswith("#"):
        token = f"#{token}"
    if re.fullmatch(r"#[0-9a-f]{3}", token):
        token = "#" + "".join(channel * 2 for channel in token[1:])
    return token if re.fullmatch(r"#[0-9a-f]{6}", token) else None


def _popup_pixel_size(name: str, value: Any, bounds: tuple[int, int]) -> int:
    """Validate a popup pixel size against the range the app renders.

    The app clamps an out-of-range size rather than failing, so an accepted
    ``max_width=4000`` would be written to the project and drawn at 1200 --
    a setting that reads one way in the notebook and another on the map.
    Raising here keeps the two the same.

    Args:
        name: The argument name, for the error message.
        value: The caller's size in CSS pixels.
        bounds: The inclusive ``(minimum, maximum)`` the app honors.

    Returns:
        The size as a whole number of pixels.

    Raises:
        ValueError: If the value is not a whole number inside ``bounds``.
    """
    low, high = bounds
    try:
        size = int(value)
        exact = size == value
    except (TypeError, ValueError, OverflowError):
        # OverflowError is what `int(float("inf"))` raises, so without it an
        # infinite size escapes as an internal error instead of the ValueError
        # this function documents.
        exact = False
    if not exact:
        raise ValueError(f"{name} must be a whole number of pixels, got {value!r}")
    if not low <= size <= high:
        raise ValueError(f"{name} must be between {low} and {high} pixels, got {value!r}")
    return size


def popup_field(
    field: str,
    *,
    label: str | None = None,
    kind: str = "auto",
    hover: bool | None = None,
    decimals: int | None = None,
    thousands: bool | None = None,
    date_format: str | None = None,
    prefix: str | None = None,
    suffix: str | None = None,
    link_label: str | None = None,
) -> dict[str, Any]:
    """Build one entry of a layer popup's field list.

    Args:
        field: The feature property key to show.
        label: Heading printed instead of the raw property name.
        kind: How the value renders: ``"auto"``, ``"text"``, ``"number"``,
            ``"date"``, ``"link"`` (an ``http(s)`` URL becomes an anchor), or
            ``"image"`` (an ``http(s)`` URL or inline base64 raster data URL
            becomes a thumbnail).
        hover: Include this field in the hover tooltip's short subset.
        decimals: Fixed decimal places for a ``"number"`` field.
        thousands: Group thousands for a ``"number"`` field.
        date_format: One of :data:`POPUP_DATE_FORMATS` for a ``"date"`` field.
        prefix: Text placed before the formatted value.
        suffix: Text placed after the formatted value, e.g. a unit.
        link_label: Anchor text for a ``"link"`` field; defaults to the value.

    Returns:
        A ``PopupFieldConfig`` dict.

    Raises:
        ValueError: If ``field`` is blank, or ``kind``/``date_format``/
            ``decimals`` is outside the range the app understands.
    """
    name = str(field).strip()
    if not name:
        raise ValueError("popup field name must be a non-empty string")
    if kind not in POPUP_FIELD_KINDS:
        raise ValueError(f"kind must be one of {sorted(POPUP_FIELD_KINDS)}, got {kind!r}")
    if date_format is not None and date_format not in POPUP_DATE_FORMATS:
        raise ValueError(
            f"date_format must be one of {sorted(POPUP_DATE_FORMATS)}, got {date_format!r}"
        )

    config: dict[str, Any] = {"field": name}
    if label is not None:
        config["label"] = str(label)
    if kind != "auto":
        config["kind"] = kind
    if hover is not None:
        config["hover"] = bool(hover)

    fmt: dict[str, Any] = {}
    if decimals is not None:
        # Truncating 2.9 to 2 would quietly format to a precision the caller
        # never asked for, which the range check below would not catch either.
        try:
            digits = int(decimals)
            exact = digits == decimals
        except (TypeError, ValueError, OverflowError):
            # `int(float("inf"))` raises OverflowError, not ValueError.
            exact = False
        if not exact:
            raise ValueError(f"decimals must be a whole number, got {decimals!r}")
        # Intl.NumberFormat throws outside 0-20, which would take the whole
        # popup render down rather than mis-format one cell.
        if not 0 <= digits <= 20:
            raise ValueError(f"decimals must be between 0 and 20, got {decimals!r}")
        fmt["decimals"] = digits
    if thousands is not None:
        fmt["thousands"] = bool(thousands)
    if date_format is not None:
        fmt["dateFormat"] = date_format
    if prefix is not None:
        fmt["prefix"] = str(prefix)
    if suffix is not None:
        fmt["suffix"] = str(suffix)
    if link_label is not None:
        fmt["linkLabel"] = str(link_label)
    if fmt:
        config["format"] = fmt
    return config


def _coerce_popup_field(entry: Any) -> dict[str, Any]:
    """Coerce one popup field entry (a name or a mapping) to a field config."""
    if isinstance(entry, str):
        return popup_field(entry)
    if not isinstance(entry, dict):
        raise ValueError(
            f"each popup field must be a property name or a mapping, got {type(entry).__name__}"
        )

    kwargs: dict[str, Any] = {}
    name: Any = None
    for key, value in entry.items():
        mapped = _POPUP_FIELD_KEYS.get(_normalize_key(key))
        if mapped is None:
            raise ValueError(
                f"unknown popup field key {key!r}; expected one of "
                f"{sorted(set(_POPUP_FIELD_KEYS.values()))}"
            )
        if mapped == "field":
            name = value
        elif mapped == "format":
            # A nested `format` block, as the stored JSON carries it. Flat keys
            # given alongside it win, so `{"format": {...}, "decimals": 2}`
            # behaves the way the later, more specific spelling reads.
            if not isinstance(value, dict):
                raise ValueError("popup field 'format' must be a mapping")
            for fmt_key, fmt_value in value.items():
                fmt_mapped = _POPUP_FIELD_KEYS.get(_normalize_key(fmt_key))
                if fmt_mapped is None or fmt_mapped in (
                    "field",
                    "label",
                    "kind",
                    "hover",
                    "format",
                ):
                    raise ValueError(f"unknown popup field format key {fmt_key!r}")
                kwargs.setdefault(fmt_mapped, fmt_value)
        else:
            kwargs[mapped] = value
    if name is None:
        raise ValueError(f"popup field mapping needs a 'field' key; got {sorted(entry)}")
    return popup_field(name, **kwargs)


def popup_config(
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
) -> dict[str, Any]:
    """Build a layer's ``LayerPopupConfig``.

    Args:
        fields: The fields to show and their order: a single property name, or
            a sequence of property names and/or :func:`popup_field` mappings.
            ``None`` keeps the default, which shows every visible property in
            the feature's own key order.
        click: ``False`` suppresses the click popup entirely.
        hover: ``True`` shows a hover tooltip built from the fields flagged
            ``hover``.
        title: Property whose value titles the popup instead of the layer name.
        title_expression: MapLibre expression source (JSON text) producing the
            title; wins over ``title`` and falls back to it when it fails.
        body_expression: MapLibre expression source producing the whole popup
            body as one block of text instead of the field rows.
        show_feature_id: ``False`` drops the synthetic ``id`` row.
        max_width: Widest the click popup may draw, in CSS pixels
            (:data:`POPUP_MAX_WIDTH_RANGE`). The viewport still caps it, so a
            popup never covers the whole map on a small screen.
        image_height: Tallest an ``"image"`` field's thumbnail may draw inside
            the popup, in CSS pixels (:data:`POPUP_IMAGE_HEIGHT_RANGE`). A
            thumbnail keeps its aspect ratio, so raise ``max_width`` too for a
            landscape photo to use the extra height.

    Returns:
        A ``LayerPopupConfig`` dict, empty when nothing was configured.

    Raises:
        ValueError: If a field entry is not a name or a valid field mapping, or
            a size falls outside the range the app renders.
    """
    config: dict[str, Any] = {}
    if click is not None:
        config["click"] = bool(click)
    if hover is not None:
        config["hover"] = bool(hover)
    if title is not None:
        config["titleField"] = str(title)
    if title_expression is not None:
        config["titleExpression"] = str(title_expression)
    if body_expression is not None:
        config["bodyExpression"] = str(body_expression)
    if show_feature_id is not None:
        config["showFeatureId"] = bool(show_feature_id)
    if max_width is not None:
        config["maxWidth"] = _popup_pixel_size("max_width", max_width, POPUP_MAX_WIDTH_RANGE)
    if image_height is not None:
        config["imageHeight"] = _popup_pixel_size(
            "image_height", image_height, POPUP_IMAGE_HEIGHT_RANGE
        )
    if fields is not None:
        if isinstance(fields, (str, dict)):
            entries = [fields]
        else:
            try:
                entries = list(fields)
            except TypeError:
                # Reached by `popup=1` and friends. Say what a popup accepts
                # rather than letting "'int' object is not iterable" out.
                raise ValueError(
                    "popup fields must be a property name, a mapping, or a sequence of "
                    f"them; got {type(fields).__name__}"
                ) from None
        config["fields"] = [_coerce_popup_field(entry) for entry in entries]
    return config


def _assert_tooltip_can_render(config: dict[str, Any]) -> None:
    """Reject a hover tooltip that is switched on but could never show anything.

    ``createHoverTooltipElement`` draws the fields flagged ``hover`` under a
    configured title, and returns nothing when it has neither -- so a config
    with ``hover`` and no such field is a tooltip that silently never appears.
    Checked on the finished config rather than at each entry point, because
    ``hover`` can arrive through ``tooltip=``, through the ``hover=`` argument,
    or from a merge with what the layer already carried.

    Args:
        config: The finished popup config.

    Raises:
        ValueError: If ``hover`` is on with no hover field and no title.
    """
    if config.get("hover") is not True:
        return
    if config.get("titleField") or config.get("titleExpression"):
        return
    fields = [entry for entry in (config.get("fields") or []) if isinstance(entry, dict)]
    hovered = [entry for entry in fields if entry.get("hover") is True]
    # An image row is dropped from the hover subset by resolvePopupRows (its
    # value is a URL, which would print as the tip's whole body), so flagging
    # only image fields leaves the same empty tip as flagging none.
    if any(entry.get("kind") != "image" for entry in hovered):
        return
    if hovered:
        raise ValueError(
            "the hover tooltip is on but only image fields are flagged for it, and an "
            "image never renders in a tooltip; flag a text field too, or set a popup title"
        )
    raise ValueError(
        "the hover tooltip is on but nothing would render in it: name the fields to "
        "show (tooltip=['name']), set a popup title, or turn it off (tooltip=False)"
    )


def apply_tooltip(config: dict[str, Any], tooltip: Any) -> dict[str, Any]:
    """Fold a ``tooltip=`` shorthand into a popup config, in place.

    The app's hover tooltip needs two things: ``hover`` on the config, and at
    least one field flagged ``hover`` (or a configured title) to put in it --
    ``createHoverTooltipElement`` returns nothing otherwise. This raises the
    field flags, then checks the finished config through
    :func:`_assert_tooltip_can_render` so a tooltip that could never appear is
    an error however ``hover`` was switched on.

    Args:
        config: The popup config being built (mutated in place).
        tooltip: ``True``/``False`` to flag every configured field or turn the
            tooltip off, or a property name or sequence of names to flag. An
            empty sequence means the same as ``False``. Note that naming a
            field here adds it to ``fields``, and a non-empty ``fields`` is
            also what the *click* popup shows -- so a tooltip field on a popup
            that had no field list narrows the click popup to it.

    Returns:
        The same ``config``.

    Raises:
        ValueError: If a tooltip field name is blank, or the finished config
            leaves the tooltip on with nothing to show.
    """
    if tooltip is False:
        config["hover"] = False
        return config

    if tooltip is not None:
        fields: list[dict[str, Any]] = list(config.get("fields") or [])
        if tooltip is not True:
            if isinstance(tooltip, str):
                names = [tooltip]
            else:
                try:
                    names = list(tooltip)
                except TypeError:
                    # Same guard as popup_config's `fields`, for the same
                    # reason: `tooltip=1` is a public-API typo and deserves a
                    # sentence, not "'int' object is not iterable".
                    raise ValueError(
                        "tooltip must be True/False, a property name, or a sequence of "
                        f"names; got {type(tooltip).__name__}"
                    ) from None
            if not names:
                # An empty selection is "no tooltip", which is what the MCP
                # tool's `tooltip=[]` means too.
                config["hover"] = False
                return config
            for name in names:
                key = str(name).strip()
                if not key:
                    raise ValueError("tooltip field name must be a non-empty string")
                existing = next((entry for entry in fields if entry.get("field") == key), None)
                if existing is None:
                    # A tooltip-only field still has to appear in `fields`: the
                    # hover subset is drawn from that list, not from the feature.
                    fields.append(popup_field(key, hover=True))
                else:
                    existing["hover"] = True
        else:
            for entry in fields:
                entry["hover"] = True

        config["hover"] = True
        if fields:
            config["fields"] = fields

    _assert_tooltip_can_render(config)
    return config


def normalize_popup(
    popup: Any = None,
    tooltip: Any = None,
    *,
    max_width: Any = None,
    image_height: Any = None,
) -> dict[str, Any] | None:
    """Coerce the ``popup=``/``tooltip=`` arguments to a ``LayerPopupConfig``.

    ``popup`` accepts, in rising order of control: ``True``/``False`` to turn
    the click popup on or off, a property name, a sequence of property names
    and/or :func:`popup_field` mappings, or a full config mapping whose keys
    are the arguments of :func:`popup_config` (``fields``, ``click``,
    ``hover``, ``title``, ``title_expression``, ``body_expression``,
    ``show_feature_id``, ``max_width``, ``image_height``, ``tooltip``) in
    either snake_case or camelCase.

    Args:
        popup: The popup specification, or ``None`` for no popup config.
        tooltip: Hover-tooltip shorthand; see :func:`apply_tooltip`. Wins over
            a ``tooltip`` key inside ``popup``.
        max_width: ``popup_max_width=`` shorthand, in CSS pixels. Wins over a
            ``max_width`` key inside ``popup``, and configures a popup on its
            own -- ``popup_max_width=480`` alone still widens the default
            popup, which is the point of the shorthand.
        image_height: ``popup_image_height=`` shorthand, in CSS pixels; the
            same precedence as ``max_width``.

    Returns:
        A ``LayerPopupConfig`` dict, or ``None`` when neither argument
        configured anything.

    Raises:
        ValueError: If the specification carries an unknown key or an
            unusable field entry.
    """
    if popup is None and tooltip is None and max_width is None and image_height is None:
        return None

    inline_tooltip: Any = None
    if popup is None or popup is True:
        config = popup_config()
    elif popup is False:
        config = popup_config(click=False)
    elif isinstance(popup, str):
        config = popup_config(popup)
    elif isinstance(popup, dict):
        kwargs: dict[str, Any] = {}
        for key, value in popup.items():
            mapped = _POPUP_CONFIG_KEYS.get(_normalize_key(key))
            if mapped is None:
                raise ValueError(
                    f"unknown popup key {key!r}; expected one of {_POPUP_CONFIG_ARGUMENTS}"
                )
            if mapped == "tooltip":
                inline_tooltip = value
            elif mapped == "titleField":
                kwargs["title"] = value
            elif mapped == "titleExpression":
                kwargs["title_expression"] = value
            elif mapped == "bodyExpression":
                kwargs["body_expression"] = value
            elif mapped == "showFeatureId":
                kwargs["show_feature_id"] = value
            elif mapped == "maxWidth":
                kwargs["max_width"] = value
            elif mapped == "imageHeight":
                kwargs["image_height"] = value
            else:
                kwargs[mapped] = value
        # Drop the mapping's copy of a size the dedicated argument also carries,
        # rather than validating a value that is about to be overwritten -- the
        # same thing `inline_tooltip` gets when `tooltip=` was passed. Left in,
        # an out-of-range mapping value would raise even though the argument
        # that wins is perfectly valid.
        if max_width is not None:
            kwargs.pop("max_width", None)
        if image_height is not None:
            kwargs.pop("image_height", None)
        config = popup_config(**kwargs)
    else:
        config = popup_config(popup)

    # After the mapping form, so the dedicated argument wins over the key of
    # the same name inside `popup=` -- the same precedence `tooltip` has.
    if max_width is not None:
        config["maxWidth"] = _popup_pixel_size("max_width", max_width, POPUP_MAX_WIDTH_RANGE)
    if image_height is not None:
        config["imageHeight"] = _popup_pixel_size(
            "image_height", image_height, POPUP_IMAGE_HEIGHT_RANGE
        )

    return apply_tooltip(config, tooltip if tooltip is not None else inline_tooltip)


def marker_style(
    *,
    color: str | None = None,
    opacity: float | None = None,
    radius: float | None = None,
    stroke_color: str | None = None,
    stroke_width: float | None = None,
    shape: str | None = None,
    size: float | None = None,
    icon: str | None = None,
) -> dict[str, Any]:
    """Translate friendly marker arguments into layer style keys.

    A point layer draws one of two ways. By default it is a MapLibre circle
    sized by ``radius`` and filled with ``color``. Passing ``shape``, ``size``
    or ``icon`` switches it to a baked marker sprite instead, sized by ``size``
    and colored by ``color``; ``radius`` no longer applies to it.

    Args:
        color: Marker color. Applied to both the circle fill and the sprite, so
            it takes effect either way.
        opacity: Circle fill opacity in ``[0, 1]``.
        radius: Circle radius in pixels (circle rendering only).
        stroke_color: Outline color.
        stroke_width: Outline width in pixels.
        shape: One of :data:`MARKER_SHAPES`. Switches to sprite rendering.
        size: Sprite size in pixels. Switches to sprite rendering.
        icon: Raw SVG markup (or a data URL) for a ``"custom"`` sprite.
            Switches to sprite rendering and implies ``shape="custom"``.

    Returns:
        A dict of camelCase layer style keys, empty when nothing was passed.

    Raises:
        ValueError: If ``shape`` is not a known shape, a numeric argument is
            out of range, ``shape="custom"`` is asked for without ``icon``, or
            sprite rendering is requested with a non-hex ``color``.
    """
    style: dict[str, Any] = {}
    if shape is not None and shape not in MARKER_SHAPES:
        raise ValueError(f"shape must be one of {sorted(MARKER_SHAPES)}, got {shape!r}")
    if icon is not None and not str(icon).strip():
        raise ValueError("icon must be non-empty SVG markup or a data URL")
    if shape == "custom" and icon is None:
        raise ValueError('shape="custom" needs icon= with the SVG markup to draw')
    if icon is not None and shape not in (None, "custom"):
        # The app reads markerSvg only for markerShape "custom", so an icon can
        # only render as a custom sprite. Honoring the icon would silently
        # discard the shape the caller asked for; say so instead.
        raise ValueError(f'icon= implies shape="custom", but shape={shape!r} was given too')

    # Any of these three means "render a marker sprite, not a plain circle".
    sprite = shape is not None or size is not None or icon is not None

    if sprite:
        # A sprite layer replaces the circle layer outright (layer-sync removes
        # it), and the sprite's own outline is a fixed white halo drawn by
        # drawBuiltinMarker. So the circle-only settings are not merely
        # overridden here, they are unreachable -- writing them would leave the
        # caller looking at a marker that ignored what they asked for.
        inert = {
            "opacity": opacity,
            "radius": radius,
            "stroke_color": stroke_color,
            "stroke_width": stroke_width,
        }
        given = sorted(name for name, value in inert.items() if value is not None)
        if given:
            applies = "applies" if len(given) == 1 else "apply"
            raise ValueError(
                f"{', '.join(given)} only {applies} to circle markers, but shape/size/icon "
                "selected a marker sprite; use size= for the sprite's size and drop the rest"
            )

    if color is not None:
        style["fillColor"] = str(color)
        if sprite:
            # The sprite baker runs markerColor through normalizeHexColor and
            # falls back to blue on anything it rejects, so a CSS color name
            # would silently draw the wrong marker. Fail loudly instead.
            hex_color = normalize_hex_color(str(color))
            if hex_color is None:
                raise ValueError(
                    f"marker sprites need a hex color such as '#e11d48'; got {color!r}"
                )
            style["markerColor"] = hex_color
        else:
            # Only mirror onto markerColor when the app could actually use it:
            # the sprite baker takes hex only, and writing "red" there would
            # leave a value that draws the default blue the moment someone
            # switches this layer to a marker shape in the UI.
            hex_color = normalize_hex_color(str(color))
            if hex_color is not None:
                style["markerColor"] = hex_color
    if opacity is not None:
        value = float(opacity)
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError(f"opacity must be between 0 and 1, got {opacity!r}")
        style["fillOpacity"] = value
    if radius is not None:
        value = float(radius)
        if not math.isfinite(value) or value <= 0:
            raise ValueError("radius must be a finite number greater than zero")
        style["circleRadius"] = value
    if stroke_color is not None:
        style["strokeColor"] = str(stroke_color)
    if stroke_width is not None:
        value = float(stroke_width)
        if not math.isfinite(value) or value < 0:
            raise ValueError("stroke_width must be a finite non-negative number")
        style["strokeWidth"] = value
    if size is not None:
        value = float(size)
        if not math.isfinite(value) or value <= 0:
            raise ValueError("size must be a finite number greater than zero")
        style["markerSize"] = value
    if icon is not None:
        style["markerSvg"] = str(icon)
    if sprite:
        style["markerEnabled"] = True
        style["markerShape"] = "custom" if icon is not None else (shape or "circle")
    return style


def _layer_base(name: str, layer_type: str, **style: Any) -> dict[str, Any]:
    # `popup`, `tooltip` and the `popup_*` size shorthands ride in with the
    # style overrides so every add_* builder accepts them without threading
    # four more arguments through each signature, but the popup config is a
    # top-level layer key -- left in `style` they would land somewhere the app
    # never reads.
    popup = normalize_popup(
        style.pop("popup", None),
        style.pop("tooltip", None),
        max_width=style.pop("popup_max_width", None),
        image_height=style.pop("popup_image_height", None),
    )
    # Deep-copy the defaults so nested values (e.g. the vectorStyleStops list)
    # are not shared with the module constant; a caller mutating a returned
    # layer's style must not corrupt DEFAULT_LAYER_STYLE for later layers.
    merged_style = {**copy.deepcopy(DEFAULT_LAYER_STYLE), **style}
    layer: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "name": name,
        "type": layer_type,
        "visible": True,
        "opacity": 1,
        "style": merged_style,
        "metadata": {},
    }
    if popup is not None:
        layer["popup"] = popup
    return layer


def geojson_layer(
    name: str,
    data: dict[str, Any],
    *,
    source_url: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a GeoJSON layer with an inlined FeatureCollection.

    Args:
        name: Layer display name.
        data: A GeoJSON FeatureCollection dict.
        source_url: Optional URL the data originated from (recorded on the
            source for restore/refresh).
        **style: Style overrides merged into the default layer style
            (e.g. ``fillColor="#ff0000"``).

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "geojson", **style)
    source: dict[str, Any] = {"type": "geojson"}
    if source_url:
        source["url"] = source_url
        layer["sourcePath"] = source_url
    layer["source"] = source
    layer["geojson"] = data
    return layer


def tile_layer(
    name: str,
    url: str,
    *,
    tile_size: int = 256,
    attribution: str | None = None,
    bounds: list[float] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a raster XYZ tile layer (e.g. an ``{z}/{x}/{y}`` template).

    Args:
        name: Layer display name.
        url: The XYZ tile URL template.
        tile_size: Tile size in pixels (typically 256).
        attribution: Optional attribution string.
        bounds: Optional ``[west, south, east, north]`` request bounds.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "xyz", **style)
    source: dict[str, Any] = {
        "type": "raster",
        "tiles": [url],
        "tileSize": tile_size,
        "url": url,
    }
    if attribution:
        source["attribution"] = attribution
    if bounds:
        source["bounds"] = bounds
    layer["source"] = source
    layer["metadata"] = {"sourceKind": "xyz-url"}
    return layer


def cog_layer(
    name: str,
    url: str,
    *,
    bands: list[int] | None = None,
    colormap: str | None = None,
    rescale: list[list[float]] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a Cloud Optimized GeoTIFF (COG) layer.

    The shape matches what ``restoreRasterLayers`` replays from a saved project
    (see packages/plugins/src/plugins/raster-layer-sync.ts), so the app rebuilds
    the deck.gl raster overlay on load.

    Args:
        name: Layer display name.
        url: URL of the COG / GeoTIFF.
        bands: Optional 1-based band indices to render (e.g. ``[1, 2, 3]``).
        colormap: Optional colormap name for single-band rendering.
        rescale: Optional list of ``[min, max]`` ranges, one per rendered band.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "cog", **style)
    raster_state: dict[str, Any] = {}
    if rescale is not None:
        raster_state["rescale"] = rescale
    if bands is not None:
        raster_state["bands"] = bands
        raster_state["mode"] = "rgb" if len(bands) >= 3 else "single"
    if colormap is not None:
        raster_state["colormap"] = colormap
    layer["source"] = {"type": "raster", "url": url}
    layer["metadata"] = {
        "customLayerType": "raster",
        "externalDeckLayer": True,
        "externalNativeLayer": True,
        "identifiable": False,
        "nativeLayerIds": [layer["id"]],
        "panelCollapsed": True,
        "rasterOverlayMode": "interleaved",
        "rasterSource": "url",
        "rasterState": raster_state,
        "sourceIds": [],
        "sourceKind": "maplibre-gl-raster",
    }
    layer["sourcePath"] = url
    return layer


def _append_query(endpoint: str, params: list[tuple[str, str]]) -> str:
    """Append query params to a URL, mirroring ``appendQuery`` in the app.

    Matches ``AddDataDialog.tsx``/``layer-refresh.ts``: an existing ``?`` or
    ``&`` is respected, values are URL-encoded the way ``encodeURIComponent``
    does (so ``!*'()`` and the unreserved ``-_.~`` stay literal), and the
    ``{bbox-epsg-3857}`` placeholder is preserved verbatim so the raster source
    can substitute the tile bounding box at request time.

    Args:
        endpoint: Base service URL (may already carry a query string).
        params: Ordered ``(key, value)`` pairs to append.

    Returns:
        The endpoint with the encoded query string appended.
    """
    # Split off any fragment first: a query string must precede the "#", so
    # appending after it would push the params past the fragment where the
    # server never sees them. (Service endpoints rarely carry one, but this is
    # cheap to handle correctly.)
    base, sep, fragment = endpoint.partition("#")
    if "?" in base:
        separator = "" if base.endswith(("?", "&")) else "&"
    else:
        separator = "?"
    query = "&".join(
        f"{quote(key, safe=_ENCODE_URI_SAFE)}="
        + (value if value == "{bbox-epsg-3857}" else quote(value, safe=_ENCODE_URI_SAFE))
        for key, value in params
    )
    return f"{base}{separator}{query}{sep}{fragment}"


#: The GetMap parameters `wms_layer` writes itself, lower-cased.
_WMS_GETMAP_KEYS = frozenset(
    {
        "service",
        "request",
        "version",
        "layers",
        "styles",
        "format",
        "transparent",
        "srs",
        "crs",
        "bbox",
        "width",
        "height",
    }
)


def _drop_query_keys(endpoint: str, keys: frozenset[str]) -> str:
    """Remove query parameters named in ``keys`` (case-insensitive) from a URL.

    The other parameters are kept byte for byte, in order, so a vendor option
    such as ``map=...`` reaches the server exactly as the caller wrote it.

    Args:
        endpoint: A URL that may carry a query string.
        keys: Lower-case parameter names to drop.

    Returns:
        The endpoint without those parameters.
    """
    base, sep, fragment = endpoint.partition("#")
    path, qmark, query = base.partition("?")
    if not qmark:
        return endpoint
    # Names are compared decoded, as a server or `URLSearchParams` reads them,
    # so `%73RS=` counts as `SRS=`; kept parameters stay as written.
    kept = [
        part for part in query.split("&") if unquote_plus(part.split("=", 1)[0]).lower() not in keys
    ]
    return f"{path}?{'&'.join(kept)}{sep}{fragment}"


def _resolve_bounds(bounds: list[float] | None) -> list[float] | None:
    """Validate optional layer bounds and coerce them to floats.

    A service layer has no geometry of its own, so these are the only extent
    the app can zoom to; a malformed list would reach the project file as one
    it cannot use.

    Args:
        bounds: ``[west, south, east, north]`` in WGS84, or None.

    Returns:
        The four coordinates as floats, or None when *bounds* is None.

    Raises:
        ValueError: If *bounds* does not hold four finite numbers, or its
            latitudes are inverted or outside +/-90. West > east is allowed:
            that is how RFC 7946 writes an antimeridian-crossing box.
    """
    if bounds is None:
        return None
    # Convert before measuring: len() on an iterable that is not sized raises a
    # bare TypeError, and the MCP tool wrapper only restates ValueError, so the
    # agent would see "Error executing tool" with no sentence to correct.
    try:
        values = [float(v) for v in bounds]
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"bounds must be four numbers; got {bounds!r}") from exc
    if len(values) != 4:
        raise ValueError(
            "bounds must be a [west, south, east, north] sequence with exactly 4 elements"
        )
    if not all(math.isfinite(value) for value in values):
        raise ValueError(f"bounds must contain finite numbers; got {bounds!r}")
    _, south, _, north = values
    if south > north:
        raise ValueError(f"bounds has its latitudes inverted; got {bounds!r}")
    if not (-90 <= south and north <= 90):
        raise ValueError(f"bounds latitudes must lie within +/-90; got {bounds!r}")
    # Longitudes are deliberately not ordered. RFC 7946 section 5.2 writes a box
    # crossing the antimeridian with west > east - Fiji is [170, -20, -170, -10] -
    # and authoring.fit_bounds already frames such a box rather than refusing it.
    return values


def _normalize_wms_version(version: str | None) -> str:
    """Normalize a WMS version to the "1.1.1"/"1.3.0" pair the builder emits.

    Args:
        version: The requested WMS protocol version, or None.

    Returns:
        ``"1.3.0"`` for any version in the 1.3 line, ``"1.1.1"`` otherwise
        (including None or a non-string value).
    """
    if not isinstance(version, str):
        return "1.1.1"
    return "1.3.0" if version.strip().startswith("1.3") else "1.1.1"


#: Web Mercator and the geographic CRSs a WMS layer can be requested in.
#: MapLibre tiles are Web Mercator; the geographic ones are for servers without
#: EPSG:3857, which the desktop app requests per tile in that CRS and redraws
#: into Web Mercator strip by strip. Keep in step with `GEOGRAPHIC_WMS_CRS` in
#: `apps/geolibre-desktop/src/lib/wms-geographic.ts`: a geographic CRS accepted
#: here but missing there takes the projected path, and
#: `tests/wms-geographic.test.ts` fails when the two drift. Any other
#: ``EPSG:<code>`` is accepted too, projected or geographic, and warped by the
#: desktop app (see `_normalize_wms_crs`).
WMS_CRS = frozenset({"EPSG:3857", "EPSG:4326", "EPSG:4258", "EPSG:6706", "CRS:84"})

_EPSG_CODE = re.compile(r"EPSG:\d{4,6}")


def _normalize_wms_crs(crs: str | None) -> str:
    """Normalize the CRS a WMS layer requests its tiles in.

    Args:
        crs: The requested CRS code, or None for Web Mercator.

    Returns:
        The upper-cased code, ``"EPSG:3857"`` for None.

    Raises:
        ValueError: If ``crs`` is neither one of :data:`WMS_CRS` nor an
            ``EPSG:<code>``.
    """
    if crs is None:
        return "EPSG:3857"
    code = str(crs).strip().upper()
    # Any other EPSG CRS (UTM, a national grid, another geographic datum) is
    # resolved by the desktop app from its EPSG tables; a code it does not know
    # is sent to the server as is.
    if code not in WMS_CRS and not _EPSG_CODE.fullmatch(code):
        raise ValueError(
            f"crs must be one of {sorted(WMS_CRS)} or an EPSG code such as 'EPSG:25832', "
            f"got {crs!r}"
        )
    return code


def wms_layer(
    name: str,
    endpoint: str,
    layers: str,
    *,
    styles: str = "",
    image_format: str = "image/png",
    transparent: bool = True,
    tile_size: int = 256,
    version: str | None = "1.1.1",
    crs: str | None = None,
    bounds: list[float] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a WMS layer rendered as tiled raster (a WMS GetMap request).

    The GetMap tile template is built exactly as ``createWmsTileUrl`` in the Add
    Data dialog, so the core raster sync renders it identically to a layer added
    through the UI. The ``{bbox-epsg-3857}`` placeholder is substituted per tile.

    Args:
        name: Layer display name.
        endpoint: WMS service endpoint (the GetMap base URL).
        layers: Comma-separated WMS layer name(s).
        styles: Comma-separated WMS style name(s) (empty for the default).
        image_format: WMS image format (e.g. ``"image/png"``).
        transparent: Whether to request transparent tiles.
        tile_size: Tile size in pixels.
        version: WMS protocol version, ``"1.1.1"`` (default) or ``"1.3.0"``.
            Version 1.3.0 sends ``CRS`` instead of ``SRS``; some servers accept
            only one version. EPSG:3857 keeps its axis order in both, so the
            BBOX template is unchanged. None falls back to ``"1.1.1"``.
        crs: The CRS tiles are requested in: ``"EPSG:3857"`` (None, the
            default) or, for a server that does not offer Web Mercator, a CRS
            it does list in its capabilities: a geographic one
            (``"EPSG:4326"``, ``"EPSG:4258"``, ``"EPSG:6706"``, ``"CRS:84"``)
            or a projected ``"EPSG:<code>"`` such as ``"EPSG:25832"``. The
            desktop app requests each tile's extent in that CRS and redraws
            or warps it into Web Mercator; the web build still sends the Web
            Mercator BBOX, which such a server rejects.
        bounds: Optional ``[west, south, east, north]`` request bounds, in
            WGS84. Take them from the service's ``EX_GeographicBoundingBox``,
            which is always lon/lat, rather than a 1.3.0 ``BoundingBox
            CRS="EPSG:4326"``, whose axis order servers often get wrong.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``bounds`` is not four finite numbers with valid latitudes,
            ``crs`` is neither one of :data:`WMS_CRS` nor an ``EPSG:<code>``,
            or ``crs`` is ``"CRS:84"`` with a version other than 1.3.0.
    """
    wms_version = _normalize_wms_version(version)
    wms_crs = _normalize_wms_crs(crs)
    if wms_crs == "CRS:84" and wms_version != "1.3.0":
        # CRS:84 is defined by WMS 1.3.0; a 1.1.1 server rejects it as an SRS.
        raise ValueError("crs='CRS:84' needs version='1.3.0'; use EPSG:4326 with WMS 1.1.1")
    # An endpoint copied from a capabilities OnlineResource or a GetMap URL
    # may already carry VERSION, CRS or BBOX. A duplicate would leave the
    # server and the desktop tile protocol (which reads the first VERSION to
    # pick the axis order) disagreeing, so every key written here replaces
    # the endpoint's own; vendor parameters such as `map=` are kept.
    tile_url = _append_query(
        _drop_query_keys(endpoint, _WMS_GETMAP_KEYS),
        [
            ("SERVICE", "WMS"),
            ("REQUEST", "GetMap"),
            ("VERSION", wms_version),
            ("LAYERS", layers),
            ("STYLES", styles),
            ("FORMAT", image_format),
            ("TRANSPARENT", "TRUE" if transparent else "FALSE"),
            ("CRS" if wms_version == "1.3.0" else "SRS", wms_crs),
            ("BBOX", "{bbox-epsg-3857}"),
            ("WIDTH", str(tile_size)),
            ("HEIGHT", str(tile_size)),
        ],
    )
    layer = _layer_base(name, "wms", **style)
    source: dict[str, Any] = {
        "type": "raster",
        "tiles": [tile_url],
        "tileSize": tile_size,
        "url": endpoint,
        "layers": layers,
        "styles": styles,
        "format": image_format,
        "transparent": transparent,
        "version": wms_version,
    }
    resolved_bounds = _resolve_bounds(bounds)
    if resolved_bounds is not None:
        source["bounds"] = resolved_bounds
    layer["source"] = source
    layer["metadata"] = {"service": "wms"}
    return layer


def wmts_layer(
    name: str,
    url: str,
    *,
    tile_size: int = 256,
    bounds: list[float] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a WMTS layer from a tile URL template.

    Args:
        name: Layer display name.
        url: A WMTS tile URL template in WMTS REST ``{z}/{y}/{x}`` order (row
            before column — unlike XYZ templates in ``tile_layer``/``add_tile_layer``,
            which use ``{z}/{x}/{y}``).
        tile_size: Tile size in pixels.
        bounds: Optional ``[west, south, east, north]`` request bounds, in
            WGS84. WMTS capabilities carry it as ``ows:WGS84BoundingBox``
            (``EX_GeographicBoundingBox`` is a WMS element and is absent here).
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``bounds`` is not four finite numbers with valid latitudes.
    """
    layer = _layer_base(name, "wmts", **style)
    source: dict[str, Any] = {
        "type": "raster",
        "tiles": [url],
        "tileSize": tile_size,
        "url": url,
    }
    resolved_bounds = _resolve_bounds(bounds)
    if resolved_bounds is not None:
        source["bounds"] = resolved_bounds
    layer["source"] = source
    layer["metadata"] = {"service": "wmts"}
    return layer


def wfs_getfeature_url(
    endpoint: str,
    type_name: str,
    *,
    version: str = "2.0.0",
    output_format: str = "application/json",
    srs_name: str = "EPSG:4326",
    max_features: int | None = None,
) -> str:
    """Build a WFS GetFeature URL, mirroring ``createWfsGetFeatureUrl``.

    WFS 2.x uses ``typeNames``/``count`` while WFS 1.x uses
    ``typeName``/``maxFeatures``. The endpoint is expected to return GeoJSON when
    ``output_format`` is ``application/json`` so the result can be inlined as a
    GeoJSON layer.

    Args:
        endpoint: WFS service endpoint.
        type_name: WFS feature type name (e.g. ``"topp:states"``).
        version: WFS protocol version (e.g. ``"2.0.0"`` or ``"1.1.0"``).
        output_format: Requested output format.
        srs_name: Spatial reference of the response.
        max_features: Optional cap on the number of returned features.

    Returns:
        The fully-formed GetFeature request URL.
    """
    is_wfs2 = version.startswith("2")
    params: list[tuple[str, str]] = [
        ("service", "WFS"),
        ("request", "GetFeature"),
        ("version", version),
        ("typeNames" if is_wfs2 else "typeName", type_name),
        ("outputFormat", output_format),
    ]
    if srs_name:
        params.append(("srsName", srs_name))
    if max_features is not None:
        params.append(("count" if is_wfs2 else "maxFeatures", str(max_features)))
    return _append_query(endpoint, params)


def vector_layer(
    name: str,
    url: str,
    *,
    render_mode: str = "geojson",
    data_format: str | None = None,
    source_layer: str | None = None,
    picker: bool | None = None,
    ingest_mode: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a vector layer backed by the maplibre-gl-vector control.

    Covers any GDAL-readable vector served from a URL (GeoParquet, FlatGeobuf,
    zipped Shapefile, GeoJSON, ...). The shape matches what ``restoreVectorLayers``
    replays from a saved project: it reads ``source.url`` and the persisted
    ``metadata.vectorState`` and re-runs ``VectorControl.addData`` on load, so the
    in-browser DuckDB-backed control fetches and renders the data.

    Args:
        name: Layer display name.
        url: URL of the vector dataset.
        render_mode: ``"geojson"`` (load into a GeoJSON source) or ``"tiles"``
            (stream as vector tiles).
        data_format: Optional GDAL format hint (e.g. ``"parquet"``,
            ``"flatgeobuf"``); the control auto-detects when omitted.
        source_layer: Optional source/container layer name for multi-layer files.
        picker: Optional toggle for the control's feature-inspection popup.
        ingest_mode: Optional ingest strategy, ``"table"`` or ``"stream"``.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``render_mode`` or ``ingest_mode`` is not a valid value.
    """
    if render_mode not in ("geojson", "tiles"):
        raise ValueError("render_mode must be 'geojson' or 'tiles'")
    if ingest_mode is not None and ingest_mode not in ("table", "stream"):
        raise ValueError("ingest_mode must be 'table' or 'stream'")
    is_tiles = render_mode == "tiles"
    layer = _layer_base(name, "vector-tiles" if is_tiles else "geojson", **style)
    layer["source"] = {"type": "vector" if is_tiles else "geojson", "url": url}
    vector_state: dict[str, Any] = {"renderMode": render_mode}
    if data_format:
        vector_state["format"] = data_format
    if source_layer:
        vector_state["sourceLayer"] = source_layer
    if picker is not None:
        vector_state["picker"] = picker
    if ingest_mode is not None:
        vector_state["ingestMode"] = ingest_mode
    layer["metadata"] = {
        "sourceKind": "maplibre-gl-vector",
        "externalNativeLayer": True,
        # The control owns its layers' paint; the core sync must not re-apply it.
        "controlOwnsPaint": True,
        "identifiable": False,
        # Empty is safe here (unlike pmtiles_layer): restoreVectorLayers detects
        # the layer via isVectorControlStoreLayer (sourceKind + externalNativeLayer,
        # not list length) and loads it through the control's async addData;
        # syncVectorLayersToStore then fills in the real nativeLayerIds.
        # Caveat: render_mode="tiles" yields a type:"vector-tiles" layer that,
        # before the control loads, briefly falls through to syncVectorTileLayer
        # until that store sync replaces these ids.
        "nativeLayerIds": [],
        "sourceIds": [f"{layer['id']}-source"],
        "vectorSource": "url",
        "vectorState": vector_state,
    }
    layer["sourcePath"] = url
    return layer


def vector_tiles_layer(
    name: str,
    url: str,
    *,
    source_layers: list[str] | None = None,
    source_layer: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a vector tile layer from a TileJSON endpoint.

    Rendered directly by the core layer sync (no control), which reads
    ``source.url`` as a TileJSON URL and styles each named source layer.

    Args:
        name: Layer display name.
        url: TileJSON endpoint for the vector tileset.
        source_layers: Source-layer names to render (for multi-layer tilesets).
        source_layer: A single source-layer name (convenience for the common
            single-layer case).
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "vector-tiles", **style)
    source: dict[str, Any] = {"type": "vector", "url": url}
    if source_layers:
        if source_layer is not None:
            warnings.warn(
                "source_layer is ignored when source_layers is provided; pass one or the other.",
                stacklevel=2,
            )
        source["sourceLayers"] = list(source_layers)
    elif source_layer:
        source["sourceLayer"] = source_layer
    layer["source"] = source
    return layer


def pmtiles_layer(
    name: str,
    url: str,
    *,
    tile_type: str = "vector",
    source_layers: list[str] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a PMTiles layer from a ``.pmtiles`` URL.

    The core sync registers the ``pmtiles://`` protocol and prepends it to the
    URL automatically, so a plain ``https://`` URL is accepted here.

    Args:
        name: Layer display name.
        url: URL of the ``.pmtiles`` archive.
        tile_type: ``"vector"`` or ``"raster"``.
        source_layers: Vector source-layer names to render (vector tiles only).
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``tile_type`` is not ``"vector"`` or ``"raster"``.
    """
    if tile_type not in ("vector", "raster"):
        raise ValueError("tile_type must be 'vector' or 'raster'")
    source_layers = list(source_layers or [])
    layer = _layer_base(name, "pmtiles", **style)
    source_id = layer["id"]
    layer["source"] = {
        "type": "raster" if tile_type == "raster" else "vector",
        "url": url,
        "sourceId": source_id,
        "sourceLayers": source_layers,
        "tileType": tile_type,
    }
    # nativeLayerIds must be non-empty: isExternalNativeLayer() in layer-sync.ts
    # gates on its length, and a "pmtiles" layer has no fallback dispatch in
    # syncLayer, so an empty list means the source/layers are never added.
    # ensurePMTilesExternalLayer tolerates these placeholders — for raster it
    # matches the `${sourceId}-raster` fallback it would otherwise compute; for
    # vector getPMTilesNativeLayerId derives the real per-source-layer ids.
    native_layer_ids = [f"{source_id}-raster"] if tile_type == "raster" else [source_id]
    layer["metadata"] = {
        "sourceKind": "pmtiles-url",
        "externalNativeLayer": True,
        "sourceId": source_id,
        "tileType": tile_type,
        "sourceLayers": source_layers,
        "nativeLayerIds": native_layer_ids,
    }
    layer["sourcePath"] = url
    return layer


def three_d_tiles_layer(
    name: str,
    url: str | None = None,
    *,
    ion_asset_id: int | None = None,
    altitude_offset: float = 0,
    request_headers: dict[str, str] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a 3D Tiles layer from a ``tileset.json`` URL or a Cesium Ion asset.

    A URL layer matches what ``restoreThreeDTilesLayers`` replays from a saved
    project, so the deck.gl 3D-tiles overlay is rebuilt on load. An Ion asset
    (``ion_asset_id``) renders only on the 3D globe, which loads it with the
    app's Cesium Ion token; the token itself is never written to the project.

    Args:
        name: Layer display name.
        url: URL of the 3D Tiles ``tileset.json``. Omit for an Ion asset.
        ion_asset_id: A Cesium Ion asset id (for example 96188, Cesium OSM
            Buildings). Mutually exclusive with ``url``.
        altitude_offset: Vertical offset applied to the tileset, in meters.
        request_headers: Optional request headers (e.g. an auth token). Stored in
            the project file, so avoid persisting secrets you do not want saved.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If neither or both of ``url`` and ``ion_asset_id`` are given,
            the asset id is not a positive integer, or ``request_headers`` are
            combined with an Ion asset (Ion requests carry the token instead).
    """
    if (url is None) == (ion_asset_id is None):
        raise ValueError("pass exactly one of url or ion_asset_id")
    if ion_asset_id is not None:
        if request_headers:
            raise ValueError("request_headers do not apply to a Cesium Ion asset")
        return cesium_ion_layer(
            name, ion_asset_id, kind="3d-tiles", altitude_offset=altitude_offset, **style
        )
    layer = _layer_base(name, "3d-tiles", **style)
    source_id = layer["id"]
    source: dict[str, Any] = {
        "type": "3d-tiles",
        "url": url,
        "sourceId": source_id,
        "altitudeOffset": altitude_offset,
    }
    if request_headers:
        source["requestHeaders"] = request_headers
    layer["source"] = source
    layer["metadata"] = {
        "sourceKind": "3d-tiles-url",
        "externalNativeLayer": True,
        "customLayerType": "3d-tiles",
        "identifiable": False,
        "sourceId": source_id,
        "nativeLayerIds": [source_id],
        "altitudeOffset": altitude_offset,
        "panelCollapsed": True,
        "status": "loading",
    }
    layer["sourcePath"] = url
    return layer


LIDAR_SOURCE_KIND = "lidar-url"
"""``metadata.sourceKind`` of a LiDAR point cloud the app streams from a URL."""


def lidar_layer(name: str, url: str, **style: Any) -> dict[str, Any]:
    """Build a LiDAR point cloud layer from a LAS, LAZ, COPC or EPT URL.

    The layer matches what the app's LiDAR control writes, so a saved project
    re-streams the point cloud when it opens (COPC and EPT by level of detail,
    LAS/LAZ as a whole download).

    Args:
        name: Layer display name.
        url: HTTP(S) URL of a ``.las``, ``.laz``, ``.copc.laz`` file or an EPT
            ``ept.json``.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``url`` is not an HTTP(S) URL.
    """
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        raise ValueError("url must be an http(s) URL of a LAS/LAZ/COPC file or an EPT ept.json")
    layer = _layer_base(name, "lidar", **style)
    source_id = layer["id"]
    layer["source"] = {"type": "lidar", "url": url, "sourceId": source_id}
    layer["metadata"] = {
        "sourceKind": LIDAR_SOURCE_KIND,
        "externalNativeLayer": True,
        "customLayerType": "lidar",
        "identifiable": False,
        "sourceId": source_id,
    }
    layer["sourcePath"] = url
    return layer


POINT_CLOUD_ANNOTATION_PLUGIN_ID = "geolibre-point-cloud-annotation"
"""Plugin id under which the app saves point cloud labels and 3D boxes."""


MAX_POINT_LABEL_NODE_BYTES = 16 * 1024 * 1024
"""Largest inflated size of one node's saved labels (mirrors the app's cap)."""

MAX_POINT_LABEL_BYTES = 256 * 1024 * 1024
"""Largest total inflated size of all saved labels in one project."""

MAX_POINT_LABEL_EDITS = 20_000_000
"""Most decoded label entries across a project; bounds Python memory, since a
dict entry costs far more than the two inflated bytes behind it."""


def decode_point_label_node(text: str, limit: int = MAX_POINT_LABEL_NODE_BYTES) -> dict[int, int]:
    """Decode one node's saved point labels.

    The app stores a node's edits as raw-DEFLATE compressed pairs of
    (delta-varint point index, class byte), base64 encoded.

    Args:
        text: The base64 string from the project.
        limit: Maximum inflated size in bytes; a larger record is rejected
            without being inflated in full (a crafted decompression bomb).

    Returns:
        Point index within the node -> ASPRS class code.

    Raises:
        ValueError: If the record is truncated, not valid DEFLATE, or
            inflates past ``limit``.
    """
    return _decode_point_label_node_sized(text, limit)[0]


def _decode_point_label_node_sized(
    text: str, limit: int, wide: bool = False
) -> tuple[dict[int, int], int]:
    """Decode one node's saved point labels and report its inflated size.

    Args:
        text: The base64 string from the project.
        limit: Maximum inflated size in bytes.
        wide: Values are varints (instance ids, up to 32 bits) rather than
            class bytes.

    Returns:
        The edits (as :func:`decode_point_label_node`) and the number of bytes
        inflated to produce them.

    Raises:
        ValueError: As :func:`decode_point_label_node`.
    """
    try:
        inflater = zlib.decompressobj(-15)
        data = inflater.decompress(base64.b64decode(text), limit + 1)
    except (ValueError, zlib.error) as error:
        raise ValueError(f"invalid point label record: {error}") from error
    if len(data) > limit or inflater.unconsumed_tail:
        raise ValueError("point label record is too large")
    edits: dict[int, int] = {}
    previous = -1
    at = 0
    while at < len(data):
        delta = 0
        shift = 0
        while True:
            if at >= len(data):
                raise ValueError("truncated point label record")
            byte = data[at]
            at += 1
            delta += (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
            # A point index needs at most five varint bytes; a longer run is
            # malformed (and would make this bigint loop quadratic).
            if shift >= 35:
                raise ValueError("invalid point label record: varint too long")
        if at >= len(data):
            raise ValueError("truncated point label record")
        index = previous + 1 + delta
        previous = index
        if not wide:
            edits[index] = data[at]
            at += 1
            continue
        value = 0
        shift = 0
        while True:
            if at >= len(data):
                raise ValueError("truncated point label record")
            # An instance id is a uint32: at most five varint bytes.
            if shift > 28:
                raise ValueError("invalid point label record: varint too long")
            byte = data[at]
            at += 1
            value += (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        if value > 0xFFFFFFFF:
            raise ValueError("invalid point label record: id out of range")
        edits[index] = value
    return edits, len(data)


def _decode_label_sources(
    entries: Any, limits: dict[str, int], wide: bool
) -> dict[str, dict[str, dict[int, int]]]:
    """Decode one kind of saved per-source edits (classes or instance ids).

    Args:
        entries: The saved ``[{"url", "nodes"}]`` list.
        limits: Shared ``{"budget", "entries"}`` allowances, drawn down in place.
        wide: Decode varint values (instance ids) rather than class bytes.

    Returns:
        ``{url: {node_key: {index: value}}}``.
    """
    out: dict[str, dict[str, dict[int, int]]] = {}
    for source in entries if isinstance(entries, list) else []:
        if not isinstance(source, dict):
            continue
        url = source.get("url")
        nodes = source.get("nodes") or {}
        if not isinstance(url, str) or not isinstance(nodes, dict):
            continue
        decoded: dict[str, dict[int, int]] = {}
        for key, text in nodes.items():
            if not isinstance(text, str) or limits["budget"] <= 0 or limits["entries"] <= 0:
                continue
            cap = min(MAX_POINT_LABEL_NODE_BYTES, limits["budget"])
            try:
                edits, inflated = _decode_point_label_node_sized(text, cap, wide)
            except ValueError:
                # A rejected node may have inflated up to its cap before
                # failing, so charge the cap: bad nodes cannot bypass the budget.
                limits["budget"] -= cap
                continue
            # Charge what was actually inflated (varints run to five bytes).
            limits["budget"] -= inflated
            if len(edits) > limits["entries"]:
                continue
            limits["entries"] -= len(edits)
            decoded[key] = edits
        # Merge repeated entries for one URL rather than dropping the first.
        out.setdefault(url, {}).update(decoded)
    return out


def point_cloud_annotations(project: dict[str, Any]) -> dict[str, Any]:
    """Read the point labels and 3D boxes the annotator saved in a project.

    Labels are keyed by each point's stable identity: the source node key (a
    COPC/EPT octree key such as ``"2-1-0-1"``, or ``"file"`` for a LAS/LAZ
    loaded whole) and the point's index within that node.

    Args:
        project: A project dict (e.g. ``Map.project`` or a loaded file).

    Returns:
        ``{"labels": {url: {node_key: {index: class}}}, "instances": {url:
        {node_key: {index: instance_id}}}, "boxes": [...], "vectors": [...],
        "classes": [...]}``. ``vectors`` are the 3D polylines, polygons and
        keypoints (see :func:`_point_cloud_vectors`).
        ``classes`` is the project's custom class schema (see
        :func:`point_cloud_class_schema`), and each box is ``{"url", "id",
        "class_code", "center", "size", "yaw", "status", "attributes"}``:
        ``center`` is ``[lng, lat, elevation_m]``, ``size`` ``[length, width,
        height]`` in metres, ``yaw`` radians counter-clockwise from east,
        ``status`` one of ``"new"``, ``"reviewed"`` or ``"flagged"``, and
        ``attributes`` the box's free-form string name/value pairs.
    """
    plugins = project.get("plugins") if isinstance(project, dict) else None
    settings = plugins.get("settings") if isinstance(plugins, dict) else None
    state = settings.get(POINT_CLOUD_ANNOTATION_PLUGIN_ID) if isinstance(settings, dict) else None
    if not isinstance(state, dict):
        state = {}
    limits = {"budget": MAX_POINT_LABEL_BYTES, "entries": MAX_POINT_LABEL_EDITS}
    labels = _decode_label_sources(state.get("sources"), limits, wide=False)
    instances = _decode_label_sources(state.get("instances"), limits, wide=True)
    boxes: list[dict[str, Any]] = []
    cuboids = state.get("cuboids") if isinstance(state, dict) else None
    for entry in cuboids if isinstance(cuboids, list) else []:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not isinstance(url, str):
            continue
        entry_boxes = entry.get("boxes")
        for box in entry_boxes if isinstance(entry_boxes, list) else []:
            if not isinstance(box, dict):
                continue
            boxes.append(
                {
                    "url": url,
                    "id": box.get("id"),
                    "class_code": box.get("classCode"),
                    "center": box.get("center"),
                    "size": box.get("size"),
                    "yaw": box.get("yaw"),
                    "status": _box_status(box.get("status")),
                    "attributes": _box_attributes(box.get("attributes")),
                }
            )
    classes = point_cloud_class_schema(state.get("customClasses"), strict=False)
    vectors = _point_cloud_vectors(state.get("vectors"))
    return {
        "labels": labels,
        "instances": instances,
        "boxes": boxes,
        "vectors": vectors,
        "classes": classes,
    }


_VECTOR_KINDS = {"polyline": 2, "polygon": 3, "keypoint": 1}
_MAX_VECTOR_VERTICES = 10_000


def _point_cloud_vectors(entries: Any) -> list[dict[str, Any]]:
    """Read the annotator's saved 3D vectors, skipping malformed ones.

    Args:
        entries: The saved ``[{"url", "items"}]`` list.

    Returns:
        ``[{"url", "id", "kind", "class_code", "points"}]`` with ``kind`` one of
        ``"polyline"``, ``"polygon"`` or ``"keypoint"`` and ``points`` a list
        of ``[lng, lat, elevation_m]``.
    """

    def is_vertex(value: Any) -> bool:
        return (
            isinstance(value, list)
            and len(value) == 3
            and all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                for v in value
            )
        )

    out: list[dict[str, Any]] = []
    for entry in entries if isinstance(entries, list) else []:
        url = entry.get("url") if isinstance(entry, dict) else None
        items = entry.get("items") if isinstance(entry, dict) else None
        if not isinstance(url, str) or not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            kind = item.get("kind")
            points = item.get("points")
            if kind not in _VECTOR_KINDS or not isinstance(points, list):
                continue
            if not _VECTOR_KINDS[kind] <= len(points) <= _MAX_VECTOR_VERTICES:
                continue
            if not all(is_vertex(point) for point in points):
                continue
            out.append(
                {
                    "url": url,
                    "id": item.get("id"),
                    "kind": kind,
                    "class_code": item.get("classCode"),
                    "points": [
                        list(point) for point in points[: 1 if kind == "keypoint" else None]
                    ],
                }
            )
    return out


_BOX_STATUSES = ("new", "reviewed", "flagged")
_MAX_BOX_ATTRIBUTES = 32


def _box_status(value: Any) -> str:
    """Return a saved box status, or ``"new"`` for a missing or unknown one.

    Args:
        value: The saved ``status`` field.

    Returns:
        One of ``"new"``, ``"reviewed"`` or ``"flagged"``.
    """
    return value if value in _BOX_STATUSES else "new"


def _box_attributes(value: Any) -> dict[str, str]:
    """Return a saved box's string attributes, dropping anything else.

    Args:
        value: The saved ``attributes`` field.

    Returns:
        Up to 32 name/value pairs with string keys and values, as the app caps them.
    """
    if not isinstance(value, dict):
        return {}
    out: dict[str, str] = {}
    for key, item in value.items():
        if len(out) >= _MAX_BOX_ATTRIBUTES:
            break
        if isinstance(key, str) and key.strip() and isinstance(item, str):
            out[_clip_utf16(key.strip(), 64)] = _clip_utf16(item, 256)
    return out


def _clip_utf16(text: str, length: int) -> str:
    """Cut text to at most ``length`` UTF-16 code units, as the app does.

    JavaScript measures strings in UTF-16 code units, so an emoji counts as
    two; a pair that would be split is dropped whole, matching the app.

    Args:
        text: The text.
        length: Maximum UTF-16 code units.

    Returns:
        The prefix.
    """
    encoded = text.encode("utf-16-le", "surrogatepass")
    if len(encoded) <= 2 * length:
        return text
    cut = encoded[: 2 * length].decode("utf-16-le", "surrogatepass")
    # Drop only a high surrogate left dangling by the cut; interior unpaired
    # surrogates (valid in JSON) stay, as they do in the app.
    return cut[:-1] if "\ud800" <= cut[-1] <= "\udbff" else cut


CUSTOM_CLASS_MIN = 19
"""Lowest code a custom class may use (ASPRS reserves 19-63, 64-255 are user)."""

CUSTOM_CLASS_MAX = 255
"""Highest code a custom class may use (the LAS classification byte)."""


def _hex_color(value: Any) -> str | None:
    """Normalize ``#rrggbb`` text or an ``(r, g, b)`` triple to ``#rrggbb``.

    Args:
        value: The colour.

    Returns:
        Lower-case ``#rrggbb``, or None when malformed.
    """
    if isinstance(value, str):
        text = value.strip()
        # Strict, like the app's parseHexColor: int(..., 16) would also take a
        # sign or "_" separators, which the app then rejects on load.
        return text.lower() if re.fullmatch(r"#[0-9a-fA-F]{6}", text) else None
    if (
        isinstance(value, (list, tuple))
        and len(value) == 3
        and all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 255 for v in value)
    ):
        return "#{:02x}{:02x}{:02x}".format(*value)
    return None


def point_cloud_class_schema(classes: Any, *, strict: bool = True) -> list[dict[str, Any]]:
    """Validate custom point classes for the annotator (its label schema).

    Custom classes extend the ASPRS standard classes 0-18 with user codes the
    annotator can assign, drawn in their own colour and named in the LiDAR
    legend.

    Args:
        classes: A list of ``{"code", "name", "color"}`` dicts; ``code`` an
            integer 19-255, ``name`` non-empty text (clipped to 64 UTF-16
            units, as the app does), ``color`` ``"#rrggbb"`` or ``(r, g, b)``.
        strict: Raise on an invalid entry (authoring) instead of skipping it
            (reading a saved project).

    Returns:
        The classes as ``{"code", "name", "color": "#rrggbb"}``, ascending by
        code; a repeated code keeps its last definition.

    Raises:
        ValueError: With ``strict``, for a malformed list or entry.
    """
    if classes is None:
        return []
    if not isinstance(classes, list):
        if strict:
            raise ValueError("classes must be a list of {code, name, color} objects")
        return []
    by_code: dict[int, dict[str, Any]] = {}
    for entry in classes:
        code = entry.get("code") if isinstance(entry, dict) else None
        name = entry.get("name") if isinstance(entry, dict) else None
        color = _hex_color(entry.get("color")) if isinstance(entry, dict) else None
        problem = None
        if not isinstance(code, int) or isinstance(code, bool):
            problem = "code must be an integer"
        elif not CUSTOM_CLASS_MIN <= code <= CUSTOM_CLASS_MAX:
            problem = f"code must be {CUSTOM_CLASS_MIN}-{CUSTOM_CLASS_MAX}"
        elif not isinstance(name, str) or not name.strip():
            problem = "name must be non-empty text"
        elif color is None:
            problem = "color must be #rrggbb or an (r, g, b) triple"
        if problem:
            if strict:
                raise ValueError(f"invalid custom class {entry!r}: {problem}")
            continue
        by_code[code] = {"code": code, "name": _clip_utf16(name.strip(), 64), "color": color}
    return [by_code[code] for code in sorted(by_code)]


def apply_point_labels(classification: Any, nodes: dict[str, dict[int, int]]) -> int:
    """Apply saved labels to the classification of a LAS/LAZ loaded whole.

    Labels on a whole-file source are keyed ``"file"`` with the point's index
    in file order, so they map straight onto e.g. ``laspy``'s
    ``las.classification``. COPC/EPT labels are keyed by octree node and need
    the node's point order; export those from the app as LAS/LAZ instead.

    Args:
        classification: A mutable sequence or NumPy array of class codes in
            file order (modified in place).
        nodes: One source's labels, as returned in
            ``point_cloud_annotations(project)["labels"][url]``.

    Returns:
        The number of points whose class changed.

    Raises:
        ValueError: If the labels are keyed by COPC/EPT node, or an index is
            past the end of ``classification``.
    """
    # Validate everything first, so a rejected record changes nothing.
    for key, edits in nodes.items():
        if key != "file":
            raise ValueError(
                f"labels keyed by octree node {key!r} need the COPC node order; "
                "export the annotated cloud as LAS/LAZ from the app instead"
            )
        for index in edits:
            if index < 0 or index >= len(classification):
                raise ValueError(f"label index {index} is past the {len(classification)} points")
    changed = 0
    for edits in nodes.values():
        for index, code in edits.items():
            if int(classification[index]) != code:
                classification[index] = code
                changed += 1
    return changed


CESIUM_ION_SOURCE_KIND = "cesium-ion"
"""``metadata.sourceKind`` of a layer that references a Cesium Ion asset."""


def cesium_ion_layer(
    name: str,
    asset_id: int,
    *,
    kind: str = "3d-tiles",
    altitude_offset: float = 0,
    **style: Any,
) -> dict[str, Any]:
    """Build a layer that references a Cesium Ion asset by id.

    The shape matches ``createCesiumIonLayer`` in ``@geolibre/core``: a
    ``3d-tiles`` layer for a tileset, a ``raster`` layer for imagery, both
    marked external so the 2D map leaves them alone and badges them "3D only".
    The globe loads the asset with the app's Cesium Ion token.

    Args:
        name: Layer display name.
        asset_id: The Cesium Ion asset id (a positive integer).
        kind: ``"3d-tiles"`` for a tileset or ``"imagery"`` for an imagery asset.
        altitude_offset: Vertical offset applied to a tileset, in meters.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``kind`` is unknown or ``asset_id`` is not a positive integer.
    """
    if kind not in ("3d-tiles", "imagery"):
        raise ValueError(f"kind must be '3d-tiles' or 'imagery', got {kind!r}")
    if isinstance(asset_id, bool) or not isinstance(asset_id, int) or asset_id <= 0:
        raise ValueError(f"asset_id must be a positive integer, got {asset_id!r}")
    tileset = kind == "3d-tiles"
    layer = _layer_base(name, "3d-tiles" if tileset else "raster", **style)
    source_id = layer["id"]
    source: dict[str, Any] = {
        "type": "3d-tiles" if tileset else "raster",
        "ionAssetId": asset_id,
        "sourceId": source_id,
    }
    metadata: dict[str, Any] = {
        "sourceKind": CESIUM_ION_SOURCE_KIND,
        "externalNativeLayer": True,
        "identifiable": False,
        "sourceId": source_id,
        "nativeLayerIds": [source_id],
    }
    if tileset:
        source["altitudeOffset"] = altitude_offset
        metadata["customLayerType"] = "3d-tiles"
        metadata["altitudeOffset"] = altitude_offset
    layer["source"] = source
    layer["metadata"] = metadata
    return layer


CZML_SOURCE_KIND = "czml"
"""``metadata.sourceKind`` of a layer that references a CZML dynamic scene."""


def czml_layer(
    name: str,
    *,
    url: str | None = None,
    data: list[dict[str, Any]] | dict[str, Any] | None = None,
    source_path: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a layer that loads a CZML (Cesium Language) dynamic 3D scene.

    The shape matches ``createCzmlLayer`` in ``@geolibre/core``: a
    ``3d-tiles`` layer marked external so the 2D map leaves it alone and badges
    it "3D only". The globe renders dynamic orbits, vehicle paths, and time-varying
    scenes from CZML packets with clock synchronization.

    Args:
        name: Layer display name.
        url: URL endpoint serving the CZML document.
        data: Inline parsed CZML document (packets array or packet object).
        source_path: Optional local file path when loaded from disk.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If neither ``url`` nor a non-empty ``data`` is provided.
    """
    if not url and not data:
        raise ValueError("Either url or non-empty data must be provided for a CZML layer")
    layer = _layer_base(name, "3d-tiles", **style)
    source_id = layer["id"]
    source: dict[str, Any] = {
        "type": "3d-tiles",
        "sourceId": source_id,
    }
    if url:
        source["url"] = url
    if data:
        source["czmlData"] = data
    if source_path:
        source["sourcePath"] = source_path
        layer["sourcePath"] = source_path

    metadata: dict[str, Any] = {
        "sourceKind": CZML_SOURCE_KIND,
        "externalNativeLayer": True,
        # Cesium builds real entities from the document and the globe's layer
        # sync answers for them, so a click can read a packet's name and custom
        # properties. Mirrors ``createCzmlLayer`` in ``@geolibre/core``.
        "identifiable": True,
        "sourceId": source_id,
        "nativeLayerIds": [source_id],
    }
    layer["source"] = source
    layer["metadata"] = metadata
    return layer


def cesium_kml_layer(
    name: str,
    *,
    url: str | None = None,
    data: str | None = None,
    source_path: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a native globe KML/KMZ layer preserving document styling.

    Supply a URL, inline KML XML, or a KMZ data URL. Package local resources
    inside KMZ archives so they remain available when sharing the project.
    """
    url = url.strip() if url else None
    data = data.strip() if data else None
    if not url and not data:
        raise ValueError("Provide a KML/KMZ document or URL.")
    layer = _layer_base(name, "3d-tiles", **style)
    layer["source"] = {
        "type": "3d-tiles",
        "sourceId": layer["id"],
        **({"kmlData": data} if data else {"url": url}),
    }
    if source_path:
        layer["sourcePath"] = source_path
    layer["metadata"] = {
        "sourceKind": "cesium-kml",
        "externalNativeLayer": True,
        "identifiable": False,
    }
    return layer


def video_layer(
    name: str,
    urls: list[str],
    coordinates: list[list[float]],
    **style: Any,
) -> dict[str, Any]:
    """Build a georeferenced video layer.

    Args:
        name: Layer display name.
        urls: One or more video URLs (format fallbacks, e.g. MP4 then WebM).
        coordinates: Four ``[lng, lat]`` corners in top-left, top-right,
            bottom-right, bottom-left order.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``urls`` is empty, any URL is not ``https://`` (the
            browser's ``media-src`` CSP blocks ``http://``), or ``coordinates``
            is not four ``[lng, lat]`` pairs.
    """
    if not urls:
        raise ValueError("video_layer requires at least one non-empty URL")
    # Validate strictly rather than silently dropping a None/non-string entry,
    # which would mask a malformed call and build a layer with fewer URLs.
    invalid = [u for u in urls if not (isinstance(u, str) and u)]
    if invalid:
        raise ValueError(f"video_layer: every URL must be a non-empty string; got {invalid!r}")
    clean_urls = list(urls)
    if any(not u.lower().startswith("https://") for u in clean_urls):
        raise ValueError("Video URLs must start with https:// (the browser CSP blocks http://)")
    if len(coordinates) != 4 or any(len(corner) != 2 for corner in coordinates):
        raise ValueError(
            "coordinates must be four [lng, lat] corners (top-left, top-right, "
            "bottom-right, bottom-left)"
        )
    lngs = [float(c[0]) for c in coordinates]
    lats = [float(c[1]) for c in coordinates]
    layer = _layer_base(name, "video", **style)
    layer["source"] = {
        "type": "video",
        "urls": clean_urls,
        "coordinates": [[lng, lat] for lng, lat in zip(lngs, lats)],
    }
    # Persist the corner bbox ([west, south, east, north]) so "Zoom to layer"
    # works — a video source exposes no bounds for fitLayer to fall back on.
    layer["metadata"] = {
        "sourceKind": "video-url",
        "bounds": [min(lngs), min(lats), max(lngs), max(lats)],
    }
    layer["sourcePath"] = clean_urls[0]
    return layer


def load_featurecollection(data: Any) -> dict[str, Any]:
    """Coerce assorted inputs into a GeoJSON FeatureCollection dict.

    Accepts a FeatureCollection/Feature/geometry dict, a file path or URL to a
    GeoJSON file, a JSON string, or any object exposing ``__geo_interface__``
    (e.g. a GeoPandas GeoDataFrame/GeoSeries or a Shapely geometry).

    Args:
        data: The input geometry/collection in one of the supported forms.

    Returns:
        A GeoJSON FeatureCollection dict.

    Raises:
        ValueError: If the input cannot be interpreted as GeoJSON.
    """
    if hasattr(data, "__geo_interface__"):
        data = data.__geo_interface__

    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8")

    if isinstance(data, str):
        text = data.strip()
        if text.startswith(("http://", "https://")):
            # Reject non-public hosts up front, then fetch through an opener that
            # re-checks every redirect hop, so a redirect to a private/metadata
            # address cannot be followed (SSRF defence).
            _assert_public_url(text)
            # Bound the request so a slow or oversized response cannot hang the
            # kernel or exhaust memory. read(limit + 1) detects an over-limit
            # body without buffering the whole thing.
            try:
                with _GEOJSON_OPENER.open(text, timeout=30) as response:  # noqa: S310 - user URL
                    raw = response.read(_MAX_GEOJSON_BYTES + 1)
            except (URLError, TimeoutError) as exc:
                # Normalize transport failures to the documented ValueError
                # contract (decode/JSON errors are already ValueError-derived).
                raise ValueError(f"Could not load GeoJSON from URL: {text}") from exc
            if len(raw) > _MAX_GEOJSON_BYTES:
                raise ValueError("GeoJSON response exceeds the 50 MB size limit")
            data = json.loads(raw.decode("utf-8"))
        elif text.startswith(("{", "[")):
            # Literal text is capped like the URL and file forms. It arrives
            # already in memory, so this bounds the parse (and the copy the
            # parse builds), not the read.
            if len(text.encode("utf-8")) > _MAX_GEOJSON_BYTES:
                raise ValueError("GeoJSON text exceeds the 50 MB size limit")
            data = json.loads(text)
        else:
            path = Path(text).expanduser()
            if not path.is_file():
                raise ValueError(f"GeoJSON file not found: {text}")
            if path.stat().st_size > _MAX_GEOJSON_BYTES:
                raise ValueError(f"GeoJSON file exceeds the 50 MB size limit: {text}")
            data = json.loads(path.read_text(encoding="utf-8"))

    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("Could not interpret input as GeoJSON")

    geom_type = data["type"]
    if geom_type == "FeatureCollection":
        if not isinstance(data.get("features"), list):
            raise ValueError("FeatureCollection must have a 'features' list")
        return data
    if geom_type == "Feature":
        return {"type": "FeatureCollection", "features": [data]}
    # A bare geometry: wrap it in a feature.
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": data}],
    }


# -- plugin (map control) state -----------------------------------------------
# The split-map (swipe), legend, and colorbar helpers are thin wrappers over the
# app's built-in map-control plugins, configured through the project's `plugins`
# block. The shapes here mirror the plugin project-state interfaces in
# packages/plugins/src/plugins/* (maplibre-swipe.ts, components/gui-state.ts),
# so the app replays them via PluginManager.restoreProjectState on load.

# The four corners every map control accepts (CONTROL_POSITIONS in
# components/gui-state.ts; PROJECT_PLUGIN_CONTROL_POSITIONS in core).
CONTROL_POSITIONS = frozenset({"top-left", "top-right", "bottom-left", "bottom-right"})

# Plugin ids registered in apps/geolibre-desktop/src/hooks/usePlugins.ts.
SWIPE_PLUGIN_ID = "maplibre-gl-swipe"
COMPONENTS_PLUGIN_ID = "maplibre-gl-components"

#: Plugin settings that survive :func:`redact_credentials`, as plugin id to the
#: sub-keys kept from its blob (``None`` keeps the whole blob). A plugin's
#: settings are free-form and a third-party plugin can keep an API key there, so
#: the default is to drop all of it. What is listed here is map-control
#: *composition* — the swipe split, legend entries and colors, the colorbar's
#: range and ramp — which is what a saved or exported project needs in order to
#: render the same map it was built as, and is structured rather than free text.
#:
#: The components plugin's ``html`` sub-key is deliberately absent: it holds a
#: custom HTML panel the user authored by hand, so it can carry anything,
#: including a URL with a token in it. It is dropped like any unknown blob.
#: Mirrored by ``PUBLISHABLE_PLUGIN_SETTINGS`` in
#: ``packages/core/src/credentials.ts``; the two must agree.
PUBLISHABLE_PLUGIN_SETTINGS: dict[str, tuple[str, ...] | None] = {
    SWIPE_PLUGIN_ID: None,
    COMPONENTS_PLUGIN_ID: ("legend", "colorbar"),
    # The timeline config owns its temporal source definitions. Its mirrored
    # store layers only carry internal source ids, so dropping this state makes
    # shared Time Slider layers impossible to reconstruct. The retained value
    # is still recursively credential-scrubbed by the caller.
    "maplibre-gl-time-slider": None,
    # Feed toggles (one boolean per feed) plus a numeric clock speed — no URLs,
    # no keys, nothing user-authored. Listed as a whole blob rather than by key
    # because the feed set grows with every new feed; an enumerated list would
    # silently start counting each new toggle as a credential. The retained
    # value is still recursively credential-scrubbed by the caller.
    "gods-eye-view": None,
    # Point class edits keyed by (node key, index): compressed numbers, no user
    # text. Source URLs are values, so the caller's scrub still covers them.
    "geolibre-point-cloud-annotation": None,
}

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


# -- layer filters -------------------------------------------------------------

#: Expression operators that can produce a boolean, which is what the app's
#: ``filterExpression`` must evaluate to (``normalizeLayer`` in
#: ``packages/core/src/project.ts`` validates it with ``expectedType:
#: "boolean"`` and silently drops anything else on load). The app's validator is
#: the authority; this is the structural pre-check that catches the common
#: mistakes (a bare property name, a numeric expression) before they are saved
#: and quietly discarded.
FILTER_EXPRESSION_OPERATORS = frozenset(
    {
        "==",
        "!=",
        "<",
        "<=",
        ">",
        ">=",
        "!",
        "all",
        "any",
        "in",
        "has",
        "!has",
        "within",
        "boolean",
        "to-boolean",
    }
)

#: Operators whose result type is whichever branch they return, mapped to the
#: indexes of those branches (``None`` for "the last argument"). A filter built
#: from one is boolean only when every branch is.
_POLYMORPHIC_OPERATORS = {"case", "match", "coalesce", "let"}


def _polymorphic_branches(expression: list[Any]) -> list[Any]:
    """Return the branches a ``case``/``match``/``coalesce``/``let`` can yield.

    Args:
        expression: An expression whose head is in ``_POLYMORPHIC_OPERATORS``.

    Returns:
        The argument expressions the result is taken from.
    """
    head, args = expression[0], expression[1:]
    if head == "case":
        # [cond, out, cond, out, ..., fallback]
        return [*args[1:-1:2], args[-1]] if args else []
    if head == "match":
        # [input, labels, out, labels, out, ..., fallback]
        return [*args[2:-1:2], args[-1]] if len(args) > 1 else []
    if head == "let":
        return args[-1:]
    return list(args)


def _yields_boolean(value: Any) -> bool:
    """Whether an expression (or literal) can only produce a boolean.

    Args:
        value: An expression array or a literal.

    Returns:
        ``True`` for a boolean literal, a boolean operator, or a polymorphic
        operator all of whose branches yield booleans.
    """
    if isinstance(value, bool):
        return True
    if not isinstance(value, list) or not value or not isinstance(value[0], str):
        return False
    if value[0] in FILTER_EXPRESSION_OPERATORS:
        return True
    if value[0] in _POLYMORPHIC_OPERATORS:
        branches = _polymorphic_branches(value)
        return bool(branches) and all(_yields_boolean(branch) for branch in branches)
    return False


def _parse_expression(expression: Any, what: str) -> list[Any]:
    """Coerce a MapLibre expression given as a list or a JSON string to a list.

    Args:
        expression: A list, or a JSON string encoding one.
        what: The argument name, for error messages.

    Returns:
        The expression as a non-empty list whose head is an operator string.

    Raises:
        ValueError: If the value is not a JSON array expression.
    """
    if isinstance(expression, str):
        try:
            expression = json.loads(expression)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{what} is not valid JSON: {exc.msg}") from exc
    if isinstance(expression, tuple):
        expression = list(expression)
    if not isinstance(expression, list) or not expression:
        raise ValueError(
            f"{what} must be a MapLibre expression array such as "
            '[">=", ["get", "population"], 100000]'
        )
    if not isinstance(expression[0], str):
        raise ValueError(f"{what} must start with an operator string, got {expression[0]!r}")
    try:
        return json.loads(json.dumps(expression, allow_nan=False))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{what} must be JSON-serializable: {exc}") from exc


def filter_expression(expression: Any) -> list[Any]:
    """Build a layer's persistent ``filterExpression``.

    Args:
        expression: A boolean MapLibre expression, as a list or a JSON string,
            e.g. ``[">=", ["get", "population"], 100000]``.

    Returns:
        The expression as a list, ready for the layer's ``filterExpression``.

    Raises:
        ValueError: If the expression is not an array, or its operator cannot
            produce a boolean.
    """
    parsed = _parse_expression(expression, "filter expression")
    if not _yields_boolean(parsed):
        raise ValueError(
            f"a layer filter must evaluate to true/false; this {parsed[0]!r} does not. "
            "Use a comparison such as ['==', ['get', 'field'], 'value'] or combine "
            "several with 'all' / 'any'"
        )
    return parsed


# -- labels --------------------------------------------------------------------

#: Mirror of ``DEFAULT_LAYER_STYLE.labels`` in ``packages/core/src/types.ts``.
#: The app merges a stored ``labels`` object over these field by field when it
#: renders, so a written object carries every key to stay stable on round trip.
DEFAULT_LABEL_STYLE: dict[str, Any] = {
    "enabled": False,
    "field": "",
    "expression": "",
    "placement": "point",
    "size": 13,
    "color": "#111827",
    "haloColor": "#ffffff",
    "haloWidth": 1.5,
    "minZoom": 0,
    "maxZoom": 24,
    "allowOverlap": False,
    "anchor": "center",
    "offsetX": 0,
    "offsetY": 0,
    "rotation": 0,
    "maxWidth": 10,
    "transform": "none",
    "numberFormatEnabled": False,
    "numberDecimals": 0,
    "numberLocale": "",
    "dedupe": "off",
    "sizeExpression": "",
    "colorExpression": "",
    "opacityExpression": "",
    "visibilityExpression": "",
    "priorityExpression": "",
}

LABEL_PLACEMENTS = frozenset({"point", "line"})
LABEL_ANCHORS = frozenset(
    {
        "center",
        "left",
        "right",
        "top",
        "bottom",
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
    }
)
LABEL_TRANSFORMS = frozenset({"none", "uppercase", "lowercase"})
LABEL_DEDUPE_MODES = frozenset({"off", "unique", "concatenate"})
#: ``LABEL_NUMBER_LOCALES`` in ``packages/core/src/label-number-format.ts``;
#: the empty string follows the app's own language.
LABEL_NUMBER_LOCALES = frozenset({"", "en-US", "de-DE", "ru-RU", "hi-IN"})

# snake_case keyword -> LabelStyle key, with how to check the value.
_LABEL_OPTIONS: dict[str, tuple[str, str]] = {
    "placement": ("placement", "placement"),
    "size": ("size", "positive"),
    "color": ("color", "color"),
    "halo_color": ("haloColor", "color"),
    "halo_width": ("haloWidth", "non_negative"),
    "min_zoom": ("minZoom", "zoom"),
    "max_zoom": ("maxZoom", "zoom"),
    "allow_overlap": ("allowOverlap", "bool"),
    "anchor": ("anchor", "anchor"),
    "offset_x": ("offsetX", "number"),
    "offset_y": ("offsetY", "number"),
    "rotation": ("rotation", "number"),
    "max_width": ("maxWidth", "positive"),
    "transform": ("transform", "transform"),
    "number_format": ("numberFormatEnabled", "bool"),
    "number_decimals": ("numberDecimals", "decimals"),
    "number_locale": ("numberLocale", "locale"),
    "dedupe": ("dedupe", "dedupe"),
    "size_expression": ("sizeExpression", "expression"),
    "color_expression": ("colorExpression", "expression"),
    "opacity_expression": ("opacityExpression", "expression"),
    "visibility_expression": ("visibilityExpression", "expression"),
    "priority_expression": ("priorityExpression", "expression"),
}

#: The keyword options :func:`label_style` accepts besides field/expression.
LABEL_OPTION_NAMES = tuple(_LABEL_OPTIONS)

_LABEL_ENUMS = {
    "placement": LABEL_PLACEMENTS,
    "anchor": LABEL_ANCHORS,
    "transform": LABEL_TRANSFORMS,
    "dedupe": LABEL_DEDUPE_MODES,
    "locale": LABEL_NUMBER_LOCALES,
}


def _label_value(name: str, kind: str, value: Any) -> Any:
    """Validate one label option and return the value to store.

    Args:
        name: The keyword name, for error messages.
        kind: The check to apply (see ``_LABEL_OPTIONS``).
        value: The caller's value.

    Returns:
        The value as the app stores it.

    Raises:
        ValueError: If the value is out of range or of the wrong kind.
    """
    if kind in _LABEL_ENUMS:
        allowed = _LABEL_ENUMS[kind]
        if value not in allowed:
            raise ValueError(f"{name} must be one of {sorted(allowed)}, got {value!r}")
        return value
    if kind == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"{name} must be true or false, got {value!r}")
        return value
    if kind == "color":
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a CSS color string, got {value!r}")
        return value.strip()
    if kind == "expression":
        if value is None or value == "":
            return ""
        return json.dumps(_parse_expression(value, name), separators=(",", ":"))
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite, got {value!r}")
    if kind == "positive" and number <= 0:
        raise ValueError(f"{name} must be greater than 0, got {value!r}")
    if kind == "non_negative" and number < 0:
        raise ValueError(f"{name} must be 0 or more, got {value!r}")
    if kind == "zoom" and not 0 <= number <= 24:
        raise ValueError(f"{name} must be between 0 and 24, got {value!r}")
    if kind == "decimals":
        if number != int(number) or not 0 <= number <= 10:
            raise ValueError(f"{name} must be a whole number from 0 to 10, got {value!r}")
        return int(number)
    return int(number) if number == int(number) else number


def label_style(
    field: str | None = None,
    *,
    expression: Any = None,
    enabled: bool | None = None,
    base: dict[str, Any] | None = None,
    **options: Any,
) -> dict[str, Any]:
    """Build a layer's ``style.labels`` object (``LabelStyle`` in types.ts).

    Args:
        field: Attribute whose value becomes the label text.
        expression: A MapLibre expression (list or JSON string) for the label
            text; overrides ``field`` when set, e.g.
            ``["concat", ["get", "name"], " (", ["get", "pop"], ")"]``. Pass
            ``""`` to clear an existing one.
        enabled: Whether labels are shown. ``False`` keeps the configuration
            but hides the labels. ``None`` keeps ``base``'s value, or turns
            labels on when there is no ``base``.
        base: An existing labels object to update; unspecified options keep
            its values. Defaults to :data:`DEFAULT_LABEL_STYLE`.
        **options: Any of :data:`LABEL_OPTION_NAMES` -- ``placement``
            (``"point"``/``"line"``), ``size``, ``color``, ``halo_color``,
            ``halo_width``, ``min_zoom``, ``max_zoom``, ``allow_overlap``,
            ``anchor``, ``offset_x``, ``offset_y``, ``rotation``, ``max_width``,
            ``transform``, ``number_format``, ``number_decimals``,
            ``number_locale``, ``dedupe``, and the data-defined
            ``size_expression``, ``color_expression``, ``opacity_expression``,
            ``visibility_expression``, ``priority_expression``. ``None``
            values are skipped.

    Returns:
        A complete labels object.

    Raises:
        ValueError: If an option is unknown or invalid, or labels are enabled
            with neither a field nor an expression to draw.
    """
    unknown = sorted(set(options) - set(_LABEL_OPTIONS))
    if unknown:
        raise ValueError(
            f"unknown label option(s) {unknown}; expected any of {list(LABEL_OPTION_NAMES)}"
        )
    labels = copy.deepcopy(DEFAULT_LABEL_STYLE)
    if isinstance(base, dict):
        labels.update(copy.deepcopy(base))
    if enabled is None:
        enabled = bool(labels.get("enabled")) if isinstance(base, dict) else True
    if not isinstance(enabled, bool):
        raise ValueError(f"enabled must be true or false, got {enabled!r}")
    labels["enabled"] = enabled
    if field is not None:
        if not isinstance(field, str):
            raise ValueError(f"field must be a property name, got {field!r}")
        labels["field"] = field.strip()
    if expression is not None:
        labels["expression"] = _label_value("expression", "expression", expression)
    for name, value in options.items():
        if value is None:
            continue
        key, kind = _LABEL_OPTIONS[name]
        labels[key] = _label_value(name, kind, value)
    if labels["minZoom"] > labels["maxZoom"]:
        raise ValueError(
            f"min_zoom ({labels['minZoom']}) must not exceed max_zoom ({labels['maxZoom']})"
        )
    if labels["enabled"] and not labels["field"] and not labels["expression"]:
        raise ValueError("labels need a field or an expression to draw")
    return labels


# -- plugin state --------------------------------------------------------------

#: Built-in plugins that restore saved project state (they implement
#: ``applyProjectState`` in ``packages/plugins/src/plugins/*``). A settings blob
#: stored under any other id is ignored by the app unless an external plugin
#: with that id is loaded from a manifest URL, so callers refuse unknown ids
#: unless asked not to. A repo test checks every id here still appears in the
#: plugin sources.
PLUGIN_STATE_IDS = frozenset(
    {
        "geolibre-elevation-profile",
        "geolibre-flight-simulator",
        "geolibre-point-cloud-annotation",
        "geolibre-route-animation",
        "geolibre-sun",
        "geolibre-timelapse",
        "gods-eye-view",
        "maplibre-a5-grid",
        "maplibre-atmosphere-effects",
        "maplibre-dggal",
        "maplibre-dggrid",
        "maplibre-geohash",
        "maplibre-gl-components",
        "maplibre-gl-graticule",
        "maplibre-gl-overture-maps",
        "maplibre-gl-swipe",
        "maplibre-gl-time-slider",
        "maplibre-h3-grid",
        "maplibre-olc",
        "maplibre-s2-grid",
        "maplibre-samgeo",
        "maplibre-tilecode",
    }
)


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


# -- story maps ----------------------------------------------------------------

#: Mirror of ``DEFAULT_STORY_MAP`` in packages/core/src/types.ts.
DEFAULT_STORY_MAP: dict[str, Any] = {
    "title": "",
    "subtitle": "",
    "byline": "",
    "footer": "",
    "theme": "dark",
    "showMarkers": False,
    "markerColor": "#3fb1ce",
    "inset": False,
    "insetPosition": "bottom-left",
    "hideChapterNav": False,
    "startSlide": "none",
    "endSlide": "none",
    "chapters": [],
}

STORY_THEMES = frozenset({"light", "dark"})
STORY_ALIGNMENTS = frozenset({"left", "center", "right", "full"})
STORY_ANIMATIONS = frozenset({"flyTo", "easeTo", "jumpTo"})
STORY_INSET_POSITIONS = CONTROL_POSITIONS
STORY_SLIDE_MODES = frozenset({"none", "blank", "black", "global", "adjacent"})

# snake_case keyword -> StoryMap key, with the allowed values (`str` for free
# text, `bool` for flags, otherwise a vocabulary).
_STORY_SETTINGS: dict[str, tuple[str, Any]] = {
    "title": ("title", str),
    "subtitle": ("subtitle", str),
    "byline": ("byline", str),
    "footer": ("footer", str),
    "theme": ("theme", STORY_THEMES),
    "show_markers": ("showMarkers", bool),
    "marker_color": ("markerColor", str),
    "inset": ("inset", bool),
    "inset_position": ("insetPosition", STORY_INSET_POSITIONS),
    "hide_chapter_nav": ("hideChapterNav", bool),
    "start_slide": ("startSlide", STORY_SLIDE_MODES),
    "end_slide": ("endSlide", STORY_SLIDE_MODES),
}

#: The keyword settings :func:`story_map_settings` accepts.
STORY_SETTING_NAMES = tuple(_STORY_SETTINGS)


def story_map_settings(**settings: Any) -> dict[str, Any]:
    """Validate story map presentation settings and map them to project keys.

    Args:
        **settings: Any of :data:`STORY_SETTING_NAMES`. ``None`` values are
            skipped.

    Returns:
        The settings keyed as ``StoryMap`` stores them (``showMarkers``, ...).

    Raises:
        ValueError: If a setting is unknown or has a value the app rejects.
    """
    unknown = sorted(set(settings) - set(_STORY_SETTINGS))
    if unknown:
        raise ValueError(
            f"unknown story map setting(s) {unknown}; expected any of {list(STORY_SETTING_NAMES)}"
        )
    out: dict[str, Any] = {}
    for name, value in settings.items():
        if value is None:
            continue
        key, rule = _STORY_SETTINGS[name]
        if rule is str:
            if not isinstance(value, str):
                raise ValueError(f"{name} must be a string, got {value!r}")
        elif rule is bool:
            if not isinstance(value, bool):
                raise ValueError(f"{name} must be true or false, got {value!r}")
        elif value not in rule:
            raise ValueError(f"{name} must be one of {sorted(rule)}, got {value!r}")
        out[key] = value
    return out


def _story_number(value: float) -> float | int:
    """Store a whole float as an int, the way JSON written by the app reads."""
    return int(value) if value == int(value) else value


def _opacity_changes(entries: Any, what: str) -> list[dict[str, Any]]:
    """Build a chapter's ``onChapterEnter``/``onChapterExit`` list.

    Args:
        entries: ``None`` or a list of ``{"layer", "opacity", "duration"}``
            mappings (``layer_id``/``layerId`` are accepted for ``layer``).
            Layer references are expected to be resolved to ids by the caller.
        what: The argument name, for error messages.

    Returns:
        ``StoryLayerOpacityChange`` dicts.

    Raises:
        ValueError: If an entry has no layer, or an opacity or duration out of
            range.
    """
    if entries is None:
        return []
    if not isinstance(entries, (list, tuple)):
        raise ValueError(f"{what} must be a list of {{layer, opacity}} entries")
    changes: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(f"each {what} entry must be an object, got {entry!r}")
        layer_id = entry.get("layerId", entry.get("layer_id", entry.get("layer")))
        if not isinstance(layer_id, str) or not layer_id:
            raise ValueError(f"each {what} entry needs a layer")
        opacity = entry.get("opacity", 1)
        if isinstance(opacity, bool) or not isinstance(opacity, (int, float)):
            raise ValueError(f"{what} opacity must be a number, got {opacity!r}")
        if not 0 <= float(opacity) <= 1:
            raise ValueError(f"{what} opacity must be between 0 and 1, got {opacity!r}")
        change: dict[str, Any] = {
            "id": str(entry.get("id") or uuid.uuid4()),
            "layerId": layer_id,
            "opacity": _story_number(float(opacity)),
        }
        duration = entry.get("duration")
        if duration is not None:
            if isinstance(duration, bool) or not isinstance(duration, (int, float)):
                raise ValueError(f"{what} duration must be milliseconds, got {duration!r}")
            if not math.isfinite(float(duration)) or duration < 0:
                raise ValueError(f"{what} duration must be 0 or more, got {duration!r}")
            change["duration"] = _story_number(float(duration))
        changes.append(change)
    return changes


def story_chapter(
    title: str,
    *,
    center: tuple[float, float] | list[float],
    zoom: float,
    pitch: float = 0,
    bearing: float = 0,
    description: str = "",
    image: str | None = None,
    alignment: str = "left",
    hidden: bool = False,
    map_animation: str = "flyTo",
    rotate_animation: bool = False,
    on_enter: Any = None,
    on_exit: Any = None,
    chapter_id: str | None = None,
) -> dict[str, Any]:
    """Build one story map chapter (``StoryChapter`` in types.ts).

    Values are stored the way ``normalizeStoryChapter`` in project.ts leaves
    them, so the app loads the chapter unchanged: the bearing is wrapped into
    0-360, and out-of-range coordinates, zooms, and pitches are refused rather
    than silently clamped.

    Args:
        title: Chapter heading.
        center: Camera target as ``(lng, lat)``.
        zoom: Camera zoom, 0-24.
        pitch: Camera tilt in degrees, 0-85.
        bearing: Camera rotation in degrees.
        description: Chapter body text.
        image: Optional image URL (or data URI) shown in the chapter panel.
        alignment: Text panel position: ``"left"``, ``"center"``, ``"right"``,
            or ``"full"``.
        hidden: Hide the text panel while still moving the map.
        map_animation: ``"flyTo"``, ``"easeTo"``, or ``"jumpTo"``.
        rotate_animation: Slowly rotate the camera once the move settles.
        on_enter: Layer opacity changes applied on entering the chapter, as
            ``{"layer": <id>, "opacity": 0-1, "duration": ms}`` entries.
        on_exit: Layer opacity changes applied on leaving the chapter.
        chapter_id: Explicit chapter id; a UUID by default.

    Returns:
        A chapter dict.

    Raises:
        ValueError: If any value is out of range or not in its vocabulary.
    """
    if not isinstance(title, str):
        raise ValueError(f"title must be a string, got {title!r}")
    if not isinstance(description, str):
        raise ValueError(f"description must be a string, got {description!r}")
    if not isinstance(center, (list, tuple)) or len(center) != 2:
        raise ValueError(f"center must be (lng, lat), got {center!r}")
    try:
        lng, lat, zoom, pitch, bearing = (float(value) for value in (*center, zoom, pitch, bearing))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"center, zoom, pitch and bearing must be numbers: {exc}") from exc
    if not (math.isfinite(lng) and -180 <= lng <= 180):
        raise ValueError(f"longitude must be between -180 and 180, got {center[0]!r}")
    if not (math.isfinite(lat) and -90 <= lat <= 90):
        raise ValueError(f"latitude must be between -90 and 90, got {center[1]!r}")
    if not (math.isfinite(zoom) and 0 <= zoom <= 24):
        raise ValueError(f"zoom must be between 0 and 24, got {zoom!r}")
    if not (math.isfinite(pitch) and 0 <= pitch <= 85):
        raise ValueError(f"pitch must be between 0 and 85, got {pitch!r}")
    if not math.isfinite(bearing):
        raise ValueError(f"bearing must be finite, got {bearing!r}")
    if alignment not in STORY_ALIGNMENTS:
        raise ValueError(f"alignment must be one of {sorted(STORY_ALIGNMENTS)}, got {alignment!r}")
    if map_animation not in STORY_ANIMATIONS:
        raise ValueError(
            f"map_animation must be one of {sorted(STORY_ANIMATIONS)}, got {map_animation!r}"
        )
    if not isinstance(hidden, bool) or not isinstance(rotate_animation, bool):
        raise ValueError("hidden and rotate_animation must be true or false")
    if image is not None and not isinstance(image, str):
        raise ValueError(f"image must be a URL string, got {image!r}")
    chapter_id = str(chapter_id).strip() if chapter_id is not None else str(uuid.uuid4())
    if not chapter_id:
        raise ValueError("chapter_id must not be empty")

    chapter: dict[str, Any] = {
        "id": chapter_id,
        "title": title,
        "description": description,
    }
    if image:
        chapter["image"] = image
    chapter.update(
        {
            "alignment": alignment,
            "hidden": hidden,
            "location": {
                "center": [_story_number(lng), _story_number(lat)],
                "zoom": _story_number(zoom),
                "pitch": _story_number(pitch),
                "bearing": _story_number(bearing % 360),
            },
            "mapAnimation": map_animation,
            "rotateAnimation": rotate_animation,
            "onChapterEnter": _opacity_changes(on_enter, "on_enter"),
            "onChapterExit": _opacity_changes(on_exit, "on_exit"),
        }
    )
    return chapter
