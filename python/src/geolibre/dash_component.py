"""Dash component wrapper for the GeoLibre map iframe."""

from __future__ import annotations

import uuid
from typing import Any

from . import project as _project
from ._server import app_port, serve_app
from .basemaps import resolve_basemap
from .geolibre import _STATIC_APP, _VALID_LAYOUTS, _VALID_THEMES

try:
    from dash.development.base_component import Component
except ImportError:  # pragma: no cover - Dash is an optional dependency
    Component = None  # type: ignore[assignment,misc]


_PROPERTIES = [
    "id",
    "className",
    "style",
    "center",
    "zoom",
    "basemap",
    "height",
    "layout",
    "theme",
    "clickData",
    "selectionData",
    "viewData",
    "project",
    "appUrl",
    "appPort",
    "setProps",
]


if Component is not None:

    class DashMap(Component):
        """A GeoLibre map usable directly in a Dash layout.

        Map interactions update ``clickData``, ``selectionData``, and (in a
        future release) ``viewData`` so they can be callback inputs.
        """

        _namespace = "geolibre"
        _type = "DashMap"
        _prop_names = _PROPERTIES
        _js_dist = [
            {
                "relative_package_path": "static/dash/geolibre.js",
                "namespace": "geolibre",
            }
        ]
        _css_dist: list[dict[str, Any]] = []
        _children_props: list[str] = []
        _base_nodes: set[str] = set()
        _valid_wildcard_attributes: list[str] = []

        def __init__(
            self,
            center: list[float] | tuple[float, float] | None = None,
            zoom: float | None = None,
            *,
            basemap: str | None = None,
            renderer: str = "maplibre",
            height: str = "800px",
            layout: str = "embed",
            theme: str = "light",
            id: str | None = None,
            className: str | None = None,
            style: dict[str, Any] | None = None,
            **kwargs: Any,
        ) -> None:
            if layout not in _VALID_LAYOUTS:
                raise ValueError(f"layout must be one of {sorted(_VALID_LAYOUTS)}, got {layout!r}")
            if theme not in _VALID_THEMES:
                raise ValueError(f"theme must be one of {sorted(_VALID_THEMES)}, got {theme!r}")
            if any(name in kwargs for name in ("clickData", "selectionData", "viewData")):
                raise TypeError("DashMap event properties are read-only")
            project = _project.build_empty_project(
                center=center,
                zoom=zoom,
                basemap_url=resolve_basemap(basemap) if basemap else None,
                renderer=renderer,
            )
            super().__init__(
                # Dash's component-object callback syntax needs an id. Generate
                # one when omitted so ``Input(m, "clickData")`` works exactly
                # like the documented usage.
                id=id or f"geolibre-map-{uuid.uuid4().hex}",
                className=className,
                style=style,
                center=list(center) if center is not None else None,
                zoom=zoom,
                basemap=basemap,
                height=height,
                layout=layout,
                theme=theme,
                project=project,
                appUrl=serve_app(_STATIC_APP),
                appPort=app_port() or 0,
                **kwargs,
            )

else:

    class DashMap:  # type: ignore[no-redef]
        """Placeholder providing an actionable error when Dash is absent."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise ImportError(
                "DashMap requires Dash. Install it with `pip install 'geolibre[dash]'`."
            )
