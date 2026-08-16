# Open data in GeoLibre

A Manifest V3 Chrome extension that finds supported geospatial dataset links on
the current page, observes geospatial service requests made by interactive maps,
and opens selected data in GeoLibre.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extensions/geolibre-chrome` directory.

The extension scans document links after you click its toolbar icon. It also
observes completed HTTP(S) requests locally so it can recognize services used
by interactive web maps. Detected service URLs remain only in session storage
for the lifetime of their tab.

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

The request watcher recognizes WMS, WMTS, WFS, OGC API Features, ArcGIS Feature
Services, XYZ/TMS image tiles, and PBF/MVT vector tiles. Tile requests are
collapsed into reusable `{z}/{x}/{y}` templates, and repeated requests from the
same service appear once.

## Sample websites for manual testing

Open a sample, wait for its map to load, and pan or zoom to generate network
requests. Then open the extension and confirm that it lists the expected
service. Selecting the result should open the matching GeoLibre Add Data dialog
with the service URL filled in.

| Service | Sample website | Expected result |
| --- | --- | --- |
| XYZ raster tiles | [OpenStreetMap](https://www.openstreetmap.org/) | An XYZ URL template such as `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| PBF/MVT vector tiles | [MapLibre display-a-map demo](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-map/) | A vector tile URL template ending in `.pbf` or `.mvt` |
| WMTS | [OpenLayers WMTS example](https://openlayers.org/en/latest/examples/wmts.html) | A WMTS service URL without tile-coordinate parameters |
| WMS | [OpenLayers WMS GetFeatureInfo example](https://openlayers.org/en/latest/examples/getfeatureinfo-tile.html) | A WMS service endpoint without request-specific parameters |
| WFS | [OpenLayers WFS example](https://openlayers.org/en/latest/examples/vector-wfs.html) | A WFS endpoint without request-specific parameters |
| OGC API Features | [OpenLayers OGC API Features example](https://openlayers.org/en/latest/examples/mapserver-ogc-features.html) | An OGC API Features collection or items URL |
| ArcGIS Feature Service | [ArcGIS FeatureLayer sample](https://developers.arcgis.com/javascript/latest/sample-code/layers-featurelayer/) | An ArcGIS `FeatureServer` service or layer URL |

Some samples also use an XYZ basemap, so the target service and a basemap may
both appear. After selecting a result, add the layer in GeoLibre and verify that
the browser console does not report a static-file CORS error.

Remote servers must allow GeoLibre to fetch the selected URLs through CORS.
Complete HTTP(S) URLs, including signed query parameters, are forwarded to
GeoLibre. Cookies and other browser-session credentials are not forwarded, so
cookie-bound or session-authenticated links may fail. Temporary `blob:` and
browser-internal links cannot be transferred.
