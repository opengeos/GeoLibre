"""Popup and tooltip configuration for layers."""

from __future__ import annotations

import re
from typing import Any

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
