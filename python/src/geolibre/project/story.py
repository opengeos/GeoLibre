"""Story maps and bookmarks."""

from __future__ import annotations

import copy
import math
import time
import uuid
from typing import Any

from ._constants import _PROJECT_CONSTANTS
from .plugins import CONTROL_POSITIONS

#: Loaded from ``project-constants.json`` (shared with ``@geolibre/core``).
DEFAULT_STORY_MAP: dict[str, Any] = copy.deepcopy(_PROJECT_CONSTANTS["DEFAULT_STORY_MAP"])


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


#: Bookmarks the app keeps per project (``MAX_PROJECT_BOOKMARKS`` in project.ts);
#: any past this are dropped when the project is opened.
MAX_BOOKMARKS = 500


def bookmark_folder(
    name: str, *, collapsed: bool = False, folder_id: str | None = None
) -> dict[str, Any]:
    """Build one Bookmarks panel folder (``ProjectBookmarkGroup`` in types.ts).

    Args:
        name: Folder name shown in the panel.
        collapsed: Start with the folder collapsed.
        folder_id: Explicit folder id; a UUID by default.

    Returns:
        A folder dict.

    Raises:
        ValueError: If ``name`` is blank or ``collapsed`` is not a bool.
    """
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"folder name must be a non-empty string, got {name!r}")
    if not isinstance(collapsed, bool):
        raise ValueError("collapsed must be true or false")
    folder_id = str(folder_id).strip() if folder_id is not None else str(uuid.uuid4())
    if not folder_id:
        raise ValueError("folder_id must not be empty")
    return {"id": folder_id, "name": name.strip(), "collapsed": collapsed}


def bookmark(
    name: str,
    *,
    center: tuple[float, float] | list[float],
    zoom: float,
    pitch: float = 0,
    bearing: float = 0,
    group_id: str | None = None,
    visible_layer_ids: list[str] | None = None,
    bookmark_id: str | None = None,
    created_at: int | None = None,
) -> dict[str, Any]:
    """Build one saved map view for the Bookmarks panel (``ProjectBookmark``).

    Values are stored the way ``normalizeBookmarks`` in project.ts leaves them,
    so the app loads the bookmark unchanged: the bearing is wrapped into 0-360,
    and out-of-range coordinates, zooms, and pitches are refused rather than
    silently clamped.

    Args:
        name: Bookmark name shown in the panel.
        center: Camera target as ``(lng, lat)``.
        zoom: Camera zoom, 0-24.
        pitch: Camera tilt in degrees, 0-85.
        bearing: Camera rotation in degrees.
        group_id: Id of the folder it belongs to; ungrouped when omitted.
        visible_layer_ids: Layer ids to show when the bookmark is opened (all
            others are hidden). Omit to leave layer visibility alone.
        bookmark_id: Explicit bookmark id; a UUID by default.
        created_at: Creation time in milliseconds since the epoch; now by default.

    Returns:
        A bookmark dict.

    Raises:
        ValueError: If any value is out of range or of the wrong type.
    """
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"bookmark name must be a non-empty string, got {name!r}")
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
    bookmark_id = str(bookmark_id).strip() if bookmark_id is not None else str(uuid.uuid4())
    if not bookmark_id:
        raise ValueError("bookmark_id must not be empty")
    if created_at is None:
        created_at = int(time.time() * 1000)
    elif not isinstance(created_at, int) or isinstance(created_at, bool) or created_at < 0:
        raise ValueError(f"created_at must be a non-negative integer, got {created_at!r}")

    entry: dict[str, Any] = {
        "id": bookmark_id,
        "name": name.strip(),
        "lng": lng,
        "lat": lat,
        "zoom": zoom,
        "pitch": pitch,
        "bearing": bearing % 360,
        "createdAt": created_at,
    }
    if group_id is not None:
        entry["groupId"] = str(group_id)
    if visible_layer_ids is not None:
        if not isinstance(visible_layer_ids, (list, tuple)) or not all(
            isinstance(layer_id, str) for layer_id in visible_layer_ids
        ):
            raise ValueError("visible_layer_ids must be a list of layer id strings")
        entry["extra"] = {"visibleLayerIds": list(visible_layer_ids)}
    return entry
