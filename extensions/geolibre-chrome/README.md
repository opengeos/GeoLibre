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

A service endpoint on its own is rarely enough to add a layer, so each result
also carries what the page asked that service *for*: the WMS `LAYERS` value, the
WFS `typeName`, the WMTS layer, and — for a vector tileset, whose source layers
live in its style rather than its URL — the style document the page loaded from
the same origin. These arrive in GeoLibre as `serviceLayer` and `serviceStyle`
and land in the matching form fields, so the dialog opens ready to submit rather
than on an endpoint with an empty layer field. Because one endpoint can serve
many layers, results are listed per layer (`WMS service: topp:states`) instead of
collapsing into a single entry per URL.

## Sample websites for manual testing

After loading or reloading the unpacked extension, open one of these websites in
a new tab, let its map finish drawing, then open the extension and confirm it
lists the expected service. Selecting the result opens the matching GeoLibre Add
Data dialog with the service URL filled in. Each row below is a live third-party
map, so what it detects is what a real page hands the request watcher.

| Service | Website | Detected service | Layer carried over |
| --- | --- | --- | --- |
| WMS | [OpenLayers "Image WMS" example](https://openlayers.org/en/latest/examples/wms-image.html) | `https://ahocevar.com/geoserver/wms` | `topp:states` |
| WMTS | [OpenLayers "WMTS" example](https://openlayers.org/en/latest/examples/wmts.html) | The `GetTile` request as a tile template | `sgmc2` |
| WFS | [OpenLayers "WFS" example](https://openlayers.org/en/latest/examples/vector-wfs.html) | `https://ahocevar.com/geoserver/wfs` | `osm:water_areas` |
| OGC API Features | [pygeoapi lakes collection](https://demo.pygeoapi.io/master/collections/lakes/items?f=html) | `https://demo.pygeoapi.io/master/collections/lakes/items` | — |
| ArcGIS Feature Service | [OpenLayers "Vector ESRI" example](https://openlayers.org/en/latest/examples/vector-esri.html) | The `…/FeatureServer/0` layer URL | `0` |
| XYZ raster tiles | [openstreetmap.org](https://www.openstreetmap.org/) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | — |
| Vector tiles, in an `iframe` | [MapLibre "Display a map" example](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-map/) | `https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf` | style `…/style.json` |

Each row above adds a layer that draws, with no further typing: that is the bar
for this table. A row that opens the dialog but leaves a required field empty is
a bug, not an expected extra step.

The MapLibre row is worth keeping in the set: the map runs inside an `iframe`, so
it covers services a page reaches only through an embedded frame. It also carries
a style whose glyph ranges are served as `.pbf`; those are fonts, not a tileset,
and must not be offered.

Opening a service URL directly is detected too — the response is the page, so
[a WMS GetCapabilities document](https://ows.terrestris.de/osm/service?SERVICE=WMS&REQUEST=GetCapabilities)
lists `https://ows.terrestris.de/osm/service`.

Navigating the same tab elsewhere replaces the list, so a page with no services
(`https://example.com`) must come up empty rather than inheriting the page before
it.

After selecting a result, add the layer in GeoLibre and verify that the browser
console does not report a CORS error while fetching the service.

Remote servers must allow GeoLibre to fetch the selected URLs through CORS.
Complete HTTP(S) URLs, including signed query parameters, are forwarded to
GeoLibre. Cookies and other browser-session credentials are not forwarded, so
cookie-bound or session-authenticated links may fail. Temporary `blob:` and
browser-internal links cannot be transferred.
