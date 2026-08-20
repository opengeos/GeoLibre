# Open data in GeoLibre

A Manifest V3 Chrome extension that finds supported geospatial dataset links on
the current page, reads back the geospatial service requests its interactive
maps have already made, and opens selected data in GeoLibre.

## Install

The published extension is on the Chrome Web Store:

[Open data in GeoLibre](https://chromewebstore.google.com/detail/open-data-in-geolibre/joinecgbfoldanidcoakpjgkbaceaooj)

## Install locally (development)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extensions/geolibre-chrome` directory.

Everything happens after you click the toolbar icon: the extension scans the
document's links, and reads each reachable frame's Resource Timing buffer to
recognize the
services its maps requested. It holds no permission beyond `activeTab` and
`scripting`, runs no background service worker, and stores nothing.

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

## Services

A map fetches its tiles and service documents from JavaScript, so they are never
links in the page. What the extension reads instead is `performance
.getEntriesByType("resource")`, the record of its own requests that every
document keeps, collected from the top frame and every same-origin frame below
it. Recognized
are WMS, WMTS, WFS, OGC API Features, ArcGIS Feature Services, XYZ/TMS image
tiles, and PBF/MVT vector tiles. Tile requests are collapsed into reusable
`{z}/{x}/{y}` templates, and repeated requests from the same service appear once.

Three consequences of reading the buffer rather than watching the network:

- **Worker requests are invisible.** MapLibre and similar renderers fetch vector
  tiles from a web worker, which records them in the worker's own timeline, not
  the document's. Such a tileset is recovered from the metadata the main thread
  *did* fetch: its TileJSON, or failing that the style document, which GeoLibre
  can resolve a layer from on its own. A style is only offered in its own right
  when no tileset from its origin was found.

  A TileJSON is recognized by name (`tile.json`, `tiles.json`, `tilejson.json`),
  which is narrower than every way a server can name one: tileserver-gl serves
  `/data/<id>.json`, and that tileset is reached through its style rather than
  its metadata. Nothing reads the response, so a TileJSON describing *raster*
  tiles is indistinguishable from a vector one and is offered as a vector
  tileset. Such a false positive cannot become a layer: Add Data resolves the
  document on submit and refuses it when no source layers come out. Reading the
  body here would mean fetching a cross-origin URL, which needs the host
  permissions this design exists to avoid.

  A style stands as a candidate of its own only when its path names it one:
  `…/style.json`, `…/styles.json`, or an ArcGIS `…/resources/styles/<name>.json`.
  The looser `…/styles/<name>.json` is an ordinary theme or configuration route
  as well, so a style matched that way is still trusted to explain a tileset
  found at its origin, but never offered on its own, where a page's theme file
  would appear as a layer.
- **The buffer is finite.** It holds 250 entries per document by default and
  stops recording once full. A map's own early requests are normally well inside
  that, but a very busy page can lose a service added late. Raising the limit
  needs a `document_start` script, which needs the broad host permissions this
  design exists to avoid, so the cap is accepted.
- **Cross-origin frames are out of reach.** `activeTab` grants the tab's main
  frame origin, and Chrome deliberately does not extend that grant to a frame
  from another origin. `allFrames: true` therefore reaches the top frame and its
  same-origin frames; injection into a cross-origin frame is refused, and the
  refusal is per-frame, so the frames that *are* reachable still return their
  buffers. A map that runs entirely inside a cross-origin `iframe` is thus
  invisible to the scan, and the popup reports no services rather than an error.
  Reaching one needs host permission for that origin — the standing access this
  design exists to avoid — so the boundary is accepted.

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
map, so what it detects is what a real page actually requests.

| Service | Website | Detected service | Layer carried over |
| --- | --- | --- | --- |
| WMS | [OpenLayers "Image WMS" example](https://openlayers.org/en/latest/examples/wms-image.html) | `https://ahocevar.com/geoserver/wms` | `topp:states` |
| WMTS | [OpenLayers "WMTS" example](https://openlayers.org/en/latest/examples/wmts.html) | The `GetTile` request as a tile template | `sgmc2` |
| WFS | [OpenLayers "WFS" example](https://openlayers.org/en/latest/examples/vector-wfs.html) | `https://ahocevar.com/geoserver/wfs` | `osm:water_areas` |
| OGC API Features | [pygeoapi lakes collection](https://demo.pygeoapi.io/master/collections/lakes/items?f=html) | `https://demo.pygeoapi.io/master/collections/lakes/items` | — |
| ArcGIS Feature Service | [OpenLayers "Vector ESRI" example](https://openlayers.org/en/latest/examples/vector-esri.html) | The `…/FeatureServer/0` layer URL | `0` |
| XYZ raster tiles | [openstreetmap.org](https://www.openstreetmap.org/) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | — |
| Vector tiles, in a same-origin `iframe` | [MapLibre "Display a map" example](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-map/) | `https://demotiles.maplibre.org/tiles/tiles.json` | style `…/style.json` |

Each row above adds a layer that draws, with no further typing: that is the bar
for this table. A row that opens the dialog but leaves a required field empty is
a bug, not an expected extra step.

The MapLibre row is worth keeping in the set: the map runs inside a same-origin
`iframe` (the docs page embeds `../display-a-map.html`), so it covers services a
page reaches only through an embedded frame — the reachable kind, since a
cross-origin frame is outside `activeTab` — and it renders
through a worker, so it covers the tileset recovered from its TileJSON rather
than from a tile request. It also carries a style whose glyph ranges are served
as `.pbf`; those are fonts, not a tileset, and must not be offered.

Opening a service URL directly is detected too — the response is the page, so
[a WMS GetCapabilities document](https://ows.terrestris.de/osm/service?SERVICE=WMS&REQUEST=GetCapabilities)
lists `https://ows.terrestris.de/osm/service`.

A document's buffer is its own and is discarded when the tab navigates, so a page
with no services (`https://example.com`) comes up empty rather than inheriting
the page before it.

After selecting a result, add the layer in GeoLibre and verify that the browser
console does not report a CORS error while fetching the service.

Remote servers must allow GeoLibre to fetch the selected URLs through CORS.
Complete HTTP(S) URLs, including signed query parameters, are forwarded to
GeoLibre. Cookies and other browser-session credentials are not forwarded, so
cookie-bound or session-authenticated links may fail. Temporary `blob:` and
browser-internal links cannot be transferred.
