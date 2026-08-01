# Embedding & Sharing

GeoLibre's browser build can be embedded in any web page and configured through URL query parameters. This is how you turn a shared project into a live, focused map for a website, a report, or a dashboard.

## The live viewer

The browser build is hosted at `https://web.geolibre.app/`. It is a static site deployed on GitHub Pages that runs entirely in your browser: it has no analytics and no server account, and the data you load is processed client-side. Data leaves your browser only when you add a remote URL or explicitly share a project.

Open a public project by passing its `.geolibre.json` URL with the `url` parameter:

```text
https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json
```

A project URL like this comes from **Project → Share**. See [Projects](projects.md#share).

A chrome-free `maponly` embed shows only the map, as in this shared 3D Tiles project:

![Chrome-free maponly embed of a 3D Tiles project](https://data.geolibre.app/images/geolibre-embed-maponly.webp)

## URL parameters

| Parameter    | Example                                                    | Description                                                                                                                           |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `url`        | `url=https://share.geolibre.app/you/project.geolibre.json` | Loads a `.geolibre.json` project from a public URL.                                                                                   |
| `layout`     | `layout=viewer`                                            | `viewer` provides read-only chrome: Layers, View, Controls, basemaps, search/identify, and Help, with authoring UI hidden. `compact` is the icon-only full-app layout; `embed` and `iframe` are aliases. |
| `toolbar`    | `toolbar=icons`                                            | Icon-only toolbar buttons without the full compact layout. `icon` and `icon-only` are aliases.                                        |
| `panels`     | `panels=none`                                              | Hides the Layers, Style, and Attribute table panels. `hidden`, `hide`, and `off` are aliases.                                         |
| `hidePanels` | `hidePanels=true`                                          | Alternative way to hide those panels.                                                                                                 |
| `maponly`    | `maponly`                                                  | Hides all chrome (toolbar, panels, and status bar), leaving only the map. The bare flag or `true`, `1`, `yes`, `on` enable it.        |
| `welcome`    | `welcome=0`                                                | Hides the first-launch welcome wizard. Accepts `0`, `false`, `off`, or `no`. A `url=` deep link already suppresses it automatically.  |
| `theme`      | `theme=dark`                                               | Sets the initial color theme, overriding the OS preference. Accepts `dark` or `light`; the in-app toggle still works afterward.       |
| `tool`       | `tool=adaptive_filter`                                     | Opens the Processing (Whitebox toolbox) dialog on a specific tool by its id. Unknown ids open the dialog without preselecting a tool. |

Parameters combine. For a narrow, chrome-free, dark embed of a shared project:

```text
https://web.geolibre.app/?url=https://share.geolibre.app/you/project.geolibre.json&maponly&theme=dark
```

### Deep-linking a Processing tool

`tool=<id>` opens the Processing (Whitebox toolbox) dialog preselected to a tool.
Any **additional** query parameters pre-fill that tool's form, using the tool's
own parameter names, so a link can arrive ready to run:

```text
https://web.geolibre.app/?tool=extract_cog_subset&url=https%3A%2F%2Fdata.source.coop%2Fgiswqs%2Fopengeos%2Fdem.tif&bbox_crs=4326
```

When `tool=` is present the app is in **tool mode**: `url` names a tool input
(here, the COG to subset) rather than a project to load, so the project loader
stands down. App/embed parameters above (`theme`, `layout`, `panels`, `maponly`,
`locale`, …) keep their own meaning and are never passed to the tool.
Preselection and parameter prefilling apply only to an id that matches the
Processing menu: an id not in the menu still opens the dialog, but without
preselecting a tool or applying any parameters. A known id the current engine
doesn't expose (WASM in the browser, the Python sidecar on desktop) likewise
isn't preselected. Tool ids match the Processing menu — the same ids used across
the [Whitebox toolbox](processing.md).

## Embedding in a page

Drop the viewer into an `<iframe>`:

```html
<iframe
  src="https://web.geolibre.app/?url=https://share.geolibre.app/you/project.geolibre.json&amp;maponly"
  title="GeoLibre map"
  width="100%"
  height="600"
  style="border: 0;"
  loading="lazy"
  allow="fullscreen; geolocation"
></iframe>
```

Use `layout=viewer` for a read-only map with layer toggles, search/identify, and
basemap switching. Its layer list mirrors the authoring Layers panel, folders
and all, so group names carry over. The Controls menu is part of the viewer
chrome, minus the two entries that write to the project (Field Collection and
GPS Tracking); Record Tour and Record Video only read the map, so they stay.
Read-only covers the keyboard too: the
project shortcuts (Ctrl/Cmd+N, +O, +S) and the command palette (Ctrl/Cmd+K) go
with the menus they belong to, while the View shortcuts (`[`, `]`, `n`, `u`,
`r`) keep working since the View menu stays. Dropping a file onto the map
imports nothing, and the plugins that draw on the map — the geometry editor and
Annotations — cannot be active, even if the loaded project saved them that way.
So an embed cannot be steered into authoring by a key press, a drag, or a
project file. Display plugins (layer control, basemaps, time slider, legend and
colorbar components) keep working, so the project still looks as it was saved. Use `layout=compact` for the complete authoring
toolbar in a smaller space, or `maponly` for a pure map.

## Talking to the map at runtime

URL parameters configure the app once, at load. To keep talking to a **live**
embed (fly to the record the user just clicked in your app, highlight it, open a
processing tool) and to hear what the user does inside the map, use the embed
`postMessage` API. The dependency-free `@geolibre/embed` package provides the
recommended typed client and handles origin checks and request correlation:

```ts
import { connect } from "@geolibre/embed";

const map = await connect(document.querySelector("iframe"), {
  origin: "https://web.geolibre.app",
});
await map.setView({ center: [-95.7, 37.1], zoom: 5 });
await map.setLayerVisibility("roads", false);
const layers = await map.listLayers();
map.on("selectionChanged", ({ featureIds }) => console.log(featureIds));
```

### Enabling it

The API is **off by default**: a public deployment can never be driven by the
page that frames it. Turn it on by naming the origins you trust. For the Docker
image, that is one environment variable:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_EMBED_ORIGINS="https://portal.example.com,https://erp.example.com" \
  ghcr.io/opengeos/geolibre:latest
```

For a static build, bake it in instead:
`VITE_GEOLIBRE_EMBED_ORIGINS="https://portal.example.com" npm run build`.

Entries are origins (`scheme://host[:port]`); a trailing path is ignored. `*`
allows any origin and is only appropriate on a private network. The allowlist is
enforced in both directions: a message from an unlisted origin is ignored, and
every message the app sends is addressed to a listed origin. (With `*`
configured, outbound messages are addressed to `*` until the host's first
message identifies it, which is one more reason to name your origins.)

Setting the allowlist also narrows the `?embed=1` project/scripting bridges (used
by the [Python package](../python.md)) to the same origins. As extra hardening
you can stop other sites from framing the app at all by adding
`Content-Security-Policy: frame-ancestors <your origins>` at your reverse proxy.

### The typed client

`@geolibre/embed` is a dependency-free ESM package published to npm from each
GeoLibre release, so its version tracks the app version:

```bash
npm install @geolibre/embed
```

`connect(iframe, options)` returns a promise that resolves once the app sends
`ready`, so there is no `ready` handshake to write yourself. It also stamps a
`requestId` on every command and settles that command's promise from the
matching `ack`, which is what lets several commands be in flight at once
without their answers getting crossed.

```ts
import { connect } from "@geolibre/embed";

const map = await connect(iframe, {
  origin: "https://web.geolibre.app", // exact origin hosting the iframe
  timeoutMs: 15_000, // wait for `ready`; default 15s
  requestTimeoutMs: 15_000, // wait for each `ack`; default 15s
});
```

`origin` is required and must be an `http(s)` origin: it is both the target of
every outbound message and the filter on inbound ones, so a message from any
other frame or origin is ignored. Pass the *app's* origin, not your own.

| Method                                 | Resolves with           | Notes                                                                   |
| -------------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `loadProject(url)`                     | `void`                  | Swaps the project without reloading the iframe.                         |
| `setView(target)`                      | `void`                  | `{ bbox }`, or any of `{ center, zoom, bearing, pitch, duration }`.      |
| `highlightFeature({ layerId, … })`     | `void`                  | `featureId`, `featureIds`, or `filter`; `fit: true` zooms to the match.  |
| `openTool(id, params?)`                | `void`                  | Runtime twin of `?tool=`.                                               |
| `setLayerVisibility(layerId, visible)` | `void`                  | Shows or hides a project layer.                                         |
| `listLayers()`                         | `LayerSummary[]`        | `{ id, name, type, visible, opacity }` per layer.                       |
| `setFilter(layerId, expression)`       | `void`                  | A MapLibre filter expression, or `null` to clear it.                    |
| `getViewport()`                        | `Viewport`              | `{ bbox, center, zoom, bearing, pitch }`.                               |
| `addLayer(spec)`                       | the new layer's `id`    | Takes a project-format layer specification.                             |
| `exportImage()`                        | a PNG `data:` URL       | The map as currently rendered.                                          |
| `on(event, listener)`                  | an unsubscribe function | Not a promise; events are the set the app posts (see below).            |
| `disconnect()`                         | not a promise           | Removes the listener and rejects anything still in flight.              |

Every command rejects rather than resolving falsely: an `ack` carrying
`ok: false` rejects with the app's own error message, and a command with no
answer inside `requestTimeoutMs` rejects with a timeout. `connect` itself
rejects if `ready` does not arrive inside `timeoutMs` — most often because the
deployment has not allowlisted your origin, or because `origin` does not match
the iframe.

Call `disconnect()` when you tear the iframe down (a React effect cleanup, a
route change). It stops the `message` listener and rejects every pending
command, so a promise cannot hang for the life of the page.

`on` returns its own unsubscribe function and accepts every event in the table
[below](#geolibre-to-host), typed by name. Subscribing to `ack` is only worth it
to observe the traffic, since each command's promise is already settled from it.

Hosts that cannot take a dependency can speak the protocol directly; the rest of
this page documents it.

### Message shape

Every message, in both directions, is versioned:

```json
{ "v": 2, "type": "setView", "payload": { "center": [-95.7, 37.1], "zoom": 5 } }
```

Messages the **app** sends also carry `"source": "geolibre"`, so you can filter
them out of the other `postMessage` traffic on your page.

### Host to GeoLibre

| Type               | Payload                                                    | Effect                                                                             |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `loadProject`      | `{ url }`                                                  | Loads a `.geolibre.json` project without reloading the iframe.                      |
| `setView`          | `{ bbox }` or `{ center, zoom, bearing, pitch, duration }` | Fits a bounding box, or flies the camera to the properties you send.                |
| `highlightFeature` | `{ layerId, featureId \| featureIds \| filter, fit }`      | Selects and highlights features; `filter` matches properties. `fit` zooms to them.  |
| `openTool`         | `{ id, params }`                                           | Opens the Processing dialog on a tool, pre-filling `params`. Runtime twin of `?tool=`. |
| `setLayerVisibility` | `{ layerId, visible }`                                   | Shows or hides a project layer.                                                       |
| `listLayers`       | `{}`                                                       | Returns layer summaries in the acknowledgement's `result`.                           |
| `setFilter`        | `{ layerId, expression }`                                  | Applies a MapLibre filter expression; send `null` to clear it.                        |
| `getViewport`      | `{}`                                                       | Returns the current camera and bounds in `result`.                                    |
| `addLayer`         | `{ spec }`                                                 | Adds a project-format layer specification at runtime.                                 |
| `exportImage`      | `{}`                                                       | Returns the rendered map as a PNG data URL in `result`.                               |

Send `{ layerId }` alone to `highlightFeature` to clear the highlight. A request
that names features (or a filter) but matches none is rejected rather than
treated as a clear, so a mistyped id does not silently wipe the user's selection.
Highlighting reads the layer's features from the project, so it applies to vector
layers GeoLibre holds as GeoJSON, not to ones whose features live only in a tile
source.

`setFilter` compiles the expression through the MapLibre style spec before
storing it, and `addLayer` requires a source the map can actually read: a `url`
or a non-empty `tiles`, or — for the two layer types drawn from inline features,
`geojson` and `deckgl-viz` — an inline `geojson`. Both report the problem in the
`ack` rather than reporting success and rendering nothing. `addLayer` also
refuses `javascript:`, `vbscript:`, `data:`, `file:`, and `blob:` URLs on a
source; a custom map protocol such as `pmtiles://` is fine.

Add a `requestId` to any message and the app answers with an `ack` (below)
reporting whether it worked.

### GeoLibre to host

| Type                | Payload                                                        | Fires when                                                       |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `ready`             | `{ version }`                                                  | The app has mounted and is listening.                             |
| `ack`               | `{ requestId, ok, error, result }`                             | A message you sent with a `requestId` was applied (or rejected).  |
| `projectLoaded`     | `{ url, name, layerIds }`                                      | A project finished loading, whoever started it.                   |
| `selectionChanged`  | `{ layerId, featureIds }`                                      | The user (or your `highlightFeature`) changed the selection.      |
| `viewChanged`       | `{ bbox, center, zoom, bearing, pitch }`                       | The camera moved (throttled to about four events a second).       |
| `toolCompleted`     | `{ id, name, status, engine, durationMs, outputLayerNames }`   | A processing run finished, successfully or not.                   |
| `serverFileWritten` | `{ path, toolId }`                                             | A file-based tool wrote an output (conversion and raster tools).  |

### A host page

```html
<iframe
  id="map"
  src="https://gis.example.com/?url=https://erp.example.com/fields.geolibre.json&maponly"
  title="GeoLibre map"
  width="100%"
  height="600"
  style="border: 0"
></iframe>

<script>
  const frame = document.getElementById("map");
  const APP_ORIGIN = "https://gis.example.com";

  const send = (type, payload) =>
    frame.contentWindow.postMessage({ v: 2, type, payload }, APP_ORIGIN);

  window.addEventListener("message", (event) => {
    if (event.origin !== APP_ORIGIN) return;
    const message = event.data;
    if (message?.source !== "geolibre" || message.v !== 2) return;

    if (message.type === "ready") {
      // Safe to start sending commands.
    } else if (message.type === "selectionChanged") {
      showRecordFor(message.payload.featureIds[0]);
    }
  });

  // Click a record in your own UI: fly to it and highlight it, no reload.
  function focusField(field) {
    send("setView", { bbox: field.bbox });
    send("highlightFeature", {
      layerId: "fields",
      filter: { parcel_id: field.id },
      fit: true,
    });
  }
</script>
```

Wait for `ready` before sending: messages that arrive before the app has mounted
are not queued. Treat `ready` as idempotent, since it is re-sent whenever the app
remounts (a navigation inside the frame, a development hot reload).

Protocol v2 is current. GeoLibre continues to accept v1 request envelopes and
answers a v1 host with v1 events, so existing hand-written integrations remain
compatible.

## What works in an embed

The browser build supports map navigation, browser-selected and URL-based data, styling, the SQL Workspace, and most plugins. Desktop-only features (local file dialogs, local MBTiles and raster reads, project save/open, and the Python sidecar tools) are not available in an embed. See [Getting Started](../getting-started.md).

See the [Sharing & Embedding tutorial](../tutorials/sharing-embedding.md) for a full walkthrough.
