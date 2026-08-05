# @geolibre/embed

[![npm version](https://img.shields.io/npm/v/@geolibre/embed.svg)](https://www.npmjs.com/package/@geolibre/embed)
[![npm downloads](https://img.shields.io/npm/dm/@geolibre/embed.svg)](https://www.npmjs.com/package/@geolibre/embed)
[![license](https://img.shields.io/npm/l/@geolibre/embed.svg)](https://github.com/opengeos/GeoLibre/blob/main/LICENSE)

Typed, dependency-free client for driving a [GeoLibre](https://github.com/opengeos/GeoLibre)
map embedded in an `<iframe>` from the page around it.

URL parameters configure a GeoLibre embed once, at load. This package is for
everything after that: fly to the record someone just clicked in your own UI,
toggle a layer, apply a filter, export the map as a PNG, and hear what the user
does inside the map. It speaks GeoLibre's versioned `postMessage` protocol, and
handles the two parts that are easy to get wrong by hand: the origin checks in
both directions, and correlating each command with its acknowledgement so
several can be in flight at once.

Source repo: [opengeos/GeoLibre](https://github.com/opengeos/GeoLibre). The
package version tracks the app version, since both ship from the same release.

## Install

```bash
npm install @geolibre/embed
```

## Usage

```ts
import { connect } from "@geolibre/embed";

const iframe = document.querySelector("iframe");
const map = await connect(iframe, { origin: "https://gis.example.com" });

await map.setView({ center: [-95.7, 37.1], zoom: 5 });
await map.setLayerVisibility("roads", false);

const layers = await map.listLayers();
console.log(layers.map((layer) => layer.name));

map.on("selectionChanged", ({ featureIds }) => showRecordFor(featureIds[0]));
```

`connect` resolves once the app reports that it is ready, so there is no
handshake to write yourself. Pass the **app's** origin, not your own: it is both
the target of every outbound message and the filter on inbound ones.

## API

`connect(iframe, options)` → `Promise<GeoLibreEmbedClient>`

| Option              | Default | Description                             |
| ------------------- | ------- | --------------------------------------- |
| `origin`            | —       | Required. Exact origin hosting the app. |
| `timeoutMs`         | 15000   | How long to wait for `ready`.           |
| `requestTimeoutMs`  | 15000   | How long to wait for each command.      |

| Method                                 | Resolves with           |
| -------------------------------------- | ----------------------- |
| `loadProject(url)`                     | `void`                  |
| `setView(target)`                      | `void`                  |
| `highlightFeature({ layerId, … })`     | `void`                  |
| `openTool(id, params?)`                | `void`                  |
| `setLayerVisibility(layerId, visible)` | `void`                  |
| `listLayers()`                         | `LayerSummary[]`        |
| `setFilter(layerId, expression)`       | `void`                  |
| `getViewport()`                        | `Viewport`              |
| `addLayer(spec)`                       | the new layer's `id`    |
| `exportImage()`                        | a PNG `data:` URL       |
| `on(event, listener)`                  | an unsubscribe function |
| `disconnect()`                         | not a promise           |

Commands reject rather than resolving falsely: a rejected request rejects with
the app's own error message, and one that goes unanswered rejects with a
timeout. Call `disconnect()` when the iframe goes away, so a pending promise
cannot hang for the life of the page.

Events: `ready`, `ack`, `projectLoaded`, `selectionChanged`, `viewChanged`,
`toolCompleted`, `serverFileWritten`.

## The API is off unless the deployment opts in

A GeoLibre deployment ignores this protocol until it names the origins it
trusts, so a public instance can never be driven by whatever page frames it.
For the Docker image that is one environment variable:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_EMBED_ORIGINS="https://portal.example.com" \
  ghcr.io/opengeos/geolibre:latest
```

For a static build, bake it in with
`VITE_GEOLIBRE_EMBED_ORIGINS="https://portal.example.com" npm run build`.
The public `web.geolibre.app` build sets no allowlist, so the runtime API is for
your own hosted deployment.

## Documentation

See [Embedding & Sharing](https://geolibre.app/user-guide/embedding/) for the
allowlist, the URL parameters, the full protocol reference, and a raw
`postMessage` example for hosts that would rather not take a dependency.

## License

MIT
