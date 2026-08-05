"""Tests for the bundled Jupyter Server config the desktop Notebook panel uses.

The panel embeds this server in an ``<iframe>`` from the Tauri webview's origin,
so the ``frame-ancestors`` list in the config is the single thing standing
between a healthy server and Chromium's "127.0.0.1 refused to connect." in the
panel. It is also easy to get wrong per-platform and impossible to notice from
the server side, since a refused frame looks like a perfectly healthy server in
every log -- hence these tests.
"""

from __future__ import annotations

from pathlib import Path

import pytest

CONFIG_PATH = Path(__file__).resolve().parents[1] / "jupyter_server_config.py"


class _Section:
    """Auto-vivifying stand-in for a traitlets Config section."""

    def __init__(self):
        self._values = {}

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self._values.setdefault(name, _Section())

    def __setattr__(self, name, value):
        if name.startswith("_"):
            super().__setattr__(name, value)
        else:
            self._values[name] = value


@pytest.fixture(scope="module")
def config():
    """Evaluate the real config file with a stubbed ``get_config``.

    Executing it rather than reading its text means the assertions below cover
    the value Jupyter would actually serve, not the spelling of a literal.
    """
    section = _Section()
    namespace = {"get_config": lambda: section, "__file__": str(CONFIG_PATH)}
    exec(compile(CONFIG_PATH.read_text(encoding="utf-8"), str(CONFIG_PATH), "exec"), namespace)
    return section


@pytest.fixture(scope="module")
def frame_ancestors(config):
    policy = config.ServerApp.tornado_settings["headers"]["Content-Security-Policy"]
    directive, _, value = policy.partition(" ")
    assert directive == "frame-ancestors", policy
    return value.split()


@pytest.mark.parametrize(
    "origin",
    [
        # macOS and Linux.
        "tauri://localhost",
        # Windows. Tauri v2's `useHttpsScheme` defaults to false, so the real
        # origin is the http one; v1 served https, and the config listed only
        # that, which is what broke the panel on Windows. Both stay listed so
        # turning `useHttpsScheme` on cannot silently break it again.
        "http://tauri.localhost",
        "https://tauri.localhost",
        # Dev servers and the loopback the server itself is bound to.
        "http://localhost:*",
        "http://127.0.0.1:*",
    ],
)
def test_permits_every_origin_the_panel_can_be_embedded_from(frame_ancestors, origin):
    assert origin in frame_ancestors


def test_does_not_open_framing_to_the_whole_web(frame_ancestors):
    # A stray `*` or `https:` here would let any site frame a token-bearing
    # local server, so the list must stay an explicit allowlist.
    assert "*" not in frame_ancestors
    assert "https:" not in frame_ancestors
    assert "http:" not in frame_ancestors


def test_never_opens_a_browser_on_the_host(config):
    # The app embeds the URL itself; a spawned browser would leak the token
    # into the user's normal profile and history.
    assert config.ServerApp.open_browser is False
