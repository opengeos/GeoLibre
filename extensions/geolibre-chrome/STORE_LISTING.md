# Chrome Web Store listing

Published listing:
<https://chromewebstore.google.com/detail/open-data-in-geolibre/joinecgbfoldanidcoakpjgkbaceaooj>

## Name

Open data in GeoLibre

## Summary

Find geospatial datasets and map services on a webpage and open them in GeoLibre.

## Detailed description

Open data in GeoLibre turns dataset catalogs, documentation pages, and project websites into launch points for an interactive map.

Click the extension icon to find supported data links on the current page, filter them by vector or raster type, choose the files you need, and open them together in GeoLibre. Supported links include GeoJSON, GeoParquet, PMTiles, Cloud-Optimized GeoTIFF, and ZIP archives containing GeoJSON.

The extension also reads schema.org download metadata, understands existing GeoLibre links, pairs matching GeoLibre style files, and discovers the complete file inventory on virtualized Source Cooperative repository pages.

Interactive maps are supported too. The extension recognizes the WMS, WMTS, WFS, OGC API Features, ArcGIS Feature Service, XYZ/TMS, and vector-tile requests the current page has already made.

The extension reads the page only when you click its icon, holds no standing access to any website, stores nothing, and runs nothing in the background. It runs no analytics and sends no browsing activity to GeoLibre unless you explicitly select an item and open it.

Dataset servers must allow browser access through CORS. Complete HTTP(S) URLs, including signed query parameters, are forwarded to GeoLibre. Cookies and other browser-session credentials are not forwarded, so cookie-bound or session-authenticated links may fail. Temporary `blob:` links cannot be transferred.

## Category

Developer Tools

## Language

English

## Permission justification

Each block below is self-contained and is pasted verbatim into the matching field of the Chrome Web Store dashboard's Privacy tab. Keep them in sync with `manifest.json`: a permission added there needs a justification here and in the dashboard, or the version is rejected. As of 0.3.0 the manifest requests `activeTab` and `scripting` and nothing else, so the storage, webRequest, and host-permission fields no longer appear.

### activeTab

activeTab grants temporary access to the current page only after the user clicks the extension's toolbar icon. The extension uses that access to read the page's links and structured metadata and pick out geospatial datasets, such as GeoJSON, GeoParquet, PMTiles, Cloud-Optimized GeoTIFF, and ZIP archives containing GeoJSON, which it then lists in the popup for the user to choose from. Access ends when the user leaves or reloads the page, and no page content is read at any other time.

### scripting

scripting injects two packaged functions into the active tab when the user opens the popup. One reads the page's links and metadata to find dataset files. The other reads back the addresses of the requests the page has already made, so the map services it draws can be recognized; a map fetches those from JavaScript, so they are never links in the document. Both functions are contained in the extension package, so no remote code is involved. They run once per invocation and return their results to the popup.

### Not requested

The extension requests no host permissions, and no permission to watch network requests, store data, or run in the background. It does not request browsing history, downloads, cookies, tabs beyond the active one, or remote code. Answer "No, I am not using remote code": every script it runs ships inside the package.
