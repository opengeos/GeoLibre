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

After loading or reloading the unpacked extension, open one of these URLs in a
new tab and wait for its response to finish. Then open the extension and confirm
that it lists the expected service. Selecting the result should open the
matching GeoLibre Add Data dialog with the service URL filled in.

| Service | Sample website | Expected result |
| --- | --- | --- |
| WMS | [GeoServer WMS capabilities](https://ahocevar.com/geoserver/wms?service=WMS&request=GetCapabilities) | `https://ahocevar.com/geoserver/wms` |
| WMTS | [NASA GIBS WMTS capabilities](https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities) | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi` |
| WFS | [GeoServer WFS capabilities](https://ahocevar.com/geoserver/wfs?service=WFS&request=GetCapabilities) | `https://ahocevar.com/geoserver/wfs` |
| OGC API Features | [pygeoapi collections](https://demo.pygeoapi.io/master/collections) | `https://demo.pygeoapi.io/master/collections` |
| ArcGIS Feature Service | [USA Major Cities layer](https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/USA_Major_Cities/FeatureServer/0?f=json) | The parent `FeatureServer` URL |
| XYZ raster tiles | [OpenStreetMap tile](https://tile.openstreetmap.org/0/0/0.png) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |

After selecting a result, add the layer in GeoLibre and verify that the browser
console does not report a static-file CORS error.

Remote servers must allow GeoLibre to fetch the selected URLs through CORS.
Complete HTTP(S) URLs, including signed query parameters, are forwarded to
GeoLibre. Cookies and other browser-session credentials are not forwarded, so
cookie-bound or session-authenticated links may fail. Temporary `blob:` and
browser-internal links cannot be transferred.
