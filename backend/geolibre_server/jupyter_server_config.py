"""Jupyter Server configuration for the GeoLibre desktop Notebook panel.

The desktop app (Tauri) launches ``jupyter lab`` from the uv-managed sidecar
environment and embeds it in an ``<iframe>`` beside the map. By default Jupyter
Server only allows itself to be framed by its own origin
(``Content-Security-Policy: frame-ancestors 'self'``), which would block the
GeoLibre webview (a different origin: ``tauri://localhost`` /
``https://tauri.localhost``). This config relaxes ``frame-ancestors`` to the
loopback / Tauri webview origins so the panel can host it.

The server is bound to ``127.0.0.1`` and protected by a per-launch token
(passed on the command line by the Rust launcher), so widening the framing
ancestors does not expose it beyond the local machine.

Pointed at by ``--config`` from ``src-tauri/src/lib.rs``; not used by the web
build, which embeds the in-browser JupyterLite site instead.
"""

# Origins permitted to embed this server in an iframe. Covers the Tauri webview
# (macOS/Linux use the tauri:// scheme; Windows uses https://tauri.localhost)
# and any loopback dev origin.
_FRAME_ANCESTORS = (
    "frame-ancestors 'self' "
    "tauri://localhost https://tauri.localhost "
    "http://localhost:* http://127.0.0.1:*"
)

c = get_config()  # noqa: F821  (provided by the Jupyter config loader)

c.ServerApp.tornado_settings = {
    "headers": {
        "Content-Security-Policy": _FRAME_ANCESTORS,
    },
    # Force the JupyterLab frontend to append the auth token to every request,
    # including the kernel WebSocket. The notebook page and its API share a host
    # (127.0.0.1:<port>), so JupyterLab otherwise treats them as same-origin and
    # authenticates the WebSocket with the session cookie — but in our third-party
    # iframe (embedded by the app's own origin) that cookie is blocked, so the
    # kernel WebSocket never authenticates and cells hang at "connecting to
    # kernel". Appending the token makes the WebSocket authenticate without a
    # cookie.
    "page_config_data": {
        "appendToken": True,
    },
}

# Never try to open a browser on the host; the app embeds the URL itself.
c.ServerApp.open_browser = False

# The notebook runs in a THIRD-PARTY iframe (its origin, 127.0.0.1:<port>, differs
# from the app's top-level origin), so Jupyter's XSRF cookie does not flow and
# state-changing requests like POST /api/kernels (starting a kernel) would be
# rejected — the kernel never connects and cells hang. The per-launch token in
# the embedded URL already authenticates every request, so disabling the XSRF
# check is safe here (loopback-bound + token-gated) and is what lets the kernel
# connect from the embedded iframe.
#
# NOTE: this disables XSRF for every endpoint, not just the WebSocket. It is
# acceptable only because the server binds loopback (127.0.0.1) and every request
# is gated by the per-launch token. Revisit (e.g. scope CORS/allow_origin
# instead) if this server is ever bound to a non-loopback interface.
c.ServerApp.disable_check_xsrf = True

# The panel embeds the server from a different top-level origin (the Tauri
# webview), so its cookies are sent in a third-party context. SameSite=None lets
# the browser send them there; Secure is required with SameSite=None and is
# honored because loopback (127.0.0.1) is a "potentially trustworthy" origin.
# (cookie_options moved from ServerApp to IdentityProvider in jupyter-server 2.0.)
c.IdentityProvider.cookie_options = {"samesite": "None", "secure": True}
