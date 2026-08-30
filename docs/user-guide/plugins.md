# Plugins & Marketplace

Much of GeoLibre's functionality ships as plugins. The **Plugins** menu activates built-in plugins, and the **Manage Plugins** dialog (under Settings) installs, updates, and removes external plugins from a curated registry.

## The Plugins menu

The **Plugins** menu lists every available plugin under **Activate plugin**. Click a plugin to toggle it on or off; a check mark shows which are active.

![The Plugins menu, listing every built-in plugin under Activate plugin](https://assets.geolibre.app/images/geolibre-plugins-menu.webp)

The built-in plugins are:

| Plugin | What it adds |
| --- | --- |
| **Layer Control** | The on-map layer list. On by default. |
| **GeoEditor** | Drawing, vertex editing, and deletion tools for GeoJSON layers. |
| **Annotations** | The map-annotation toolbar and Elements panel. See [Annotations](map-controls.md#annotations-and-the-elements-panel). |
| **Basemaps** | A basemap gallery for switching the background map, from the same catalog as the [Change basemap dialog](adding-data.md#basemaps). |
| **Web Services** | A submenu of catalog and service browsers: FEMA NFHL, NASA Earthdata, US EPA EnviroAtlas, USGS National Map, Vantor Open Data, Planet Open Data, Earthdata GIS, OpenAerialMap, ArcGIS Hub, Socrata, CKAN, STAC Catalogs, Source Cooperative, Natural Earth, Hugging Face, and GeoLens. See [Data Integrations](data-integrations.md). |
| **Historical Imagery** | Browse historical aerial and satellite imagery for a location. |
| **Time Slider** | Filter a temporal layer by a date or number field. |
| **Timelapse** | Animate annual cloudless basemaps (EOX Sentinel-2, and NASA GIBS Landsat/WELD and MODIS land cover) with a provider picker and legend. |
| **Overture Maps** | Browse and add Overture Maps themes. |
| **GeoAgent** | An in-map AI agent panel. |
| **USGS LiDAR** | Clip a USGS point cloud to an area of interest and download the result as COPC. |
| **Street View** | Google Street View panoramas at a clicked point. |
| **Mapillary** | Mapillary street-level imagery. |
| **Elevation Profile** | A terrain profile along a drawn line, or along the line features currently selected on a layer. |
| **Layer Swipe** | A swipe bar comparing two layers. |
| **DGGS** | A submenu of discrete global grid overlays — H3, S2, A5, DGGRID, DGGAL, OLC, Geohash, and Tilecode — each rendering its grid over the current view, identifying a cell, and exporting the grid or selection. |
| **Flight Simulator** | Fly over terrain and 3D layers with keyboard controls. |
| **SamGeo** | Segment imagery into vector features. See [AI Segmentation](segmentation.md). |

Most entries open a submenu that **activates** the plugin and **positions** its on-map control in any corner: top left, top right, bottom left, or bottom right. A few behave differently: **Flight Simulator** and **SamGeo** toggle directly with no submenu, and **Web Services** and **DGGS** open a list of their sub-plugins instead.

![A plugin submenu, with Activate above the four map-corner positions](https://assets.geolibre.app/images/geolibre-plugin-position-menu.webp)

!!! note "Components live on the Controls menu"
    Measure, Bookmark, Legend, Colorbar, Minimap, View State, Search, and HTML are on-map component panels rather than Plugins-menu entries; toggle them from the [Controls menu](map-controls.md). The Print composer is under [Project → Print Layout](projects.md#print).

## Manage Plugins

Open **Settings → Manage Plugins** to browse the marketplace. The dialog is modeled on QGIS, with sections for **All**, **Installed**, **Not installed**, **Upgradeable**, and **Settings**.

![The Manage Plugins dialog, listing the curated registry with Install buttons](https://assets.geolibre.app/images/geolibre-manage-plugins.webp)

- **Search** the registry and **Install** an entry with one click. Installation records the plugin's manifest URL and registers it immediately, with no restart.
- **Update** appears when a newer version is published; it re-fetches and re-registers the plugin in place, keeping the old version if the update fails.
- **Uninstall** (after a confirmation) unregisters the plugin at runtime and tears down any active control.
- The **Settings** section manages additional plugin sources: extra local directories and manual manifest URLs.

Compatibility is checked against each entry's `minGeoLibreVersion`, so incompatible plugins are flagged rather than installed.

!!! note "Trust model"
    The registry is a curated allowlist, manifests require HTTPS (or HTTP on localhost, 127.0.0.1, or `[::1]` for development), and every install requires explicit consent, because plugins run as trusted code. The curated registry and the install confirmation are the primary safeguards.

## Where plugins come from

- **Curated registry**: the marketplace fetches a versioned JSON registry, hosted by default at `plugins.geolibre.app`. The registry and plugin bundles live in the [opengeos/geolibre-plugins](https://github.com/opengeos/geolibre-plugins) repository.
- **Manifest URL**: point the Settings section at any `plugin.json` manifest URL.
- **Local directory**: load a plugin from a local folder (desktop app).
- **Bundled drop-ins**: plugins placed in `public/plugins/<id>/` load automatically in a build.

## Writing your own plugin

To build a plugin, see [Reference → Plugin API](../plugin-api.md) for the TypeScript interfaces, the `plugin.json` manifest contract, and the list of built-in plugins.
