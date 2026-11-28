"""Standalone HTML export of a GeoLibre project."""

from __future__ import annotations

import html as _html
import json
import re
import urllib.parse
from typing import Any

from . import project as _project
from ._map_support import _VALID_LAYOUTS as _VALID_LAYOUTS
from ._map_support import _VALID_THEMES as _VALID_THEMES
from ._map_support import CHROME_TOGGLES, _chrome_query_flags


def _html_escape(value: str) -> str:
    """Escape a string for safe interpolation into HTML attributes/text."""
    return _html.escape(str(value), quote=True)


# A CSS length/percentage value (e.g. "100%", "800px", "calc(100% - 2rem)"). The
# allowed set deliberately excludes the structural CSS characters ("{};:") so a
# to_html() width/height cannot close the <style> rule and inject CSS.
_CSS_DIMENSION_RE = re.compile(r"^[\w%.+\-\s()]+$")


# Standalone export shell: an iframe hosting the GeoLibre app plus a script that
# replays the inlined project into it once the app announces it is ready, using
# the same postMessage protocol useEmbedBridge/useCommandBridge speak. The
# project is carried in a JSON <script> block rather than a JS string literal so
# it needs no JS-string escaping. {0}-style fields are filled by str.format, so
# literal CSS/JS braces are doubled.
_HTML_EXPORT_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title}</title>
<style>
  html, body {{ margin: 0; padding: 0; height: 100%; }}
  #geolibre-frame {{ border: 0; display: block; width: {width}; height: {height}; }}
