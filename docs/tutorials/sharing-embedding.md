# Sharing & Embedding

Once you have a map you like, you can publish it as a public link and embed it in any web page. This tutorial covers both. See [Embedding & Sharing](../user-guide/embedding.md) for the full reference.

## 1. Set your share token

Sharing uploads to `share.geolibre.app` using a personal API token.

1. Open **Settings → Environment Variables**.
2. Paste your token into the **Share.GeoLibre API token** field. Create one under Settings → API tokens at [share.geolibre.app/settings](https://share.geolibre.app/settings).

You only need to do this once.

## 2. Share the project

1. Build your map: add layers, style them, and set the map view you want viewers to land on.
2. Open **Project → Share...**.
3. Confirm the project title and upload. GeoLibre returns a public URL to a `.geolibre.json` file, for example:
   ```text
   https://share.geolibre.app/you/my-map.geolibre.json
   ```

The shared file captures the same layers, styles, plugin state, and map view as a local save.

## 3. Open the shared map

Anyone can open the shared project in the live viewer by passing it as the `url` parameter:

```text
https://web.geolibre.app/?url=https://share.geolibre.app/you/my-map.geolibre.json
```

## 4. Embed it in a page

Use an `<iframe>` and the embed parameters to control the chrome. For a clean, map-only embed:

```html
<iframe
  src="https://web.geolibre.app/?url=https://share.geolibre.app/you/my-map.geolibre.json&amp;maponly"
  title="GeoLibre map"
  width="100%"
  height="600"
  style="border: 0;"
  loading="lazy"
  allow="fullscreen; geolocation"
></iframe>
```

Adjust the look with parameters (they combine):

- `maponly` hides all chrome, leaving only the map.
- `layout=viewer` gives a read-only map: Layers, View, Controls, basemaps, and
  search/identify stay, while everything that edits the project is hidden.
- `layout=compact` keeps a slim, icon-only toolbar.
- `toolbar=none` hides the top toolbar while keeping panels and the status bar.
- `panels=none` hides the side and bottom panels but keeps the toolbar.
- `theme=dark` forces the dark theme on load.

Reach for `layout=viewer` when readers should be able to toggle layers and
explore the data but not change it, and `maponly` when the map is a figure in
your page rather than something to interact with.

See the full [parameter table](../user-guide/embedding.md#url-parameters).

## 5. Drive the map from your page

URL parameters configure the embed once, at load. To keep talking to it — fly to
the record someone just clicked in your own UI, and hear what they do inside the
map — install the typed client:

```bash
npm install @geolibre/embed
```

```ts
import { connect } from "@geolibre/embed";

const map = await connect(document.querySelector("iframe"), {
  origin: "https://web.geolibre.app",
});

map.on("selectionChanged", ({ featureIds }) => showRecordFor(featureIds[0]));

async function focusField(field) {
  await map.setView({ bbox: field.bbox });
  await map.highlightFeature({ layerId: "fields", filter: { parcel_id: field.id }, fit: true });
}
```

This works only against a deployment that has allowlisted your page's origin —
`web.geolibre.app` has not, so the runtime API is for your own hosted build. See
[Talking to the map at runtime](../user-guide/embedding.md#talking-to-the-map-at-runtime)
for the allowlist, the full command list, and the raw `postMessage` protocol if
you would rather not add a dependency.

## Next steps

- Tune which controls appear before sharing with the [Controls menu](../user-guide/map-controls.md).
- Revisit [Your First Map](first-map.md) to build the map you want to share.
