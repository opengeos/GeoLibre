"""Read ICESat-2 and GEDI spaceborne LiDAR footprints from HDF5 granules.

This is the Python counterpart of the app's ICESat-2 / GEDI reader
(``packages/plugins/src/plugins/spaceborne-lidar.ts``) and follows the same
rules, so a layer built here looks like one added through Add Data in the app:

- ICESat-2 ATL06 (land ice height) and ATL08 (land and vegetation height),
  one footprint per along-track segment in each ground track ``gt1l``..``gt3r``.
- GEDI L2A (elevation and relative heights), L2B (canopy cover and vertical
  profile) and L4A (aboveground biomass density), one footprint per shot in
  each beam ``BEAM0000``..``BEAM1011``.

Each footprint becomes a GeoJSON point with the chosen fields plus ``beam``,
``beam_type`` (strong/weak or power/coverage), ``time`` (UTC) and
``distance_km`` (along-track distance from the first footprint of its beam).

Reading needs h5py and NumPy: ``pip install "geolibre[spaceborne]"``.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Sequence

# Seconds in delta_time count from the ICESat-2 / GEDI epoch.
_EPOCH = datetime(2018, 1, 1, tzinfo=timezone.utc)
_EARTH_RADIUS_M = 6_371_008.8
_ICESAT2_BEAMS = re.compile(r"^gt[123][lr]$")
_GEDI_BEAMS = re.compile(r"^BEAM\d{4}$")

#: Footprint cap used when none is given; a full GEDI orbit holds millions of shots.
DEFAULT_MAX_POINTS = 100_000


@dataclass(frozen=True)
class FieldSpec:
    """A dataset to read for every footprint, relative to the beam group.

    Attributes:
        path: Dataset path, e.g. ``"land_segments/terrain/h_te_best_fit"``.
        name: Property name; defaults to the path's last segment.
        column: Column of a 2-D dataset (GEDI ``rh`` is ``[shots, 101]``).
        scale: Multiplier applied to the stored value (GEDI L2B ``rh100`` is cm).
    """

    path: str
    name: str | None = None
    column: int | None = None
    scale: float | None = None

    @property
    def key(self) -> str:
        """The property name this field produces."""
        return self.name or self.path.rsplit("/", 1)[-1]


@dataclass(frozen=True)
class ProductSpec:
    """How to read one product: datasets, defaults and the quality rule."""

    id: str
    label: str
    mission: str
    beam_pattern: re.Pattern[str]
    lat: str
    lon: str
    time: str
    defaults: tuple[FieldSpec, ...]
    primary_field: str
    quality_paths: tuple[str, ...] = ()
    quality_keep: Any = None
    footprint: str = "segment"
    extra: dict[str, Any] = field(default_factory=dict)


def _keep_equals(target: float):
    return lambda value: value == target


PRODUCTS: dict[str, ProductSpec] = {
    "ATL06": ProductSpec(
        id="ATL06",
        label="ICESat-2 ATL06 Land Ice Height",
        mission="ICESat-2",
        beam_pattern=_ICESAT2_BEAMS,
        lat="land_ice_segments/latitude",
        lon="land_ice_segments/longitude",
        time="land_ice_segments/delta_time",
        defaults=(
            FieldSpec("land_ice_segments/h_li"),
            FieldSpec("land_ice_segments/h_li_sigma"),
            FieldSpec("land_ice_segments/fit_statistics/dh_fit_dx"),
            FieldSpec("land_ice_segments/fit_statistics/snr"),
        ),
        primary_field="h_li",
        quality_paths=("land_ice_segments/atl06_quality_summary",),
        quality_keep=_keep_equals(0),
    ),
    "ATL08": ProductSpec(
        id="ATL08",
        label="ICESat-2 ATL08 Land and Vegetation Height",
        mission="ICESat-2",
        beam_pattern=_ICESAT2_BEAMS,
        lat="land_segments/latitude",
        lon="land_segments/longitude",
        time="land_segments/delta_time",
        defaults=(
            FieldSpec("land_segments/terrain/h_te_best_fit"),
            FieldSpec("land_segments/canopy/h_canopy"),
            FieldSpec("land_segments/canopy/canopy_openness"),
            FieldSpec("land_segments/terrain/terrain_slope"),
            FieldSpec("land_segments/night_flag"),
            FieldSpec("land_segments/segment_landcover"),
        ),
        primary_field="h_te_best_fit",
        # ATL08 has no quality flag; keep segments with a valid terrain height.
        quality_paths=("land_segments/terrain/h_te_best_fit",),
        quality_keep=lambda value: True,
    ),
    "GEDI_L2A": ProductSpec(
        id="GEDI_L2A",
        label="GEDI L2A Elevation and Height Metrics",
        mission="GEDI",
        beam_pattern=_GEDI_BEAMS,
        lat="lat_lowestmode",
        lon="lon_lowestmode",
        time="delta_time",
        defaults=(
            FieldSpec("elev_lowestmode"),
            FieldSpec("rh", name="rh50", column=50),
            FieldSpec("rh", name="rh75", column=75),
            FieldSpec("rh", name="rh98", column=98),
            FieldSpec("rh", name="rh100", column=100),
            FieldSpec("sensitivity"),
            FieldSpec("num_detectedmodes"),
        ),
        primary_field="rh98",
        # Version 3 renamed quality_flag to l2a_quality_flag_rel3.
        quality_paths=("quality_flag", "l2a_quality_flag_rel3"),
        quality_keep=_keep_equals(1),
        footprint="shot",
    ),
    "GEDI_L2B": ProductSpec(
        id="GEDI_L2B",
        label="GEDI L2B Canopy Cover and Vertical Profile",
        mission="GEDI",
        beam_pattern=_GEDI_BEAMS,
        lat="geolocation/lat_lowestmode",
        lon="geolocation/lon_lowestmode",
        time="geolocation/delta_time",
        defaults=(
            FieldSpec("cover"),
            FieldSpec("pai"),
            FieldSpec("fhd_normal"),
            FieldSpec("rh100", scale=0.01),
            FieldSpec("geolocation/elev_lowestmode"),
            FieldSpec("sensitivity"),
        ),
        primary_field="cover",
        quality_paths=("l2b_quality_flag",),
        quality_keep=_keep_equals(1),
        footprint="shot",
    ),
    "GEDI_L4A": ProductSpec(
        id="GEDI_L4A",
        label="GEDI L4A Aboveground Biomass Density",
        mission="GEDI",
        beam_pattern=_GEDI_BEAMS,
        lat="lat_lowestmode",
        lon="lon_lowestmode",
        time="delta_time",
        defaults=(
            FieldSpec("agbd"),
            FieldSpec("agbd_se"),
            FieldSpec("elev_lowestmode"),
            FieldSpec("sensitivity"),
        ),
        primary_field="agbd",
        quality_paths=("l4_quality_flag",),
        quality_keep=_keep_equals(1),
        footprint="shot",
    ),
}

_SHORT_NAMES = {
    "ATL06": "ATL06",
    "ATL08": "ATL08",
    "GEDI_L2A": "GEDI_L2A",
    "GEDI02_A": "GEDI_L2A",
    "GEDI_L2B": "GEDI_L2B",
    "GEDI02_B": "GEDI_L2B",
    "GEDI_L4A": "GEDI_L4A",
    "GEDI04_A": "GEDI_L4A",
}


def _require_h5py():
    """Import h5py and NumPy, or explain how to install them.

    Returns:
        The ``(h5py, numpy)`` modules.

    Raises:
        ImportError: When either is missing.
    """
    try:
        import h5py
        import numpy as np
    except ImportError as exc:  # pragma: no cover - exercised without the extra
        raise ImportError(
            "Reading ICESat-2 / GEDI granules requires h5py and NumPy. "
            'Install them with `pip install "geolibre[spaceborne]"`.'
        ) from exc
    return h5py, np


def detect_product(short_name: str | None, file_name: str | None = None) -> str | None:
    """Identify a product from a ``short_name`` attribute or a file name.

    Args:
        short_name: The granule's ``short_name`` attribute, if any.
        file_name: The file name, used when the attribute is missing.

    Returns:
        The product id (``"ATL06"``, ``"ATL08"``, ``"GEDI_L2A"``,
        ``"GEDI_L2B"`` or ``"GEDI_L4A"``), or None when neither names one.
    """
    if short_name:
        found = _SHORT_NAMES.get(str(short_name).strip().upper())
        if found:
            return found
    base = os.path.basename(file_name or "").upper()
    if base.startswith("ATL06"):
        return "ATL06"
    if base.startswith("ATL08"):
        return "ATL08"
    # ORNL DAAC prefixes L4A names with the collection, so search, not anchor.
    if "GEDI02_A" in base:
        return "GEDI_L2A"
    if "GEDI02_B" in base:
        return "GEDI_L2B"
    if "GEDI04_A" in base:
        return "GEDI_L4A"
    return None


def _string_attr(obj: Any, name: str) -> str | None:
    value = obj.attrs.get(name) if obj is not None else None
    if value is None:
        return None
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    return str(value) if value is not None else None


def _get(group: Any, path: str):
    try:
        return group[path]
    except KeyError:
        return None


def _granule_short_name(handle: Any) -> str | None:
    name = _string_attr(handle, "short_name")
    if name:
        return name
    ident = _get(handle, "METADATA/DatasetIdentification")
    return _string_attr(ident, "shortName")


def _is_fill(np: Any, values: Any, fill: float | None, mission: str):
    """Boolean mask of fill values, mirroring the app's rule."""
    with np.errstate(invalid="ignore"):
        mask = ~np.isfinite(values) | (np.abs(values) >= 1e38)
        if fill is not None:
            mask |= values == fill
        if mission == "GEDI":
            mask |= (values == -9999) | (values == -999999)
    return mask


