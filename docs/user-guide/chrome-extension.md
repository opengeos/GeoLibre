# Chrome Extension

The **Open data in GeoLibre** Chrome extension finds supported geospatial data links on the current webpage and opens the datasets you select together on one GeoLibre map.

![Select webpage datasets with the GeoLibre Chrome extension](https://assets.geolibre.app/images/geolibre-chrome.webp)

## Install the extension

Until the extension is available from the Chrome Web Store, install the packaged release manually:

1. Download [`geolibre-data-opener-0.1.0.zip`](https://github.com/opengeos/GeoLibre/releases/download/v2.6.0/geolibre-data-opener-0.1.0.zip) from the [GeoLibre v2.6.0 release](https://github.com/opengeos/GeoLibre/releases/tag/v2.6.0).
2. Extract the ZIP archive to a folder you intend to keep. Chrome loads the extension from this folder, so do not delete it after installation.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode**.
5. Select **Load unpacked** and choose the extracted `geolibre-data-opener-0.1.0` folder.
6. Pin **Open data in GeoLibre** to the Chrome toolbar for convenient access.

To update a manually installed copy, download and extract the newer release asset, then select the extension's **Reload** button on `chrome://extensions`. If you extract it to a different folder, remove the old copy and load the new folder instead.

## Open datasets from a webpage

1. Visit a webpage or data catalog containing geospatial file links.
2. Select the GeoLibre icon in the Chrome toolbar.
3. Use **All**, **Vector**, or **Raster** to filter the discovered datasets.
4. Check one or more datasets. Nothing is selected by default.
5. Select **Open in GeoLibre** to load the selected datasets on the same map.

The extension recognizes GeoJSON and spatial JSON, GeoParquet and Parquet, PMTiles, GeoTIFF and Cloud-Optimized GeoTIFF, ZIP archives containing GeoJSON, JSON-LD download metadata, and existing GeoLibre data links. On Source Cooperative repository pages, it also reads the embedded inventory so datasets outside the currently visible list can be selected.

## Access and privacy

GeoLibre fetches selected links directly, so the source server must allow cross-origin requests (CORS). Links that depend on a website login, browser session, or temporary `blob:` URL might not load in GeoLibre.

The extension requests access only to the active tab when you open it. It does not store browsing history, send analytics, or run continuously in the background.
