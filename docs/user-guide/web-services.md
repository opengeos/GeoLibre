# Web Services

**Plugins → Web Services** is a submenu of catalog and service browsers. Each entry connects to one public (or self-hosted) data provider, searches it, and adds what you pick to the map as a normal GeoLibre layer.

They are grouped together because they behave the same way, not because they share a data source: every one of them opens a **docked side panel** rather than a floating on-map control, so it sits alongside the Layers and Style panels, resizes with them, and can be collapsed. That is also why these entries have no "position" submenu — unlike most plugins, there is no on-map control to place in a corner.

![The Plugins menu with the Web Services submenu open, listing all seventeen catalog and service browsers](https://assets.geolibre.app/images/web-services-menu.webp)

## How the panels behave

- **Activating** an entry opens its panel; closing the panel deactivates the plugin. A check mark next to **Web Services** in the Plugins menu means at least one of them is active.
- **Layers you add are real layers.** Whatever a panel puts on the map is mirrored into the GeoLibre layer store, so it appears in the [Layers panel](layers.md), can be reordered, hidden, restyled, and removed there, and is saved into the `.geolibre.json` [project file](projects.md). Reopening the project restores the layer and hands it back to its panel.
- **The catalog browsers are mutually exclusive.** STAC Catalogs and Planet Open Data share panel state, so activating one deactivates the other; if the switch fails, the plugin that was displaced comes back.
- **Nothing here needs an account** except Hugging Face uploads (a user access token) and GeoLens private datasets (an API key).

## At a glance

| Panel | Provider | What you get |
| --- | --- | --- |
| [FEMA NFHL](#fema-nfhl) | FEMA | National Flood Hazard Layer WMS layers |
| [NASA Earthdata](#nasa-earthdata) | NASA GIBS | 1,100+ pre-rendered global imagery layers, by date |
| [US EPA EnviroAtlas](#us-epa-enviroatlas) | EPA | Environmental and ecosystem map services |
| [USGS National Map](#usgs-national-map) | USGS | Topo, imagery, hydrography, elevation, and index services |
| [USGS NLDI](#usgs-nldi) | USGS | Flowline tracing, hydrolocation, basins, and network navigation |
| [Vantor Open Data](#vantor-open-data) | Vantor | Disaster-event satellite imagery (COG) |
| [Planet Open Data](#planet-open-data) | Planet Labs | Planet's disaster data releases, through the STAC browser |
| [Earthdata GIS](#earthdata-gis) | NASA EOSDIS | ArcGIS image, map, and feature services, and published web maps |
| [OpenAerialMap](#openaerialmap) | OpenAerialMap | Openly licensed drone and aerial imagery |
| [ArcGIS Hub](#arcgis-hub) | Esri | Public datasets published to ArcGIS Hub |
| [Socrata](#socrata) | Socrata | Government open-data portals |
| [CKAN](#ckan) | HDX | Humanitarian Data Exchange resources |
| [STAC Catalogs](#stac-catalogs) | any STAC | Any STAC API or static catalog, via STAC Index |
| [Source Cooperative](#source-cooperative) | Source.coop | Cloud-native products (PMTiles, GeoParquet, COG) |
| [Natural Earth](#natural-earth) | Natural Earth | The Natural Earth vector and raster themes |
| [Hugging Face](#hugging-face) | Hugging Face | Geospatial files in dataset repos — and uploads |
| [GeoLens](#geolens) | your server | A self-hosted spatial catalog |

---

## FEMA NFHL

Searches the [FEMA National Flood Hazard Layer](https://www.fema.gov/flood-maps/national-flood-hazard-layer) WMS service and adds its layers — Flood Hazard Zones, FIRM Panels, LOMAs, Base Flood Elevations, and the rest — as raster layers.

- Filter the layer list by name and check layers on or off; each one becomes its own map layer.
- Per-layer opacity, and a legend fetched on demand through `GetLegendGraphic`.
- **Feature info**: click the map to query the active layers via `GetFeatureInfo` and read the attributes in a popup.
- **Zoom to layer extent**, taken from the service capabilities.
- **Insert before** places new layers beneath an existing map layer (for example, below basemap labels).

![The FEMA NFHL panel with Flood Hazard Zones checked, drawn over Miami Beach at 55% opacity](https://assets.geolibre.app/images/web-services-fema-nfhl.webp)

## NASA Earthdata

Browses [NASA GIBS](https://earthdata.nasa.gov/gibs) (Global Imagery Browse Services), the pre-rendered global imagery tiles behind Worldview.

- Search 1,100+ raster layers by title or identifier, or browse them grouped by platform and instrument (MODIS, VIIRS, MERRA-2, …).
- **Time-enabled layers get a date picker.** Add the same layer more than once with different dates to compare them side by side.
- Visibility toggle, legend, opacity slider, and removal for each added layer, plus an **Insert before** selector.

!!! tip "GIBS dates"
    Some GIBS products publish with a lag, so today's date can return empty tiles. Step back a day if a layer looks blank.

![The NASA Earthdata panel with MODIS Aqua true-color imagery on the globe and a date picker under Added layers](https://assets.geolibre.app/images/web-services-nasa-earthdata.webp)

## US EPA EnviroAtlas

Browses [EPA EnviroAtlas web services](https://www.epa.gov/enviroatlas/enviroatlas-web-services) — environmental, ecosystem, and community health data for the United States.

- A collapsible tree of folders, services, and individual sublayers, with a **deep search** that matches sublayer names too (searching "tree cover" or "asthma" finds the specific layers, not just the parent services).
- Adds ArcGIS **MapServer** and **ImageServer** services as MapLibre raster layers, reprojected to Web Mercator on the fly.
- Requests are clamped to each service's data extent, and the map zooms to a layer's extent as it is added.
- Visibility, opacity, legend, removal, and an **Insert before** selector per layer.

## USGS National Map

Browses the [USGS National Map services](https://apps.nationalmap.gov/services/) catalog, grouped into Basemaps, Hydrography, Elevation, Imagery, Cartography, Hazards, Other Data, and Indexes.

- Search by name, title, description, or category; matching categories expand automatically.
- The catalog is fetched live from the USGS ArcGIS REST endpoints, with a bundled static catalog as an instant fallback.
- Cached tile services, dynamic map exports, and ImageServer exports all arrive as raster layers.
- Visibility, opacity, removal, and an **Insert before** selector per layer.

No API key is required; every endpoint is CORS-enabled.

## USGS NLDI

Traces a clicked point onto the National Hydrography Dataset network: flowline and raindrop path, hydrolocation and COMID, the upstream basin, and network navigation to streamgages, wells, HUC12 pour points, and other catalogs.

Unlike the other entries, this one is a click-driven analysis workflow rather than a catalog search. See **[USGS NLDI workflows](usgs-nldi.md)** for the full walkthrough, including exporting the traced results to GeoJSON or copying them into the Layers panel.

## Vantor Open Data

A STAC explorer for [Vantor's](https://www.vantor.com/) open disaster imagery releases.

- Filter scenes by **event** and by **phase** (pre-event or post-event).
- Restrict the search to the current view or to a **bounding box drawn on the map**; footprints render on the map and highlight as you hover a result.
- Cloud-Optimized GeoTIFFs are added through GeoLibre's own raster path, so they become persistent layers you can restyle — and you can pick the **COG rendering engine** (GPU/deck.gl, the WebAssembly tiler, or a TiTiler server).
- Download the source scene.

## Planet Open Data

The same panel as [STAC Catalogs](#stac-catalogs), pinned to [Planet Labs PBC's](https://www.planet.com/disasterdata/) continuously updated disaster data releases so the catalog is already selected when it opens. Everything below about searching, filtering, and adding assets applies here too.

## Earthdata GIS

Searches NASA's [Earthdata GIS portal](https://gis.earthdata.nasa.gov) — the ArcGIS services EOSDIS publishes for its DAACs and disaster responses.

This is a different catalog from [NASA Earthdata](#nasa-earthdata) above: GIBS serves pre-rendered global imagery tiles, while Earthdata GIS serves analysis-ready ArcGIS services.

- **ImageServer** and **MapServer** items are added as raster layers rendered through their export endpoints.
- **FeatureServer** items are added as GeoJSON vector layers, arriving with attributes, styling, and export intact.
- Published **web maps** are expanded into their constituent layers.
- An ArcGIS service can be **exported to a Cloud-Optimized GeoTIFF**; GeoLibre re-encodes the plain GeoTIFF ArcGIS returns, since ArcGIS has no COG output of its own.

## OpenAerialMap

Searches [OpenAerialMap](https://openaerialmap.org/), the open catalog of drone and aerial imagery.

- Search by the **current map view**, a **box drawn on the map**, or typed coordinates.
- Result footprints are drawn on the map as a single entry in the Layers panel, so you can hide or restyle them; the selected footprint is highlighted separately.
- Add a scene to the map, zoom to its footprint, inspect its metadata, or download the source GeoTIFF.

## ArcGIS Hub

Searches public datasets published to [ArcGIS Hub](https://hub.arcgis.com/).

- Search by keyword, or tick **Search the current map area** to restrict results to the view.
- Each card shows the description and links out to the dataset's Hub page.
- **Add to map** loads supported layers, **Zoom** frames them, and **Download** saves the data. A dataset with several layers downloads only the first, and the panel tells you so.
- Results are paged: the panel shows how many of the total you are looking at, with **Load more** to continue.

![The ArcGIS Hub panel showing search results for national park boundaries, with the NPS feature service added to the map](https://assets.geolibre.app/images/web-services-arcgis-hub.webp)

## Socrata

Searches public [Socrata](https://dev.socrata.com/) open-data catalogs — the platform behind many city, county, and state data portals — and adds their GeoJSON datasets to the map. Keyword search, paged results, and **Load more**, the same as ArcGIS Hub.

## CKAN

Searches the [Humanitarian Data Exchange](https://data.humdata.org/) CKAN catalog and adds its available GeoJSON resources.

!!! note "Why some searches route through a proxy"
    HDX does not send CORS headers to browsers, so the web build routes this search through GeoLibre's public tiles Worker. The desktop app queries the API directly over native HTTP. The same applies to the OpenAerialMap metadata API and the Source Cooperative catalog.

## STAC Catalogs

A general-purpose [STAC](https://stacspec.org/) browser that works with any STAC API or static catalog.

- **Pick a catalog** from [STAC Index](https://stacindex.org/), or paste a catalog/API URL. Static catalogs are browsed as a tree; APIs are searched.
- **Filter** by collection (multi-select), date range, and area — the current map extent, a typed bounding box, or a box drawn on the map. STAC APIs also accept extra JSON search parameters.
- **Add an asset** to the map. GeoTIFF/COG, GeoJSON, GeoParquet, PMTiles, and Zarr (including Icechunk repositories) are supported; unsupported assets say so rather than failing silently.
- **Raster rendering options** — bands, colormap, min/max, and NoData — apply to assets added after you change them. The COG rendering engine picker is global: it applies to every raster on the map, including ones already added.
- Search-result footprints are drawn as their own layer, and each item can be zoomed to, added, or downloaded.

![The STAC Catalogs panel connected to Earth Search, with a Sentinel-2 true-color scene added over New Orleans](https://assets.geolibre.app/images/web-services-stac-catalogs.webp)

## Source Cooperative

Browses [Source Cooperative](https://source.coop) — a repository of large, cloud-native open datasets.

- Filter the catalog, or jump straight to an `account/product` reference.
- Browse a product's files with their sizes and formats, then add one to the map or download it.
- Adding delegates to the same code paths as [Add Data](adding-data.md): PMTiles archives, GeoParquet and other vector formats, and COG rasters all land in the Layers panel exactly as if you had added the file by hand. Large GeoParquet can be **streamed** rather than fully downloaded.

## Natural Earth

The Source Cooperative panel pinned to the [Natural Earth](https://www.naturalearthdata.com/) product, so it opens directly on the file list with no catalog or search step. Because the listing is live, it always reflects what is actually published rather than a copy that can drift.

## Hugging Face

Browses geospatial data in [Hugging Face](https://huggingface.co/datasets) dataset repositories, and is the one panel here that can also **write**.

- **Browse** — search the Hub or name an account, walk a repo's folders, and add its vector and raster files to the map (PMTiles, GeoParquet and friends, COG), through the same paths Add Data uses.
- **Upload** — with a user access token, create a dataset repo and push files into it.

The access token is stored in `localStorage` under your control, sent only as a bearer header to the Hugging Face API, and never written into a layer URL or a saved project.

## GeoLens

Connects to a self-hosted [GeoLens](https://getgeolens.com) catalog — an open-source spatial catalog (FastAPI + PostGIS) you run on your own infrastructure, which makes it the recommended way to work with private data in GeoLibre.

- Enter your server's base URL and, for private datasets, an API key. Search the catalog; each result links back to its metadata page.
- Datasets are added over the standards GeoLens already serves: **signed vector tiles** (the scalable default), **OGC API Features** GeoJSON, or server-rendered **raster tiles**.
- Vector-tile tokens are short-lived, so the plugin re-mints them automatically before they expire — which is why this is a plugin rather than a URL you paste into Add Data.
- A dataset loaded as GeoJSON can be edited and written back to GeoLens feature by feature, when the server allows it.

The API key is kept in memory for the session only. A saved project records just the server URL and dataset id, so public datasets restore automatically while private ones stay blank until the recipient reconnects with their own key. See [Self-Hosting & Private Data](../self-hosting.md) for the deployment guide.

## Related pages

- [Plugins & Marketplace](plugins.md) — the Plugins menu and installing external plugins
- [Data Integrations](data-integrations.md) — Planetary Computer, Earth Engine, Overture Maps, imagery, and geocoding
- [Adding Data](adding-data.md) — the Add Data menu, including its own STAC, WMS, and WFS dialogs
- [Managing Layers](layers.md) — what happens to a layer once a panel adds it