def _fill_value(dataset: Any) -> float | None:
    value = dataset.attrs.get("_FillValue")
    if value is None:
        return None
    try:
        return float(value.item() if hasattr(value, "item") else value)
    except (TypeError, ValueError):
        return None


def _round_sig(value: float, digits: int = 7) -> float:
    if value == 0 or not math.isfinite(value):
        return value
    return float(f"{value:.{digits}g}")


def _iso_time(seconds: float) -> str | None:
    if not math.isfinite(seconds) or abs(seconds) > 1e10:
        return None
    moment = _EPOCH + timedelta(seconds=float(seconds))
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _along_track_km(np: Any, lat: Any, lon: Any):
    """Cumulative haversine distance per footprint, in km (4 decimals)."""
    out = np.zeros(len(lat), dtype=np.float64)
    total = 0.0
    prev = None
    for i in range(len(lat)):
        la, lo = float(lat[i]), float(lon[i])
        if not _valid_coordinate(lo, la):
            out[i] = total
            continue
        if prev is not None:
            p_la, p_lo = prev
            d_la = math.radians(la - p_la)
            d_lo = math.radians(lo - p_lo)
            a = (
                math.sin(d_la / 2) ** 2
                + math.cos(math.radians(p_la))
                * math.cos(math.radians(la))
                * math.sin(d_lo / 2) ** 2
            )
            total += 2 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))
        prev = (la, lo)
        out[i] = total
    return np.round(out / 1000.0, 4)


