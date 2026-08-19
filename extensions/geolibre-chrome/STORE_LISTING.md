# Chrome Web Store listing

Published listing:
<https://chromewebstore.google.com/detail/open-data-in-geolibre/joinecgbfoldanidcoakpjgkbaceaooj>

## Name

Open data in GeoLibre

## Summary

Find geospatial datasets and map services on a webpage and open them in GeoLibre.

## Detailed description

Open data in GeoLibre turns dataset catalogs, documentation pages, and project
websites into launch points for an interactive map.

Click the extension icon to find supported data links on the current page,
filter them by vector or raster type, choose the files you need, and open them
together in GeoLibre. Supported links include GeoJSON, GeoParquet, PMTiles,
Cloud-Optimized GeoTIFF, and ZIP archives containing GeoJSON.

The extension also reads schema.org download metadata, understands existing
GeoLibre links, pairs matching GeoLibre style files, and discovers the complete
file inventory on virtualized Source Cooperative repository pages.

Interactive maps are supported too. The extension recognizes completed WMS,
WMTS, WFS, OGC API Features, ArcGIS Feature Service, XYZ/TMS, and vector-tile
requests made by the current tab.

Detected service URLs stay in temporary browser session storage only until the
tab closes. The extension runs no analytics and sends no browsing activity to
GeoLibre unless you explicitly select an item and open it.

Dataset servers must allow browser access through CORS. Complete HTTP(S) URLs,
including signed query parameters, are forwarded to GeoLibre. Cookies and other
browser-session credentials are not forwarded, so cookie-bound or
session-authenticated links may fail. Temporary `blob:` links cannot be
transferred.

## Category

Developer Tools

## Language

English

## Permission justification

- `activeTab`: grants temporary access to the page only after the user invokes
  the extension, so its dataset links can be inspected.
- `scripting`: injects the local, packaged dataset scanner into that active tab.
- `webRequest` and HTTP(S) host access: observes completed requests locally to
  identify geospatial services used by interactive maps.
- `storage`: holds detected service URLs in session-only storage until their tab
  closes so the popup can display them.

The extension does not request browsing history, downloads, cookies, or remote
code.