</style>
</head>
<body>
<iframe id="geolibre-frame" src="{iframe_src}" allow="fullscreen" allowfullscreen></iframe>
<script type="application/json" id="geolibre-project">{project_json}</script>
<script>
(function () {{
  var frame = document.getElementById("geolibre-frame");
  var project = JSON.parse(
    document.getElementById("geolibre-project").textContent
  );
  var loaded = false;
  function load() {{
    if (loaded || !frame.contentWindow) return;
    loaded = true;
    frame.contentWindow.postMessage(
      {{ type: "geolibre:load-project", project: project, seq: 1 }},
      {app_origin}
    );
  }}
  // The app posts "geolibre:ready" once mounted; reply with the project. Guard
  // on the frame as the source so an unrelated message cannot trigger the load.
  window.addEventListener("message", function (event) {{
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (data && data.type === "geolibre:ready") load();
  }});
}})();
</script>
</body>
</html>
"""


# Where a standalone export loads the app from by default: the hosted viewer, so
# the exported file stays portable once the kernel is gone.
DEFAULT_HTML_APP_URL = "https://web.geolibre.app/"


def render_project_html(
    project: dict[str, Any],
    *,
    title: str = "GeoLibre Map",
    width: str = "100%",
    height: str = "800px",
    app_url: str | None = None,
    layout: str | None = None,
    theme: str | None = None,
    chrome: dict[str, bool | None] | None = None,
) -> str:
    """Render a project dict as a standalone HTML page.

    The page embeds the GeoLibre app in an ``<iframe>`` and injects the project
    into it over the same ``postMessage`` bridge the widget uses, so it renders
    the map as configured. Credentials are stripped from the inlined project on
    the way out, exactly as :meth:`Map.to_html` does.

    This is the widget-free half of :meth:`Map.to_html`; the MCP server calls it
    to export a project that was never attached to a live map.

    Args:
        project: The project dict to embed.
        title: The exported page's ``<title>``.
        width: CSS width of the embedded map (e.g. ``"100%"`` or ``"800px"``).
        height: CSS height of the embedded map.
        app_url: Base URL of the GeoLibre app to embed. Defaults to
            :data:`DEFAULT_HTML_APP_URL`.
        layout: The app chrome to embed with: ``"embed"``, ``"full"``, or
            ``"maponly"``, as for :class:`Map`. ``None`` leaves the app's
            default chrome.
        theme: ``"light"`` or ``"dark"``; ``None`` follows the viewer's OS.
        chrome: Show (``True``) or hide (``False``) single pieces of chrome,
            keyed ``toolbar``, ``layer_panel``, ``style_panel``, and
            ``status_bar``, as for :class:`Map`. A missing or ``None`` entry
            keeps the app's default. Environment variables are not consulted.

    Returns:
        The HTML document as a string.

    Raises:
        ValueError: If ``width`` or ``height`` is not a plain CSS dimension,
            ``app_url`` is not an ``http``/``https`` URL, or ``layout`` or
            ``theme`` is not a recognized value.
    """
    base_url = app_url or DEFAULT_HTML_APP_URL
    # The project is posted into the frame, so the app URL decides where it
    # lands. Pin it to http(s) with a real host, and post to that exact origin
    # rather than "*": the MCP server takes app_url straight from a tool call,
    # and a model can pick an argument up from content it is reading. A
    # redacted project still carries inlined features and layer URLs.
    origin = urllib.parse.urlsplit(base_url)
    if origin.scheme not in ("http", "https") or not origin.hostname:
        raise ValueError(f"to_html: app_url must be an http(s) URL, got {base_url!r}")
    origin_host = f"[{origin.hostname}]" if ":" in origin.hostname else origin.hostname
    default_port = 80 if origin.scheme == "http" else 443
    origin_port = (
        f":{origin.port}" if origin.port is not None and origin.port != default_port else ""
    )
    app_origin = f"{origin.scheme}://{origin_host}{origin_port}"
    # Strip any embedded credentials from base_url before building iframe_src
    # so userinfo never leaks into the exported HTML document.
    if origin.username is not None or origin.password is not None:
        safe_netloc = f"{origin_host}:{origin.port}" if origin.port is not None else origin_host
        base_url = urllib.parse.urlunsplit(
            (origin.scheme, safe_netloc, origin.path, origin.query, origin.fragment)
        )
    # Force the embed bridge on (isEmbedded() honours ?embed=1). Insert the
    # parameter into the query string *before* any URL fragment: a "#..."
    # fragment would otherwise swallow a trailing "?embed=1" (browsers read it
    # as part of the fragment), so the app never sees the flag. partition keeps
    # the fragment and its "#" intact when present and yields "" when absent.
    # The chrome flags ride along the same way, matching the query the widget
    # front-end builds, so the export looks like the notebook map (#2764).
    if layout is not None and layout not in _VALID_LAYOUTS:
        raise ValueError(f"to_html: layout must be one of {sorted(_VALID_LAYOUTS)}, got {layout!r}")
    if theme is not None and theme not in _VALID_THEMES:
        raise ValueError(f"to_html: theme must be one of {sorted(_VALID_THEMES)}, got {theme!r}")
    flags = ["embed=1"]
    if layout == "maponly":
        flags.append("maponly=1")
    elif layout == "embed":
        flags.append("layout=embed")
    if theme is not None:
        flags.append(f"theme={theme}")
    if chrome:
        unknown = set(chrome) - set(CHROME_TOGGLES)
        if unknown:
            raise ValueError(f"to_html: unknown chrome keys {sorted(unknown)}")
        for key, value in chrome.items():
            if value is not None and not isinstance(value, bool):
                raise TypeError(f"to_html: chrome[{key!r}] must be True, False, or None")
        flags.extend(_chrome_query_flags(chrome))
    base, hash_sep, fragment = base_url.partition("#")
    # A layout/theme key the app_url already sets wins, like the in-app
    # exporter's flags. embed=1 is forced: without embed mode the app never
    # accepts the posted project, and the app reads only the first "embed", so
    # an app_url "embed" that does not enable it is dropped rather than kept.
    path, query_sep, query = base.partition("?")
    kept = [
        pair
        for pair in query.split("&")
        if pair and not (pair.split("=", 1)[0] == "embed" and pair not in ("embed=1", "embed=true"))
    ]
    base = f"{path}{query_sep if kept else ''}{'&'.join(kept)}"
    preset = {pair.split("=", 1)[0] for pair in kept}
    flags = [flag for flag in flags if flag.split("=", 1)[0] not in preset]
    separator = "&" if "?" in base else "?"
    query = "&".join(flags)
    iframe_src = f"{base}{separator if query else ''}{query}{hash_sep}{fragment}"
    # width/height land inside a <style> rule; _html_escape does not neutralise
    # CSS metacharacters like "}" or ";", so validate them as plain CSS
    # dimensions to keep a stray value from closing the rule and injecting CSS.
    if not _CSS_DIMENSION_RE.match(width):
        raise ValueError(f"to_html: invalid CSS width value {width!r}")
    if not _CSS_DIMENSION_RE.match(height):
        raise ValueError(f"to_html: invalid CSS height value {height!r}")
    # Inline the project inside a JSON <script> block and escape "<" so a
    # property value can never break out of the script element; "<" is valid
    # JSON that JSON.parse restores to "<".
    project_json = json.dumps(_project.redact_credentials(project), allow_nan=False).replace(
        "<", "\\u003c"
    )
    return _HTML_EXPORT_TEMPLATE.format(
        title=_html_escape(title),
        width=_html_escape(width),
        height=_html_escape(height),
        iframe_src=_html_escape(iframe_src),
        project_json=project_json,
        # json.dumps supplies the surrounding quotes, so the template field is
        # the whole JS string literal.
        app_origin=json.dumps(app_origin),
    )