def _valid_coordinate(lon: float, lat: float) -> bool:
    return math.isfinite(lon) and math.isfinite(lat) and abs(lat) <= 90 and abs(lon) <= 180


def _bbox_mask(np: Any, lon: Any, lat: Any, bbox: Sequence[float]):
    west, south, east, north = (float(v) for v in bbox)
    lat_ok = (lat >= south) & (lat <= north)
    if east - west >= 360:
        return lat_ok
    if west > east:  # crosses the antimeridian
        return lat_ok & ((lon >= west) | (lon <= east))
    if east > 180:  # unwrapped east edge
        wrapped = np.where(lon < west, lon + 360, lon)
        return lat_ok & (wrapped >= west) & (wrapped <= east)
    return lat_ok & (lon >= west) & (lon <= east)


def _beam_type(spec: ProductSpec, group: Any) -> str | None:
    if spec.mission == "ICESat-2":
        value = _string_attr(group, "atlas_beam_type")
        return value.lower() if value else None
    description = (_string_attr(group, "description") or "").lower()
    if "power" in description:
        return "power"
    if "coverage" in description:
        return "coverage"
    return None


def _resolve_fields(spec: ProductSpec, fields: Iterable[Any] | None) -> list[FieldSpec]:
    """Turn user field choices (names, paths, FieldSpecs) into FieldSpecs."""
    if fields is None:
        return list(spec.defaults)
    by_name = {f.key: f for f in spec.defaults}
    resolved: list[FieldSpec] = []
    for item in fields:
        if isinstance(item, FieldSpec):
            resolved.append(item)
        elif isinstance(item, str):
            resolved.append(by_name.get(item, FieldSpec(item)))
        else:
            raise TypeError(f"A field must be a name, a dataset path or a FieldSpec, not {item!r}.")
    return resolved


