"""Raster layer builders: Planetary Computer, COG and Zarr."""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from .layers import _assert_no_url_userinfo, _layer_base

PLANETARY_COMPUTER_SOURCE_KIND = "planetary-computer-raster"


# A band of one asset is spelled `<asset>_b<N>` in a band-math expression. An
# expression without one refers to whole assets (`(B08-B04)/(B08+B04)`), which
# the Planetary Computer Data API only evaluates with `asset_as_band` set.
_ASSET_BAND_REFERENCE = re.compile(r"_b\d+\b")


_DATE_ONLY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _planetary_computer_datetime(value: str | tuple[str, str] | list[str]) -> str:
    """Normalize a date or date range to the RFC 3339 form a STAC search takes.

    Args:
        value: A single date/datetime, a ``"start/end"`` range, or a
            ``(start, end)`` pair. A date-only bound is widened to the whole
            day (start of day for the first bound, end of day for the last).
            ``".."`` leaves a bound open.

    Returns:
        The datetime, or ``start/end`` range, with full timestamps.

    Raises:
        ValueError: If the value is empty or has more than two bounds.
    """
    if isinstance(value, (tuple, list)):
        parts = [str(part) for part in value]
    else:
        parts = str(value).split("/")
    parts = [part.strip() for part in parts]
    if not 1 <= len(parts) <= 2 or not all(parts):
        raise ValueError("datetime must be a date, a 'start/end' range, or a (start, end) pair")

    def bound(text: str, end: bool) -> str:
        if text == ".." or "T" in text.upper():
            return text
        # A partial date ("2024-06") would be widened into a timestamp the STAC
        # search rejects, and only when the app opens the project.
        if not _DATE_ONLY.fullmatch(text):
            raise ValueError(
                f"datetime bound {text!r} must be a YYYY-MM-DD date, an RFC 3339 datetime, or '..'"
            )
        return f"{text}T23:59:59Z" if end else f"{text}T00:00:00Z"

    if len(parts) == 1:
        if parts[0] == "..":
            raise ValueError("datetime cannot be an open bound on its own")
        # A date-only value means that whole day.
        if "T" not in parts[0].upper():
            return f"{bound(parts[0], False)}/{bound(parts[0], True)}"
        return parts[0]
    return f"{bound(parts[0], False)}/{bound(parts[1], True)}"


