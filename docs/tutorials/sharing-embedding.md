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
- `layout=compact` keeps a slim, icon-only toolbar.
- `panels=none` hides the side and bottom panels but keeps the toolbar.
- `theme=dark` forces the dark theme on load.

See the full [parameter table](../user-guide/embedding.md#url-parameters).

## Next steps

- Tune which controls appear before sharing with the [Controls menu](../user-guide/map-controls.md).
- Revisit [Your First Map](first-map.md) to build the map you want to share.
