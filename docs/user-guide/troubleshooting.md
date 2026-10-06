# Troubleshooting

This page collects fixes for common problems in GeoLibre, and shows how to find
out what went wrong and report it. Most display glitches in the browser after
an update come down to a stale browser cache, so start there.

## Stale browser cache

GeoLibre Web is a single-page app that browsers cache aggressively. After a new
version ships, an outdated cached copy can leave you with display errors,
missing or non-responsive controls, plugins that appear not to load, or stale
data. The fix is to clear the cache and reload so the browser fetches the latest
build.

Try these in order:

- **Hard refresh** the page to bypass the cache once:
    - **Windows / Linux**: `Ctrl + Shift + R` (Chrome, Edge, Firefox).
    - **macOS Chrome / Edge / Firefox**: `Cmd + Shift + R`.
    - **macOS Safari**: `Cmd + Option + R`.
- **Open the app in a private / incognito window**. If it works there, the
  problem lies in your browser profile, most often the cache; clearing the
  site's data (next step) confirms it.
- **Clear the cached files** for the GeoLibre site if a hard refresh is not
  enough, then reload.

!!! note "Safari users"
    Safari caches web GIS apps aggressively, so it is the most common source of
    these issues. To empty Safari's cache, choose **Develop → Empty Caches**
    (`Cmd + Option + E`), or **Safari → Clear History**, then reload the page.
    If the **Develop** menu is hidden, enable it in
    **Safari → Settings → Advanced → Show features for web developers**.

A fresh page load against the latest build resolves the large majority of "the
app looks broken after updating" reports.

## The Diagnostics dialog

GeoLibre records what goes wrong while it runs. Open the record with
**Help → Diagnostics**, the **Diagnostics: N** button at the right end of the
status bar, or "Diagnostics" in the command palette (`Ctrl`/`Cmd` + `K`). The
status bar button counts errors and warnings, and turns red when there are
errors and amber when there are only warnings.

Each entry has a level (error, warning, or info), a time, and one of five
categories:

