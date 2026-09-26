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
| **Web Services** | A submenu of catalog and service browsers: FEMA NFHL, NASA Earthdata, US EPA EnviroAtlas, USGS National Map, USGS NLDI, Vantor Open Data, Planet Open Data, Earthdata GIS, OpenAerialMap, ArcGIS Hub, Socrata, CKAN, STAC Catalogs, Source Cooperative, Natural Earth, Hugging Face, Satellite Embeddings, Fields of the World, Ocean Data Platform, and GeoLens. See [Web Services](web-services.md). |
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
| **God's Eye View** | Explore live earthquakes, satellite orbits, flights, transit, public cameras, bike share, radio stations, infrastructure, and more on the Cesium globe. Feed toggles and clock speed are saved with the project. |
| **SamGeo** | Segment imagery into vector features. See [AI Segmentation](segmentation.md). |

Most entries open a submenu that **activates** the plugin and **positions** its on-map control in any corner: top left, top right, bottom left, or bottom right. A few behave differently: **Flight Simulator** and **SamGeo** toggle directly with no submenu, and **Web Services** and **DGGS** open a list of their sub-plugins instead.

God's Eye View is inspired by the MIT-licensed
[bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view),
including its public-feed selection and normalization approach. Each enabled
layer adds its provider credit to Cesium's **Data attribution** control. The
datacenter, dam, and current-view infrastructure feeds use OpenStreetMap data
under ODbL; Radio Browser is public domain; USGS earthquake data is U.S. public
domain; CelesTrak requests citation; live transit combines MBTA, CapMetro,
Metro Transit, HSL, OVapi, Entur, and TransLink feeds under their respective
public-data terms; and the live TeleGeography cable feed is read from GeoLibre's
Source Cooperative mirror under CC BY-NC-SA 3.0, including its NonCommercial
restriction. Public camera imagery comes from TfL, Austin, Calgary, Fintraffic,
Ontario 511, DriveBC, Live Traffic NSW, and Caltrans under each provider's
public-data terms.

Two layers use a key of your own, entered under **API keys** at the bottom of
the panel. **Live AIS Vessels** streams ship positions from
[AISStream](https://aisstream.io/) for the current view (up to 30° across) and
shows nothing without a key. **Simulated Street Traffic** works keyless; with a
[TomTom](https://developer.tomtom.com/) key it also draws live congestion and
paces its vehicles by it. Keys typed there stay in the browser and are never
written to the project; `VITE_TOMTOM_API_KEY` or `AISSTREAM_API_KEY` under
**Settings → Environment variables** works too.

![A plugin submenu, with Activate above the four map-corner positions](https://assets.geolibre.app/images/geolibre-plugin-position-menu.webp)

!!! note "Components live on the Controls menu"
    Measure, Bookmark, Legend, Colorbar, Minimap, View State, Search, and HTML are on-map component panels rather than Plugins-menu entries; toggle them from the [Controls menu](map-controls.md). The Print composer is under [Project → Print Layout](projects.md#print).

## Open a plugin from a link

Add `plugin=<link name>` to a GeoLibre web address to open the app with that
plugin already active, as if you had picked it from the Plugins menu:

```text
https://web.geolibre.app/?plugin=nasa-earthdata
```

List several with commas (`?plugin=graticule,h3-grid`). The full plugin id, such
as `maplibre-gl-nasa-earthdata`, works too. See
[Deep-linking a plugin](embedding.md#deep-linking-a-plugin) for how it combines
with a shared project and the read-only viewer.

| Plugin | Link name |
| --- | --- |
| Layer Control | `layer-control` |
| GeoEditor | `geo-editor` |
| Annotations | `annotations` |
| Dimensions | `dimensions` |
| Basemaps | `basemap-control` |
| FEMA NFHL | `fema-wms` |
| NASA Earthdata | `nasa-earthdata` |
| US EPA EnviroAtlas | `enviroatlas` |
| USGS National Map | `national-map` |
| USGS NLDI | `usgs-nldi` |
| Vantor Open Data | `vantor` |
| Planet Open Data | `planet-open-data` |
| Portolan | `portolan` |
| Earthdata GIS | `earthdata-gis` |
| OpenAerialMap | `openaerialmap` |
| OSM Downloader | `osm-downloader` |
| IGN LiDAR HD Downloader | `ign-lidar-hd` |
| ArcGIS Hub | `arcgis-hub` |
| Tennessee GIS | `tennessee-gis` |
| Socrata | `socrata` |
| CKAN | `ckan` |
| STAC Catalogs | `stac-catalogs` |
| Source Cooperative | `source-coop` |
| Natural Earth | `natural-earth` |
| Hugging Face | `huggingface` |
| Satellite Embeddings | `satellite-embeddings` |
| Fields of the World | `fields-of-the-world` |
| Ocean Data Platform | `ocean-data-platform` |
| GeoLens | `geolens` |
| Historical Imagery | `esri-wayback` |
| Time Slider | `time-slider` |
| Timelapse | `timelapse` |
| Overture Maps | `overture-maps` |
| GeoAgent | `geoagent` |
| USGS LiDAR | `usgs-lidar` |
| Street View | `streetview` |
| Mapillary | `mapillary` |
| Elevation Profile | `elevation-profile` |
| Layer Swipe | `swipe` |
| Gridlines | `graticule` |
| H3 Grid | `h3-grid` |
| S2 Grid | `s2-grid` |
| A5 Grid | `a5-grid` |
| DGGRID | `dggrid` |
| DGGAL | `dggal` |
| OLC | `olc` |
| Geohash | `geohash` |
| Tilecode | `tilecode` |
| Clouds | `clouds` |
| Precipitation | `precipitation` |
| Atmospheric Effects | `atmosphere-effects` |
| Sun Simulation | `sun` |
| Route Animation | `route-animation` |
| Flight Simulator | `flight-simulator` |
| God's Eye View | `gods-eye-view` |
| SamGeo | `samgeo` |
| Deck.gl Layer | `deckgl-viz` |
| Components | `components` |

Directions and reverse geocoding are not listed: they send what you click to a
public server, so they only open from the menu, after their one-time notice.
Plugins installed from **Manage Plugins** can't be opened from a link.

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

## USGS NLDI

See [USGS NLDI workflows](usgs-nldi.md) for point-to-flowline tracing,
hydrolocation, upstream basin, COMID navigation, and GeoJSON export. It is
activated from the [Web Services](web-services.md) submenu.
