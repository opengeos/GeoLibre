"""Credential redaction for shared and exported projects."""

from __future__ import annotations

import copy
import re
from typing import Any
from urllib.parse import unquote_plus

from ._constants import _PROJECT_CONSTANTS


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
            and not name.startswith(("x-amz-", "x-goog-"))
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


def redact_credentials(
    project: dict[str, Any], *, strip_non_exportable: bool = True
) -> dict[str, Any]:
    """Return a detached project safe to publish, export, or hand to others.

    Redacts credentials across layers, basemap/map style URLs (including
    ``mapboxStyleUrl`` and ``terrainSource``), geocoder settings, plugin
    manifest URLs, and secret environment variables. When
    ``strip_non_exportable`` is ``True`` (the default), inline GeoJSON data on
    layers with ``capabilities.export == False`` is also removed; pass
    ``strip_non_exportable=False`` for read-only in-session previews that still
    need inline geometry.
    """
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
        map_prefs = preferences.get("map")
        if isinstance(map_prefs, dict):
            for field in ("mapboxStyleUrl", "terrainSource"):
                if isinstance(map_prefs.get(field), str):
                    map_prefs[field] = _redact_url(map_prefs[field])
    layers = safe.get("layers")
    if isinstance(layers, list):
        for layer in layers:
            if not isinstance(layer, dict):
                continue
            _sweep_layer_credentials(layer)
            # Mirror packages/core/src/credentials.ts: strip carried feature
            # data when the layer marks export as disallowed (skipped for
            # in-session read-only previews that need inline geometry).
            capabilities = layer.get("capabilities")
            if (
                strip_non_exportable
                and isinstance(capabilities, dict)
                and capabilities.get("export") is False
            ):
                layer.pop("geojson", None)
                layer_metadata = layer.get("metadata")
                if isinstance(layer_metadata, dict):
                    layer_metadata.pop("embeddedGeoJSON", None)
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
#: Loaded from ``project-constants.json`` (shared with ``@geolibre/core``).
PUBLISHABLE_PLUGIN_SETTINGS: dict[str, tuple[str, ...] | None] = {
    plugin_id: tuple(keys) if isinstance(keys, list) else None
    for plugin_id, keys in _PROJECT_CONSTANTS["PUBLISHABLE_PLUGIN_SETTINGS"].items()
}