| Category | What lands there |
| --- | --- |
| `app` | Every error notification the app shows you (see [Notifications](interface.md#notifications)). |
| `console` | Errors and warnings written to the browser console, by GeoLibre or by a library or plugin. |
| `map` | Errors raised by the map engine: a tile, source, style, or 3D layer that failed. |
| `network` | Failed requests: an HTTP error status such as `GET 404 Not Found`, or a request that never completed (`request failed (network/TLS/CORS)` or `timed out`), with a hint about the likely cause. |
| `runtime` | Uncaught exceptions and promise rejections, a part of the interface that crashed, and plugin failures. |

The filter buttons along the top show all entries, errors, warnings, or network
entries. By default only failed requests are logged; tick
**Log all network requests** to record successful and aborted requests too from
that point on (it slows the app down, so leave it off otherwise).

- **Copy JSON** copies the entries currently shown, to paste into an issue or a
  message.
- **Clear** empties the log.

The log keeps the newest 500 entries, lives in memory only (it starts empty on
every launch), and strips access tokens, API keys, and similar query parameters
from the URLs it stores.

## Reporting a problem

Error notifications, and error rows in the Diagnostics dialog, carry a
**Report issue** button. It opens GeoLibre's bug report form on GitHub in your
browser, filled in with:

- the error message as the title,
- the app version and whether it is the desktop app or the web app,
- your platform (the browser's user agent) and the active rendering engine,
- the diagnostics entry, as JSON.

Nothing is sent until you review the form and submit it yourself. Before it is
filled in, the report is scrubbed: URL query strings and fragments, user names
and passwords in URLs, embedded `data:` URIs, credential-like `key=value` pairs,
recognizable tokens (bearer tokens, Mapbox, GitHub, AWS, and Google keys, JWTs),
and your home-directory user name are all replaced. Still read it over before
submitting, and add what you were doing when the error appeared.

For a problem with no error behind it, use **Help → Give Feedback**, which opens
the GitHub issue tracker.

## Common errors

### "Could not reach the service"

A remote layer or service that fails with "Could not reach the service…", or a
`network` diagnostic ending in `request failed (network/TLS/CORS)`, usually
means one of:

- **CORS.** In the browser, a server must allow GeoLibre's origin with an
  `Access-Control-Allow-Origin` header, or the browser blocks the response. The
  desktop app is not subject to CORS, so loading the same URL there is the
  quickest test. For an S3 bucket, GeoLibre says so directly when the bucket's
  CORS configuration does not list the app's origin; see
  [Cloud Storage](cloud-storage.md).
- **Mixed content.** An `https://` page cannot load `http://` data. Use an
  HTTPS URL, or the desktop app.
- **TLS or reachability.** An expired or self-signed certificate, a firewall or
  proxy, or a host that is down.

A layer that fails to load is reported once per session with a notification
naming it. Tile requests that return `204` or `404` are not reported, because
sparse tile sets return those for empty areas.

### A GeoTIFF that will not display

A plain (striped) GeoTIFF cannot be streamed tile by tile. GeoLibre recognizes
this and offers to convert it to a Cloud-Optimized GeoTIFF and load that
instead. Conversion runs in the browser, so very large files are refused as too
large to convert safely; convert those yourself with
`gdal_translate -of COG` or `rio cogeo create`, then load the result. See
[Supported Data Formats](../data-formats.md).

### "This project is too large to save"

A project that embeds a lot of vector data can outgrow what can be saved.
Convert the embedded data to PMTiles or FlatGeobuf and add those as remote
layers rather than embedding the features. A related notice, **Autosave
paused** in the status bar, means the project has grown past the autosave limit,
so no new history snapshots are being kept; save it to disk to keep your work.
See [Project history and crash recovery](projects.md#project-history-and-crash-recovery).

### Sidecar messages

Raster tools, format conversions, and the GeoPandas engine for vector tools use
the optional Python sidecar. Messages such as "Raster tools need the GeoLibre
desktop app with a running sidecar", "Could not connect to sidecar", or "The
GeoPandas sidecar is not available" mean it is not running or lacks the extra a
tool needs. Vector tools fall back to the in-browser engine. See
[The Python sidecar](processing.md#the-python-sidecar) for how to start it and
which extras each tool needs.

### Missing tiles in an offline map

**Project → Offline Basemap...** can only cache what the basemap's servers allow:

- "Offline caching needs the installed web app" means the browser build is not
  running as an installed app, so tiles are not stored for offline use.
- Some basemap sources do not allow offline downloading; GeoLibre lists them
  before the download, and their tiles will be missing.
- A large area at many zoom levels can exceed the offline cache limit, and the
  oldest tiles are then evicted as new ones download. Pick a smaller area or
  fewer detail levels.

**Manage Offline Areas** shows how much storage the cached areas use.

### "Something went wrong"

If part of the interface crashes, GeoLibre shows "{name} failed to render. The
rest of GeoLibre is still available." and keeps running. If the whole app
crashes, a full-window "Something went wrong" panel offers **Try again** and
**Reload app**. Try again first: it keeps your work. Your project is also kept
in [project history](projects.md#project-history-and-crash-recovery), so it can
be recovered after a reload. The crash is recorded in Diagnostics under
`runtime`, ready to report.

## The map is blank or renders incorrectly

The map is drawn with WebGL on your graphics hardware. If it stays blank, goes
black, flickers, or 3D layers are missing:

- **Check that hardware acceleration is on** in the browser (Chrome and Edge:
  **Settings → System → Use graphics acceleration when available**; then check
  `chrome://gpu` for "WebGL: Hardware accelerated"). Without it, WebGL falls back
  to slow software rendering or is unavailable.
- **Update the graphics driver**, and on a laptop with two GPUs try running the
  browser on the other one.
- **Try another rendering engine** from **View → Rendering engine**. See
  [Rendering Engines](rendering-engines.md).
- **Look in Diagnostics** for `map` and `console` entries that name the failing
  layer or shader.

When a map canvas loses its WebGL context (the graphics driver resets, or the
GPU runs out of memory), GeoLibre shows a **The map lost its graphics context**
warning with a **Reload** button. If the map does not recover on its own, reload
the page. The warning goes away on its own if the context comes back.
Save your project before reloading if you can. A recent autosave may also be in
[project history](projects.md#project-history-and-crash-recovery), but autosave
runs on a delay and skips projects above the snapshot size limit, so it may not
have your latest changes.

### Linux desktop app

The Linux desktop app runs in WebKitGTK, which has its own GPU quirks. The app
sets the WebKitGTK rendering options known to work for your WebKitGTK version
and GPU at startup (including the DMA-BUF renderer settings on NVIDIA), and
works around a WebAssembly crash on CPUs without AVX. A value you set yourself
in the environment, such as `WEBKIT_DISABLE_DMABUF_RENDERER=1`, always wins, so
that is the first thing to try if the window is blank or the map flickers. See
[Linux desktop troubleshooting](../getting-started.md#linux-desktop-troubleshooting).

## Plugins do not appear to activate

If a plugin's **Activate** action seems to do nothing, first rule out the
stale-cache cause above with a hard refresh or a private window. Once you are on
the latest build, an active plugin shows a checkmark next to its entry in the
**Plugins** menu, and its panel opens in the side panel, or, for the few
plugins with an on-map control (such as GeoEditor or Annotations), the control
appears at the configured corner of the map. A greyed-out plugin does not support the current
rendering engine; hover over it for the reason. A plugin that fails to start is
reported as a notification and in Diagnostics.

## The Processing menu shows the same category twice

`Processing → Vector` and `Processing → GeoLibre Toolbox → Vector` are different
things, and so are the two `Conversion`, `Network`, and `Raster` entries. The
Processing menu carries two independent toolboxes: the Whitebox Toolbox, whose
nine category submenus sit at the top of the menu, and the GeoLibre Toolbox,
which holds GeoLibre's own built-in tools. Neither list is a subset of the
other. [Two toolboxes in one menu](processing.md#two-toolboxes-in-one-menu)
explains which is which and when to use each.

## Desktop-only features in the browser

Some capabilities require the desktop app and are unavailable in the browser
build: local filesystem dialogs, local MBTiles, local raster file reads, and
project save/open. If one of these is missing, you are likely running GeoLibre
Web rather than the desktop app. See [Getting Started](../getting-started.md)
for how the web, desktop, and Jupyter builds differ.

## Self-hosted deployments

When you host GeoLibre yourself, most "it works on web.geolibre.app but not
here" problems come from the deployment's security settings rather than the app:

- **Content Security Policy.** The Docker image's nginx configuration allows
  `https:` data and tile hosts, but blocks plain `http://` remote data and
  WebSocket (`wss://`) hosts other than the configured collaboration server. A
  request blocked by CSP appears in the browser console and in Diagnostics under
  `console`. The desktop app allows any `https:` or `http:` data host, but
  scripts and WebSockets only from a fixed list.
- **The sidecar proxy.** The browser build reaches the sidecar at `/sidecar` on
  the same origin, so it needs no CORS, and it can only read files under
  `GEOLIBRE_CONVERSION_ROOTS` (`/data` by default). A `403` from `/sidecar`
  means the sidecar is disabled (`GEOLIBRE_DISABLE_SIDECAR`) or the deployment
  policy does not grant the capability.
- **Deployment policy.** A `deployment.json` can switch features, services, and
  plugins off, so a missing menu item may be intentional. See
  [Deployment Policy](../deployment-policy.md).

See [Self-Hosting](../self-hosting.md#why-same-origin-matters) for why
same-origin hosting matters, and its
[deployment checklist](../self-hosting.md#deployment-checklist).
