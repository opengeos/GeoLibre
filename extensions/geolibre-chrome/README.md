# Open data in GeoLibre

A Manifest V3 Chrome extension that finds supported geospatial dataset links on
the current page and opens selected files together in GeoLibre using repeated
`data` query parameters.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extensions/geolibre-chrome` directory.

The extension requests `activeTab` and `scripting` only. It scans a page after
you click its toolbar icon and does not retain page contents or browsing data.

## Package for the Chrome Web Store

From the repository root, run:

```bash
npm run build:chrome-extension
```

The versioned upload ZIP is written to `dist/`. Store listing copy and
permission explanations are in `STORE_LISTING.md`; the publishable privacy
policy source is in `PRIVACY.md`. The policy must be hosted at a public URL
before submitting the listing.

## Discovery

The scanner recognizes GeoJSON/JSON, GeoParquet/Parquet, PMTiles, GeoTIFF/COG,
and ZIP links in anchors, linked resources, selected data attributes, and
schema.org JSON-LD `contentUrl`/`downloadUrl` fields. Existing GeoLibre deep
links are unpacked, and a neighboring `name.style.json` or
`name.geolibre.style.json` link is paired with the matching dataset.

Source Cooperative repository pages receive additional handling: the extension
reads the complete embedded file inventory even when the visible table is
virtualized, canonicalizes links to `data.source.coop`, and removes duplicate
page/download links. The popup can filter discovered files by vector or raster
type without changing the current selection.

Remote servers must allow GeoLibre to fetch the selected URLs through CORS.
Complete HTTP(S) URLs, including signed query parameters, are forwarded to
GeoLibre. Cookies and other browser-session credentials are not forwarded, so
cookie-bound or session-authenticated links may fail. Temporary `blob:` and
browser-internal links cannot be transferred.