def planetary_computer_layer(
    collection: str,
    item: str | None = None,
    *,
    name: str | None = None,
    datetime: str | tuple[str, str] | list[str] | None = None,
    bbox: list[float] | tuple[float, ...] | None = None,
    preset: str | None = None,
    assets: list[str] | None = None,
    expression: str | None = None,
    rescale: tuple[float, float] | list[float] | None = None,
    colormap: str | None = None,
    max_cloud_cover: float | None = None,
) -> dict[str, Any]:
    """Build a Microsoft Planetary Computer raster layer.

    With ``item`` the layer draws that one STAC item. Without it the layer is a
    mosaic: every item of the collection matching ``datetime`` and
    ``max_cloud_cover``, composited into one seamless layer.

    The layer holds no tile URL. It carries the collection, the item id or the
    mosaic's search, and the render options, in the shape the app's Planetary
    Computer panel saves (see
    packages/plugins/src/plugins/maplibre-planetary-computer.ts), so opening
    the project makes the panel rebuild it: the layer is listed in the panel's
    Layers tab and can be restyled there. Building it needs no network access.

    Args:
        collection: STAC collection id, e.g. ``"sentinel-2-l2a"``.
        item: STAC item id to draw. Omit for a mosaic of the collection.
        name: Layer display name. Defaults to the item id, or to the collection
            id with the date range for a mosaic.
        datetime: Mosaic only. The date range to composite: a ``"start/end"``
            string or a ``(start, end)`` pair. Date-only bounds cover whole days.
        bbox: ``[west, south, east, north]`` extent of the layer, used by
            zoom-to-layer and to bound a mosaic's tile requests.
        preset: Name of one of the panel's render presets for the collection,
            e.g. ``"true-color"``, ``"false-color"``, ``"ndvi"``. With none of
            the render options the collection's default preset is used.
        assets: Asset names to render, e.g. ``["B08", "B04", "B03"]``.
        expression: Band-math expression over assets, e.g.
            ``"(B08-B04)/(B08+B04)"``. Mutually exclusive with ``assets``.
        rescale: ``(min, max)`` value range stretched to the output colors.
        colormap: Named colormap for a single-band or expression render, e.g.
            ``"viridis"``.
        max_cloud_cover: Mosaic only. Keep items at or below this
            ``eo:cloud_cover`` percentage; the least cloudy are drawn on top.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If the collection is empty, ``assets`` and ``expression``
            are combined, a mosaic-only option is given with ``item``, or
            ``bbox``/``rescale``/``max_cloud_cover`` is malformed.
    """
    collection = str(collection or "").strip()
    if not collection:
        raise ValueError("collection is required")
    if item is not None:
        item = str(item).strip()
        if not item:
            raise ValueError("item must be a non-empty STAC item id")
        if datetime is not None or max_cloud_cover is not None:
            raise ValueError(
                "datetime and max_cloud_cover select the items of a mosaic; "
                "omit them when item names a single STAC item"
            )
    if assets and expression:
        raise ValueError("pass either assets or expression, not both")

    render_params: dict[str, Any] = {}
    if assets:
        render_params["assets"] = [str(asset) for asset in assets]
    if expression:
        render_params["expression"] = expression
        if not _ASSET_BAND_REFERENCE.search(expression):
            render_params["asset_as_band"] = True
    if rescale is not None:
        if isinstance(rescale, str) or len(rescale) != 2:
            raise ValueError("rescale must be a (min, max) pair")
        low, high = (_finite_number(value, "rescale") for value in rescale)
        render_params["rescale"] = f"{_format_number(low)},{_format_number(high)}"
    if colormap:
        render_params["colormap_name"] = colormap

    bounds: list[float] | None = None
    if bbox is not None:
        if len(bbox) != 4:
            raise ValueError("bbox must be [west, south, east, north]")
        bounds = [_finite_number(value, "bbox") for value in bbox]
        if bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
            raise ValueError("bbox must be [west, south, east, north]")

    search: dict[str, Any] | None = None
    range_label = ""
    if item is None:
        search = {"collections": [collection]}
        if datetime is not None:
            search["datetime"] = _planetary_computer_datetime(datetime)
            range_label = " to ".join(
                part[:10] for part in search["datetime"].split("/") if part != ".."
            )
        if max_cloud_cover is not None:
            cloud = _finite_number(max_cloud_cover, "max_cloud_cover")
            if not 0 <= cloud <= 100:
                raise ValueError("max_cloud_cover must be between 0 and 100")
            search["query"] = {"eo:cloud_cover": {"lte": cloud}}
            search["sortby"] = [{"field": "properties.eo:cloud_cover", "direction": "asc"}]
        else:
            search["sortby"] = [{"field": "properties.datetime", "direction": "desc"}]

    default_name = item or (f"{collection} ({range_label})" if range_label else collection)
    layer = _layer_base(name or default_name, "raster")
    source_id = f"{layer['id']}-source"
    layer["source"] = {
        "collectionId": collection,
        "sourceId": source_id,
        "type": "raster",
    }
    metadata: dict[str, Any] = {
        "assets": render_params.get("assets", []),
        "externalNativeLayer": True,
        "identifiable": True,
        "nativeLayerIds": [layer["id"]],
        "planetaryComputerLayerType": "item" if item else "mosaic",
        "renderParams": render_params,
        "sourceId": source_id,
        "sourceIds": [source_id],
        "sourceKind": PLANETARY_COMPUTER_SOURCE_KIND,
        "stacCollectionId": collection,
        "tileType": "raster",
    }
    if preset:
        metadata["presetName"] = preset
    if item:
        metadata["stacItemId"] = item
    if search is not None:
        metadata["stacSearchParams"] = search
    if bounds is not None:
        metadata["bounds"] = bounds
    layer["metadata"] = metadata
    layer["sourcePath"] = collection
    return layer