@dataclass
class SpaceborneLidarResult:
    """Footprints read from a granule, with counts for reporting.

    Attributes:
        product: The product id.
        geojson: A FeatureCollection of points.
        total: Footprints in the chosen beams.
        matched: Footprints that passed the quality and extent filters.
        kept: Footprints in ``geojson`` after thinning to ``max_points``.
        stride: The thinning step (1 when nothing was dropped).
        per_beam: ``{beam: kept}``.
    """

    product: str
    geojson: dict[str, Any]
    total: int
    matched: int
    kept: int
    stride: int
    per_beam: dict[str, int]

    @property
    def spec(self) -> ProductSpec:
        """The product's reading rules."""
        return PRODUCTS[self.product]


def read_spaceborne_lidar(
    source: str | os.PathLike[str],
    *,
    product: str | None = None,
    beams: Sequence[str] | None = None,
    fields: Iterable[Any] | None = None,
    quality_filter: bool = True,
    bbox: Sequence[float] | None = None,
    max_points: int | None = DEFAULT_MAX_POINTS,
) -> SpaceborneLidarResult:
    """Read an ICESat-2 or GEDI granule's footprints as GeoJSON points.

    Args:
        source: Path to the HDF5 granule.
        product: Product id; detected from the granule when omitted.
        beams: Beam or ground-track groups to read (all by default).
        fields: Fields to attach: default-field names (``"rh98"``), dataset
            paths relative to the beam group, or :class:`FieldSpec` objects.
            The product's default fields when omitted.
        quality_filter: Drop footprints the product's quality flag rejects.
        bbox: ``[west, south, east, north]`` to keep only footprints inside.
        max_points: Cap on footprints; each beam is thinned evenly to stay
            under it. ``None`` or ``0`` keeps every footprint.

    Returns:
        The footprints and counts.

    Raises:
        ImportError: Without h5py / NumPy.
        ValueError: For an unsupported product or a granule with no footprints.
    """
    h5py, np = _require_h5py()
    path = os.fspath(source)
    with h5py.File(path, "r") as handle:
        product_id = product or detect_product(_granule_short_name(handle), path)
        if product_id not in PRODUCTS:
            raise ValueError(
                f"{os.path.basename(path)} is not an ICESat-2 ATL06/ATL08 or GEDI "
                "L2A/L2B/L4A granule."
            )
        spec = PRODUCTS[product_id]
        all_beams = []
        for name in sorted(handle.keys()):
            group = handle[name]
            if not spec.beam_pattern.match(name) or not isinstance(group, h5py.Group):
                continue
            lat_ds = _get(group, spec.lat)
            # ATL08 omits land_segments on a beam that crossed no land.
            if lat_ds is None or lat_ds.shape[0] == 0:
                continue
            all_beams.append(name)
        if not all_beams:
            raise ValueError(f"{os.path.basename(path)} has no beams with footprints.")
        chosen = list(all_beams) if beams is None else [b for b in all_beams if b in set(beams)]
        if beams is not None and not chosen:
            raise ValueError(f"None of the beams {list(beams)} exist; the granule has {all_beams}.")
        field_specs = _resolve_fields(spec, fields)

        # First pass: the indices each beam keeps after the quality and bbox filters.
        per_beam_data = []
        total = 0
        matched_total = 0
        for name in chosen:
            group = handle[name]
            lat = np.asarray(group[spec.lat][()], dtype=np.float64)
            lon = np.asarray(group[spec.lon][()], dtype=np.float64)
            total += len(lat)
            keep = np.array([_valid_coordinate(x, y) for x, y in zip(lon, lat)], dtype=bool)
            if quality_filter:
                for quality_path in spec.quality_paths:
                    flag_ds = _get(group, quality_path)
                    if flag_ds is None:
                        continue
                    flags = np.asarray(flag_ds[()], dtype=np.float64)
                    fill = _fill_value(flag_ds)
                    keep &= ~_is_fill(np, flags, fill, spec.mission)
                    keep &= np.array([bool(spec.quality_keep(v)) for v in flags], dtype=bool)
                    break
            if bbox is not None:
                keep &= _bbox_mask(np, lon, lat, bbox)
            indices = np.flatnonzero(keep)
            matched_total += len(indices)
            per_beam_data.append((name, group, lat, lon, indices))

        stride = 1
        if max_points and matched_total > max_points:
            stride = math.ceil(matched_total / max_points)

        features: list[dict[str, Any]] = []
        per_beam: dict[str, int] = {}
        offset = 0
        for name, group, lat, lon, indices in per_beam_data:
            selected = indices[(offset + np.arange(len(indices))) % stride == 0]
            offset += len(indices)
            per_beam[name] = int(len(selected))
            if len(selected) == 0:
                continue
            distance = _along_track_km(np, lat, lon)
            time_ds = _get(group, spec.time)
            times = np.asarray(time_ds[()], dtype=np.float64) if time_ds is not None else None
            beam_type = _beam_type(spec, group)
            columns = _read_columns(np, group, field_specs, selected, spec.mission)
            for row, index in enumerate(selected):
                properties: dict[str, Any] = {
                    "beam": name,
                    "beam_type": beam_type,
                    "time": _iso_time(float(times[index])) if times is not None else None,
                    "distance_km": float(distance[index]),
                }
                for key, values in columns:
                    properties[key] = values[row]
                features.append(
                    {
                        "type": "Feature",
                        # A stable id lets the app select a footprint (and link
                        # it to the along-track profile) unambiguously.
                        "id": len(features),
                        "geometry": {
                            "type": "Point",
                            "coordinates": [
                                round(float(lon[index]), 7),
                                round(float(lat[index]), 7),
                            ],
                        },
                        "properties": properties,
                    }
                )

    return SpaceborneLidarResult(
        product=product_id,
        geojson={"type": "FeatureCollection", "features": features},
        total=total,
        matched=matched_total,
        kept=len(features),
        stride=stride,
        per_beam=per_beam,
    )


