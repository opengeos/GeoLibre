"""Map methods for widget messages, requests and event callbacks."""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
import warnings
from collections.abc import Callable
from typing import Any


class _MapEventsMixin:
    """Map methods for widget messages, requests and event callbacks."""

    def _on_custom_msg(self, _widget: Any, content: Any, _buffers: Any) -> None:
        """Handle out-of-band messages from the app (results and events).

        Args:
            _widget: The widget instance (unused; required by the on_msg API).
            content: The decoded message payload.
            _buffers: Binary buffers (unused).
        """
        if not isinstance(content, dict):
            return
        msg_type = content.get("type")
        if msg_type == "geolibre:result":
            slot = self._pending.get(content.get("requestId"))
            if slot is None or slot["done"]:
                # A reply for a request that already timed out / was cleaned
                # up, or a duplicate reply.
                return
            slot["ok"] = bool(content.get("ok"))
            slot["value"] = content.get("value")
            slot["error"] = content.get("error")
            slot["done"] = True
            future = slot.get("future")
            if future is not None:
                # Async request: wake the awaiting coroutine on its own loop.
                # Replies may arrive on any thread (the Jupyter kernel's,
                # Shiny's event loop, ...), so go through call_soon_threadsafe.
                try:
                    future.get_loop().call_soon_threadsafe(self._resolve_future, future)
                except RuntimeError:
                    # The awaiting coroutine's loop already closed.
                    pass
        elif msg_type == "geolibre:event":
            self._dispatch_event(content.get("event"), content.get("payload"))

    @staticmethod
    def _resolve_future(future: asyncio.Future) -> None:
        """Resolve a pending async-request future, if nobody beat us to it.

        A future can already be done when its waiter timed out
        (``asyncio.wait_for`` cancels it) but the reply arrived anyway.
        """
        if not future.done():
            future.set_result(None)

    def _dispatch_event(self, event: Any, payload: Any) -> None:
        """Invoke every callback registered for an event, isolating failures."""
        for handler in list(self._event_handlers.get(event, ())):
            try:
                handler(payload)
            except Exception as exc:  # noqa: BLE001 - never let one callback kill the bus
                warnings.warn(
                    f"GeoLibre event handler for {event!r} raised: {exc}",
                    stacklevel=2,
                )

    @staticmethod
    def _wait_for_result(slot: dict[str, Any], method: str, timeout: float) -> None:
        """Block until a result slot resolves or the timeout elapses.

        Jupyter comms are asynchronous, so the kernel must keep processing
        incoming messages while the calling cell blocks. ``jupyter_ui_poll``
        pumps the kernel's event loop re-entrantly (handling the ipykernel
        version differences) so the ``on_msg`` reply lands and fills the slot.

        Outside Jupyter there is no kernel to pump (e.g., inside a Shiny app,
        where the reply is delivered by the app's asyncio event loop). Blocking
        is then only legitimate on a thread that is not running an event loop
        (e.g., a worker thread), which keeps the loop that delivers the reply
        free; a plain sleep-poll is enough. Blocking a thread that is running
        an event loop would deadlock, so that case raises instead.

        Args:
            slot: The pending request slot, resolved in place by ``_on_custom_msg``.
            method: Command name, for error messages.
            timeout: Seconds to wait before giving up.

        Raises:
            TimeoutError: If no reply arrives within ``timeout`` seconds.
            RuntimeError: If no kernel pump is available and the calling
                thread is running an asyncio event loop.
        """
        try:
            from jupyter_ui_poll import ui_events
        except ImportError:
            ui_events = None  # type: ignore[assignment]

        deadline = time.monotonic() + timeout

        def _check_deadline() -> None:
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"GeoLibre command {method!r} timed out after {timeout}s. "
                    "The map must be displayed and loaded before it can "
                    "answer; show the map, then retry or pass a larger "
                    "timeout=. Outside Jupyter and Shiny, the reply must come "
                    "from a running app on another thread."
                )

        if ui_events is not None:
            # Only entering the pump is guarded: an AttributeError or
            # RuntimeError raised later (by poll() or a reply handler) is a real
            # failure and must reach the caller instead of being swallowed.
            with contextlib.ExitStack() as stack:
                try:
                    poll = stack.enter_context(ui_events())
                except (AttributeError, RuntimeError):
                    # No live kernel for ui_events to pump (e.g., inside a Shiny
                    # app). Fall through to the kernel-free path below.
                    poll = None
                if poll is not None:
                    while not slot["done"]:
                        # Check before and after pumping: a slow poll() with a
                        # large event backlog could otherwise overrun a very
                        # small timeout.
                        _check_deadline()
                        poll(10)
                        if slot["done"]:
                            break
                        _check_deadline()
                        # 20 Hz: imperceptible latency, far less CPU than a 100
                        # Hz spin (jupyter_ui_poll already pumps 10 kernel
                        # events per iteration).
                        time.sleep(0.05)
                    return

        # No kernel pump available. The reply arrives via an event loop on
        # another thread, so blocking is only safe when this thread is not
        # itself running an event loop.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass  # No loop on this thread (e.g., a worker thread): safe to block.
        else:
            raise RuntimeError(
                f"GeoLibre's {method}() blocks until the running app replies, "
                "but this thread is running the event loop that would deliver "
                "the reply, so waiting here would deadlock. In Jupyter, "
                "install 'jupyter_ui_poll' to pump the kernel's event loop "
                "instead. In Shiny, call blocking methods from a worker "
                "thread -- e.g., inside `reactive.extended_task`, via "
                "`asyncio.get_running_loop().run_in_executor(None, ...)` -- "
                "or use a non-blocking alternative (e.g., set_center() "
                "instead of fly_to(), or read the synced `project` trait "
                "instead of get_center())."
            )
        while not slot["done"]:
            _check_deadline()
            time.sleep(0.05)

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 10.0,
    ) -> Any:
        """Send a command to the running app and block for its reply.

        This is the low-level primitive behind the query/processing methods; call
        it directly to reach a command without a dedicated wrapper.

        Args:
            method: The command name (e.g. ``"getCenter"``).
            params: Command parameters.
            timeout: Seconds to wait for the reply.

        Returns:
            The command's result value.

        Raises:
            TimeoutError: If the app does not reply in time.
            RuntimeError: If the app reports the command failed.
        """
        request_id = uuid.uuid4().hex
        slot: dict[str, Any] = {
            "done": False,
            "ok": False,
            "value": None,
            "error": None,
        }
        try:
            # Register and send inside the try so a failing send() still cleans
            # up the slot in finally.
            self._pending[request_id] = slot
            self.send(
                {
                    "type": "geolibre:command",
                    "requestId": request_id,
                    "method": method,
                    "params": params or {},
                }
            )
            self._wait_for_result(slot, method, timeout)
        finally:
            self._pending.pop(request_id, None)
        if not slot["ok"]:
            raise RuntimeError(slot["error"] or f"GeoLibre command {method!r} failed")
        return slot["value"]

    def on(self, event: str, callback: Callable[[Any], None]) -> Callable[[], None]:
        """Register a callback for an app event.

        Events are delivered when the map is displayed and the user interacts
        with it. The known events are ``"click"`` (payload
        ``{"lngLat": [lng, lat], "features": [...]}``), ``"selection-change"``
        (``{"layerId", "featureId"}``), and ``"layer-change"``
        (``{"layerIds": [...]}``).

        Args:
            event: The event name.
            callback: Called with the event payload.

        Returns:
            A function that unregisters this callback.
        """
        self._event_handlers.setdefault(event, []).append(callback)

        def _off() -> None:
            handlers = self._event_handlers.get(event)
            if handlers and callback in handlers:
                handlers.remove(callback)

        return _off

    def on_click(self, callback: Callable[[Any], None]) -> Callable[[], None]:
        """Register a callback fired when the user clicks the map."""
        return self.on("click", callback)

    def on_selection_change(self, callback: Callable[[Any], None]) -> Callable[[], None]:
        """Register a callback fired when the selected layer/feature changes."""
        return self.on("selection-change", callback)

    def on_layer_change(self, callback: Callable[[Any], None]) -> Callable[[], None]:
        """Register a callback fired when layers are added or removed."""
        return self.on("layer-change", callback)
