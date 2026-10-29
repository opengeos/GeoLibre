"""Tests for Map.request_async() and the *_async() method variants.

These run without a browser: ``Map.send`` is stubbed to capture the outgoing
command, and the app's reply is delivered through ``_on_custom_msg`` exactly
as the front-end's would be -- asynchronously, and in one test from another
thread (which is how Shiny for Python delivers replies).
"""

from __future__ import annotations

import asyncio
import base64
import threading

import pytest

import geolibre.geolibre as gmod
from geolibre.geolibre import Map


@pytest.fixture
def m(monkeypatch):
    """A Map instance with the static server stubbed out (no bundle needed)."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def _result(request_id, value=None, ok=True, error=None):
    return {
        "type": "geolibre:result",
        "requestId": request_id,
        "ok": ok,
        "value": value,
        "error": error,
    }


def _capture_send(m, reply=None, reply_from_thread=False):
    """Stub ``m.send`` to capture the command and (optionally) answer it.

    Returns the list of captured command payloads. When ``reply`` is given
    (kwargs for :func:`_result`), it is delivered asynchronously -- from a
    timer thread when ``reply_from_thread`` is true, otherwise via the
    running event loop.
    """
    sent = []

    def fake_send(content):
        sent.append(content)
        if reply is None:
            return
        message = _result(content["requestId"], **reply)

        def deliver():
            m._on_custom_msg(None, message, None)

        if reply_from_thread:
            threading.Timer(0.05, deliver).start()
        else:
            asyncio.get_running_loop().call_soon(deliver)

    m.send = fake_send
    return sent


def test_get_center_async_round_trip(m):
    sent = _capture_send(m, reply={"value": [-122.4, 37.8]})

    assert asyncio.run(m.get_center_async()) == [-122.4, 37.8]
    assert sent[0]["type"] == "geolibre:command"
    assert sent[0]["method"] == "getCenter"
    # The slot is cleaned up once the reply lands.
    assert m._pending == {}


def test_request_async_reply_from_another_thread(m):
    # Shiny delivers comm replies on its own event loop/thread, so the
    # future must be woken via call_soon_threadsafe, not set directly.
    _capture_send(m, reply={"value": [1.0, 2.0]}, reply_from_thread=True)

    assert asyncio.run(m.get_center_async()) == [1.0, 2.0]


def test_request_async_timeout(m):
    _capture_send(m)  # never replies

    with pytest.raises(TimeoutError, match="timed out"):
        asyncio.run(m.get_center_async(timeout=0.05))
    assert m._pending == {}


def test_request_async_error_reply(m):
    _capture_send(m, reply={"ok": False, "error": "boom"})

    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(m.get_center_async())


def test_late_reply_after_timeout_is_ignored(m):
    sent = _capture_send(m)
    with pytest.raises(TimeoutError):
        asyncio.run(m.get_center_async(timeout=0.05))

    # A reply arriving after cleanup must be dropped quietly, and resolving
    # the cancelled future must not raise.
    m._on_custom_msg(None, _result(sent[0]["requestId"], value=[0, 0]), None)


def test_fly_to_async_builds_params(m):
    sent = _capture_send(m, reply={})

    asyncio.run(m.fly_to_async(-122.4, 37.8, zoom=9, duration=1000))

    assert sent[0]["method"] == "flyTo"
    assert sent[0]["params"] == {
        "center": [-122.4, 37.8],
        "zoom": 9.0,
        "duration": 1000.0,
    }


def test_fit_bounds_async_validates_before_sending(m):
    sent = _capture_send(m)

    with pytest.raises(ValueError, match="west <= east"):
        asyncio.run(m.fit_bounds_async([10, 0, -10, 5]))
    assert sent == []


def test_to_image_async_decodes_png(m):
    png = b"\x89PNG fake"
    data_url = "data:image/png;base64," + base64.b64encode(png).decode()
    _capture_send(m, reply={"value": data_url})

    assert asyncio.run(m.to_image_async()) == png


def test_sync_slot_still_filled_without_future(m):
    # The sync request() path registers slots with no "future" key;
    # _on_custom_msg must keep filling them, and drop duplicate replies
    # (resolving a done future would raise).
    slot = {"done": False, "ok": False, "value": None, "error": None}
    m._pending["abc"] = slot

    m._on_custom_msg(None, _result("abc", value=42), None)
    assert slot == {"done": True, "ok": True, "value": 42, "error": None}

    m._on_custom_msg(None, _result("abc", value=43), None)
    assert slot["value"] == 42