def _read_columns(np: Any, group: Any, specs: list[FieldSpec], selected: Any, mission: str):
    """Read each field at the selected indices as JSON-ready lists."""
    out: list[tuple[str, list[Any]]] = []
    used: set[str] = set()
    for spec in specs:
        dataset = _get(group, spec.path)
        if dataset is None or dataset.dtype.kind not in "iuf":
            continue
        if dataset.ndim == 2:
            if spec.column is None or not 0 <= spec.column < dataset.shape[1]:
                continue
            raw = np.asarray(dataset[:, spec.column])
        elif dataset.ndim == 1 and spec.column is None:
            raw = np.asarray(dataset[()])
        else:
            continue
        key = spec.key
        if key in used:  # a later duplicate keeps its full path
            key = spec.path.replace("/", "_") + (
                f"_{spec.column}" if spec.column is not None else ""
            )
        used.add(key)
        fill = _fill_value(dataset)
        picked = raw[selected]
        if raw.dtype.kind in "iu" and raw.dtype.itemsize == 8:
            # 64-bit integers (GEDI shot_number) do not fit a double exactly.
            fill_int = int(fill) if fill is not None else None
            out.append(
                (
                    key,
                    [
                        None if fill_int is not None and int(v) == fill_int else str(int(v))
                        for v in picked
                    ],
                )
            )
            continue
        values = picked.astype(np.float64)
        mask = _is_fill(np, values, fill, mission)
        if spec.scale is not None:
            values = values * spec.scale
        round_values = raw.dtype == np.float32 or spec.scale is not None
        column: list[Any] = []
        for value, is_fill in zip(values, mask):
            if is_fill:
                column.append(None)
            elif round_values:
                column.append(_round_sig(float(value)))
            elif raw.dtype.kind in "iu":
                column.append(int(value))
            else:
                column.append(float(value))
        out.append((key, column))
    return out


