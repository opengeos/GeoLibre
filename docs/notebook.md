# Notebook panel

GeoLibre can run a Jupyter notebook **beside the map**, in a resizable,
collapsible panel (open it from **Processing → Jupyter Notebook**). It works in
both the web and desktop builds, with a different Python runtime behind the same
`<iframe>` panel:

- **Web build → [JupyterLite](https://jupyterlite.readthedocs.io).** A full
  Jupyter UI running entirely in the browser on a [Pyodide](https://pyodide.org)
  (WebAssembly) kernel — no server. Install extra packages on demand from a cell
  with `%pip install geopandas`.
- **Desktop build → a real JupyterLab server.** The app launches `jupyter lab`
  from a uv-managed Python environment (the same mechanism as the FastAPI
  sidecar) on `127.0.0.1:8766`, token-authenticated, and embeds it. This gives
  full CPython with the native geospatial stack (geopandas, rasterio, GDAL, …).

This is distinct from the [`geolibre` Python package](python.md), which does the
inverse — embedding the *whole GeoLibre app* inside a notebook cell.

## Scripting the map from a cell

A lightweight `geolibre` client is preloaded into the notebook kernel — on web
it is bundled into JupyterLite's filesystem, so **no `pip install` is needed**;
on desktop it is placed on the kernel's import path. Just import it:

```python
import geolibre

m = geolibre.connect()          # or geolibre.Map()
m.fly_to(-122.4, 37.8, zoom=11) # animate the live map in the left pane
layer_id = m.add_geojson(
    gdf,
    name="My layer",
    fillColor="#facc15",
    strokeColor="#d97706",
)  # GeoDataFrame, dict, or JSON string; returns an id on desktop
m.get_layer(layer_id)
m.list_layers()
m.fit_bounds([-123, 37, -122, 38])
m.set_basemap("https://…/style.json")
```

Most mutation calls are **fire-and-forget**. On desktop, `add_geojson` uses the
relay's correlated request/reply path and returns the new layer id. The same
path exposes `list_layers()`, which returns one dict per live layer with `id`,
`name`, `type`, `visible`, and `opacity`, and `get_layer(layer_id)`, which
returns one matching layer or raises `ValueError`. The id can be passed directly to
`set_visibility`, `set_opacity`, `set_style`, `remove_layer`, or
`zoom_to_layer`.

All commands fan out to every GeoLibre window connected to the same Jupyter
server. For `add_geojson`, `list_layers`, and `get_layer`, the first correlated
reply is returned to the notebook and later replies are ignored. Because each
window maintains its own map state, use one connected window when chaining a
returned layer id into later read-back calls. This behavior is only visible if
you attach multiple GeoLibre windows to one Jupyter server.

`add_geojson` returns `None` instead of an id in two situations, and never
fails outright in either:

- **Nothing received the command** (no window connected, or the relay itself
  unreachable). It behaves like every other mutation — the layer goes out over
  the display transport with a `GeoLibreNotConnectedWarning`.
- **A window took it but did not answer within 5s**, which a large
  `FeatureCollection` can do. You get a `GeoLibreTimeoutWarning`; the layer is
  still being added, so it is deliberately *not* re-sent (that would add it
  twice) — find it with `list_layers()`.

The read-back calls have nothing to return in either situation, so they raise
`GeoLibreNotConnectedError` / `GeoLibreTimeoutError` (both `RuntimeError`)
instead.

Synchronous read-back is desktop-only. JupyterLite uses browser `postMessage`;
blocking its Python call would also block the browser event loop that must
deliver the result. Canonical client source:
`backend/geolibre_server/notebook_client.py`.

## Driving the map from an external client (VS Code, …)

The desktop app's JupyterLab server is a normal, token-authenticated Jupyter
server, so you can attach any Jupyter client to it and keep your own editor —
and the map commands above still work. Open the Notebook panel once (that is
what starts the server), then use its **link button** in the panel header to copy
the connection URL and paste it into your client (in VS Code: *Jupyter: Specify
Jupyter Server for Connections* → *Existing*).

This works because commands travel over a **relay** on the Jupyter server rather
than depending on how the notebook is being *displayed*:

- `backend/geolibre_server/geolibre_server/jupyter_relay.py` is a Jupyter Server
  extension (enabled from `jupyter_server_config.py`) exposing
  `POST …/geolibre/relay/command`, a `…/geolibre/relay/socket` WebSocket, and
  `GET …/geolibre/relay/status`. At load it publishes `GEOLIBRE_RELAY_URL` and
  `GEOLIBRE_RELAY_TOKEN` into the server's environment, which **kernels inherit**
  — that is how `import geolibre` finds the map with no configuration.
- The app subscribes to that socket for its whole lifetime
  (`useJupyterRelay`), reconnecting with backoff, and runs each command against
  the same `createScriptingHandlers` surface.
- `useNotebookBridge` remains the postMessage path for the **embedded** panel and
  for web (JupyterLite), where the notebook page really is the app's iframe.

The POST answers with how many app windows received the command, so a
disconnected session is reported instead of silently doing nothing:

```python
geolibre.is_connected()   # False -> no GeoLibre window is listening
```

When a command cannot be delivered the client raises a
`GeoLibreNotConnectedWarning` pointing at your own line. Promote it to an error
with:

```python
import warnings, geolibre
warnings.simplefilter("error", geolibre.GeoLibreNotConnectedWarning)
```

Only the desktop server has the relay: on web (JupyterLite) there is no server to
attach an external client to.

## Theme

On the **web build** the notebook follows the app's light/dark theme live (no
reload). JupyterLite is built with `exposeAppInBrowser` (see
`apps/geolibre-desktop/jupyterlite/jupyter-lite.json`), which puts its app object
on `window.jupyterapp`; since the JupyterLite iframe is same-origin,
`useNotebookThemeSync` reaches in and runs the built-in `apputils:change-theme`
command whenever the app theme changes. On the **desktop build** the JupyterLab
server is a different origin, so this cross-origin call is a no-op and the
notebook keeps its own theme (syncing it there would need a small JupyterLab
extension — a future enhancement).

## Building the web JupyterLite site

The web build embeds a self-hosted JupyterLite site under
`apps/geolibre-desktop/public/jupyterlite/`. It is **not** committed (≈70 MB) and
is generated by a best-effort prebuild step that needs the `jupyter lite` CLI:

```bash
pip install -r apps/geolibre-desktop/jupyterlite/requirements.txt
npm run build:jupyterlite
```

Both `npm run dev` and `npm run build` run this automatically:

- `npm run dev` builds it **once** on first run via a `predev` hook
  (`--if-missing`), then is instant on subsequent runs.
- `npm run build` always rebuilds it (via `prebuild`) so a changed client/config
  is picked up.

Both **skip with a warning** when `jupyter lite` is not installed, so a Node-only
build still succeeds. Be aware of what that produces: the panel does *not* show a
"not built" message. Its iframe asks for `/jupyterlite/lab/index.html`, and
anything that answers an unknown path with `index.html` — Tauri's asset
resolver, or a static host with an SPA fallback such as
`try_files $uri /index.html` — hands the panel **a second copy of GeoLibre**
instead (GeoLibre#1851, GeoLibre#1658). Install the deps above and rebuild.

Two builds therefore treat a missing CLI as fatal rather than skippable, because
they serve the site and cannot degrade: the Mac App Store build, and any build
that sets `GEOLIBRE_JUPYTERLITE_REQUIRED=1` (the Docker image does). The desktop
(Tauri) dev and build paths skip it entirely (they use the real JupyterLab
server), so the static site never bloats the installer.

The Docker image builds and serves the site, and gives `/jupyterlite/` its own
block in `docker/nginx.conf`:

- Its own CSP — JupyterLab bootstraps from an inline `<script>`, which the app's
  policy forbids, so under the app policy the site loads its HTML and then never
  boots.
- No SPA fallback (`try_files $uri $uri/ =404`), so in this image the failure
  above surfaces as a plain **404** rather than as the duplicated app. The
  duplicate remains what Tauri and SPA-fallback hosts produce.
- The long-lived immutable cache policy for the content-hashed assets, which the
  prefix match would otherwise take away from them.

Build config lives in `apps/geolibre-desktop/jupyterlite/` (a
`jupyter_lite_config.json`, the build `requirements.txt`, and a starter
`files/Welcome.ipynb`). The generated directory is excluded from the PWA
precache (see `pwaPlugin` in `apps/geolibre-desktop/vite.config.ts`).

## Desktop server

- Backend extra: `notebook` in `backend/geolibre_server/pyproject.toml`
  (`jupyterlab`, `jupyter-server`), synced into its own uv project environment so
  it never disturbs the sidecar's env.
- Launcher / lifecycle: `start_jupyter_server` / `stop_jupyter_server` Tauri
  commands in `apps/geolibre-desktop/src-tauri/src/lib.rs` (mirrors the sidecar
  launcher), with the TS wrapper in `apps/geolibre-desktop/src/lib/jupyter.ts`.
- Framing: `backend/geolibre_server/jupyter_server_config.py` relaxes
  `Content-Security-Policy: frame-ancestors` to the Tauri webview / loopback
  origins so the app can embed the server; the Tauri CSP (`tauri.conf.json`)
  adds the loopback origins to `frame-src`/`child-src`.
- Map-command relay: the same config enables the `geolibre_server.jupyter_relay`
  server extension (see above). Its WebSocket accepts only the app's own origins
  and every endpoint requires the server's per-launch token, so a command can
  only come from something that already has kernel-execution rights there.