def _finite_number(value: Any, label: str) -> float:
    """Coerce a value to a finite float.

    Args:
        value: The value to coerce.
        label: The argument name, for the error message.

    Returns:
        The value as a float.

    Raises:
        ValueError: If the value is not a finite number.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} values must be numbers")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} values must be finite")
    return number


def _format_number(value: float) -> str:
    """Format a number without a trailing ``.0`` for whole values.

    Args:
        value: The number to format.

    Returns:
        ``"3000"`` for ``3000.0`` and ``"0.8"`` for ``0.8``.
    """
    return str(int(value)) if value == int(value) else repr(value)


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


def zarr_layer(
    name: str,
    url: str,
    variable: str,
    *,
    icechunk_branch: str | None = None,
    selector: dict[str, int | float | str] | None = None,
    clim: list[float] | None = None,
    colormap: str | None = None,
    bounds: list[float] | None = None,
    crs: str | None = None,
    spatial_dimensions: dict[str, str] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a Zarr data-cube layer the way ``createZarrStoreLayer`` saves one.

    The app re-adds it through the Zarr control when the project opens
    (``restoreZarrLayers``), which assigns the live layer a new id.

    Public Icechunk repositories retain their branch in the URL so the app can
    reopen their reader. Local stores still require a session-only reader.

    Args:
        name: Layer display name.
        url: An ``http(s)://``, ``s3://``, or ``gs://`` Zarr store URL.
            Google Storage URLs are saved as public HTTPS endpoints, preserving
            their query parameters so the app can reopen them.
        variable: The array to draw (e.g. ``"tas"``).
        icechunk_branch: Branch of a public HTTP(S) Icechunk repository, e.g.
            ``"main"``. Omit for a plain Zarr store. Encoded ``#icechunk=``
            URLs from saved projects are also accepted.
        selector: Non-spatial dimension values to slice, e.g.
            ``{"time": 0}`` or ``{"band": "B04"}``.
        clim: ``[min, max]`` color range.
        colormap: Colormap name (e.g. ``"viridis"``).
        bounds: ``[west, south, east, north]`` when the store lacks coordinates.
        crs: The store's CRS when it is not EPSG:4326 (e.g. ``"EPSG:3857"``).
        spatial_dimensions: Names of the spatial dimensions when they are not
            discoverable, e.g. ``{"lat": "y", "lon": "x"}``.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If the URL, branch, variable, or options are invalid, or the
            URL names a local store or embeds credentials.
    """
    if not isinstance(url, str) or not url.strip():
        raise ValueError("zarr_layer: url must be a non-empty string")
    store_url = url.strip()
    if re.match(r"^local(-zarr)?:", store_url):
        raise ValueError(
            "zarr_layer: local stores cannot be reopened from a project; use a public store URL"
        )
    if not re.match(r"^(https?|s3|gs)://", store_url, re.IGNORECASE):
        raise ValueError("zarr_layer: url must be http(s)://, s3://, or gs://")
    _assert_no_url_userinfo(store_url)
    if store_url.lower().startswith("gs://"):
        parts = urlsplit(store_url)
        if not parts.hostname:
            raise ValueError("zarr_layer: a gs:// URL must name a bucket")
        store_url = parts._replace(
            scheme="https", netloc="storage.googleapis.com", path=f"/{parts.netloc}{parts.path}"
        ).geturl()
    parts = urlsplit(store_url)
    if parts.fragment.startswith("icechunk="):
        encoded_branch = parts.fragment[len("icechunk=") :]
        if re.search(r"%(?![0-9a-fA-F]{2})", encoded_branch):
            raise ValueError("zarr_layer: invalid encoded Icechunk branch")
        try:
            saved_branch = unquote(encoded_branch, errors="strict")
        except UnicodeDecodeError as error:
            raise ValueError("zarr_layer: invalid encoded Icechunk branch") from error
        if icechunk_branch is not None and icechunk_branch != saved_branch:
            raise ValueError("zarr_layer: conflicting Icechunk branches")
        icechunk_branch = saved_branch
    if icechunk_branch is not None:
        if not isinstance(icechunk_branch, str) or not icechunk_branch.strip():
            raise ValueError("zarr_layer: icechunk_branch must be a non-empty string")
        if parts.scheme.lower() not in {"http", "https"}:
            raise ValueError("zarr_layer: an Icechunk repository requires an HTTP(S) URL")
        store_url = parts._replace(fragment="icechunk=" + quote(icechunk_branch, safe="")).geturl()
    if not isinstance(variable, str) or not variable.strip():
        raise ValueError("zarr_layer: variable must be a non-empty string")
    if selector is not None and (
        not isinstance(selector, dict)
        or not all(
            isinstance(key, str)
            and isinstance(value, (int, float, str))
            and (not isinstance(value, float) or math.isfinite(value))
            for key, value in selector.items()
        )
    ):
        raise ValueError("zarr_layer: selector must map dimension names to numbers or strings")
    if clim is not None:
        try:
            clim = [float(clim[0]), float(clim[1])] if len(clim) == 2 else None
        except (TypeError, ValueError, LookupError):
            clim = None
        if clim is None or not all(math.isfinite(value) for value in clim) or clim[0] >= clim[1]:
            raise ValueError("zarr_layer: clim must be [min, max] with min < max")
    if spatial_dimensions is not None and (
        not isinstance(spatial_dimensions, dict)
        or not set(spatial_dimensions) <= {"lat", "lon"}
        or not all(isinstance(value, str) and value for value in spatial_dimensions.values())
    ):
        raise ValueError('zarr_layer: spatial_dimensions takes "lat" and/or "lon" names')
    resolved_bounds = _resolve_bounds(bounds)
    style.setdefault("fillOpacity", 1)
    layer = _layer_base(name, "zarr", **style)
    source: dict[str, Any] = {
        "type": "raster",
        "url": store_url,
        "variable": variable.strip(),
        "selector": dict(selector or {}),
    }
    metadata: dict[str, Any] = {
        "externalNativeLayer": True,
        "identifiable": False,
        "nativeLayerIds": [layer["id"]],
        "paintMode": "plugin",
        "selector": dict(selector or {}),
        "sourceKind": "zarr-url",
        "tileType": "raster",
        "variable": variable.strip(),
    }
    if clim is not None:
        source["clim"] = clim
        metadata["clim"] = clim
    if colormap:
        source["colormap"] = colormap
        metadata["colormap"] = colormap
    if resolved_bounds is not None:
        source["bounds"] = resolved_bounds
    if crs:
        source["crs"] = crs
        metadata["crs"] = crs
    if spatial_dimensions:
        source["spatialDimensions"] = dict(spatial_dimensions)
    layer["source"] = source
    layer["metadata"] = metadata
    layer["sourcePath"] = store_url
    return layer