#: ``metadata.sourceKind`` of a footprint layer, shared with the app.
SOURCE_KIND = "spaceborne-lidar"
#: Point radius for footprint layers: dense tracks read better small.
FOOTPRINT_RADIUS = 3


def spaceborne_lidar_layer(
    source: str | os.PathLike[str],
    name: str | None = None,
    *,
    missions: Sequence[str] | None = None,
    product: str | None = None,
    beams: Sequence[str] | None = None,
    fields: Iterable[Any] | None = None,
    quality_filter: bool = True,
    bbox: Sequence[float] | None = None,
    max_points: int | None = DEFAULT_MAX_POINTS,
    color_by: str | None = None,
    colormap: str = "viridis",
    class_count: int = 7,
    scheme: str = "quantile",
    **style: Any,
) -> tuple[dict[str, Any], SpaceborneLidarResult]:
    """Build a GeoJSON point layer from an ICESat-2 or GEDI granule.

    The layer matches one added through the app's Add Data → ICESat-2 / GEDI:
    small points, graduated colors on the product's main field (or
    ``color_by``), and ``metadata.sourceKind == "spaceborne-lidar"``.

    Args:
        source: Path to the HDF5 granule.
        name: Layer name; ``"<product> <file name>"`` by default.
        missions: Accepted missions (``"ICESat-2"``, ``"GEDI"``); any when None.
        product, beams, fields, quality_filter, bbox, max_points: See
            :func:`read_spaceborne_lidar`.
        color_by: Field to color by; the product's main field by default. Pass
            ``""`` for a single color.
        colormap: Color ramp for the graduated colors.
        class_count: Number of color classes.
        scheme: ``"quantile"`` or ``"equal-interval"``.
        **style: Style overrides (e.g. ``circleRadius``, ``fillColor``).

    Returns:
        The layer dict and the read result.

    Raises:
        ValueError: For a granule of another mission, or no footprints kept.
    """
    from . import authoring as _authoring
    from . import project as _project

    result = read_spaceborne_lidar(
        source,
        product=product,
        beams=beams,
        fields=fields,
        quality_filter=quality_filter,
        bbox=bbox,
        max_points=max_points,
    )
    spec = result.spec
    if missions is not None and spec.mission not in missions:
        raise ValueError(
            f"{os.path.basename(os.fspath(source))} is a {spec.mission} {spec.id} granule, "
            f"not {' or '.join(missions)}."
        )
    if result.kept == 0:
        raise ValueError(
            "No footprints passed the filters. Turn off quality_filter, widen the "
            "bbox, or pick other beams."
        )
    layer_style: dict[str, Any] = {"circleRadius": FOOTPRINT_RADIUS}
    color_field = spec.primary_field if color_by is None else color_by
    if color_field:
        values = [f["properties"].get(color_field) for f in result.geojson["features"]]
        try:
            layer_style.update(
                _authoring.build_choropleth_style(
                    values, color_field, class_count=class_count, colormap=colormap, scheme=scheme
                )
            )
        except ValueError:
            # A field with no numeric values keeps a single color.
            pass
    layer_style.update(style)
    stem = os.path.splitext(os.path.basename(os.fspath(source)))[0]
    layer = _project.geojson_layer(name or f"{spec.id} {stem}", result.geojson, **layer_style)
    layer["metadata"] = {
        **layer.get("metadata", {}),
        "sourceKind": SOURCE_KIND,
        "product": spec.id,
        "beams": sorted(result.per_beam),
    }
    return layer, result
