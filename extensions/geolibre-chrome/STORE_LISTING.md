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

Interactive maps are supported too. The extension recognizes completed WMS, WMTS, WFS, OGC API Features, ArcGIS Feature Service, XYZ/TMS, and vector-tile requests made by the current tab.

Detected service URLs stay in temporary browser session storage only until the tab closes. The extension runs no analytics and sends no browsing activity to GeoLibre unless you explicitly select an item and open it.

Dataset servers must allow browser access through CORS. Complete HTTP(S) URLs, including signed query parameters, are forwarded to GeoLibre. Cookies and other browser-session credentials are not forwarded, so cookie-bound or session-authenticated links may fail. Temporary `blob:` links cannot be transferred.

## Category

Developer Tools

## Language

English

## Permission justification

Each block below is self-contained and is pasted verbatim into the matching field of the Chrome Web Store dashboard's Privacy tab. Keep them in sync with `manifest.json`: a permission added there needs a justification here and in the dashboard, or the version is rejected.

### activeTab

activeTab grants temporary access to the current page only after the user clicks the extension's toolbar icon. The extension uses that access to read the page's links and structured metadata and pick out geospatial datasets, such as GeoJSON, GeoParquet, PMTiles, Cloud-Optimized GeoTIFF, and ZIP archives containing GeoJSON, which it then lists in the popup for the user to choose from. Access ends when the user leaves or reloads the page, and no page content is read at any other time.

### scripting

scripting injects the dataset scanner into the active tab when the user opens the popup. The scanner is packaged in the extension and is the code that reads the page's links and metadata; nothing is fetched or evaluated from a remote source. It runs once per invocation and returns the candidate dataset list to the popup.

### storage

storage provides chrome.storage.session, an in-memory area, where the extension keeps the list of map-service URLs detected in each tab so the popup can show them when the user opens it. Entries are keyed by tab id and are deleted when the tab navigates or is closed. No data is written to disk: chrome.storage.local and chrome.storage.sync are never used, and nothing is retained after the browsing session.

### webRequest

webRequest is used in observe-only mode. onBeforeRequest and onCompleted listeners read the URL of the page's own HTTP(S) requests to recognize the geospatial services an interactive map is loading: XYZ/TMS tiles, WMS, WMTS, WFS, OGC API Features, ArcGIS Feature Services, and vector tiles with their style JSON. A map requests these from JavaScript, so they never appear as links in the document and cannot be found by scanning the DOM. The extension does not use the blocking API, and does not read, modify, redirect, or cancel any request, header, or response body. Only the URL, resource type, and tab id are inspected, entirely locally in the service worker.

### Host permissions

Geospatial data and map services are published across the whole web, so the extension cannot know in advance which hosts to match. http://*/* and https://*/* serve as the URL filter for the observe-only webRequest listeners described above, and cover whichever page the user has open when they invoke the extension. No content script is declared, so nothing runs automatically on any site: the dataset scanner is injected only into the active tab, only after the user clicks the toolbar icon. The extension itself contacts no host. URLs leave the browser only when the user explicitly picks datasets and clicks Open in GeoLibre, which opens them in a new https://web.geolibre.app/ tab.

Broad host permissions put the extension into Chrome's in-depth review, which delays publishing. They cannot be narrowed: webRequest only observes hosts it holds permission for, and the pages that embed map services are not a knowable list.

### Not requested

The extension does not request browsing history, downloads, cookies, tabs beyond the active one, or remote code.
