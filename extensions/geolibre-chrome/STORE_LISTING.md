# Chrome Web Store listing

## Name

Open data in GeoLibre

## Summary

Find geospatial datasets on a webpage and open selected files together in GeoLibre.

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

Privacy is deliberately narrow: the extension scans only the active page after
you click it. It stores no browsing data, runs no analytics, and requests no
permanent access to websites.

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

The extension does not request host permissions, storage, browsing history,
downloads, cookies, or remote code.
