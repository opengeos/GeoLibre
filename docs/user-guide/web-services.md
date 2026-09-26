# Web Services

**Plugins → Web Services** is a submenu of catalog and service browsers. Each entry connects to one public (or self-hosted) data provider, searches it, and adds what you pick to the map as a normal GeoLibre layer.

They are grouped together because they behave the same way, not because they share a data source: every one of them opens a **docked side panel** rather than a floating on-map control, so it sits alongside the Layers and Style panels, resizes with them, and can be collapsed. That is also why these entries have no "position" submenu — unlike most plugins, there is no on-map control to place in a corner.

![The Plugins menu with the Web Services submenu open, listing the catalog and service browsers](https://assets.geolibre.app/images/web-services-menu.webp)

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
| [OSM Downloader](#osm-downloader) | OpenStreetMap / Overpass | Buildings, roads, amenities, waterways, land use, or custom OSM tags |
| [ArcGIS Hub](#arcgis-hub) | Esri | Public datasets published to ArcGIS Hub |
| [Tennessee GIS](#tennessee-gis) | State of Tennessee | The geodata.tn.gov open GIS data portal |
| [US State GIS](#us-state-gis) | US state GIS offices | The public GIS data portals of all 50 states and DC |
| [US Local GIS](#us-local-gis) | US cities and counties | The GIS and open-data portals of about 150 large US cities, counties, and regional agencies |
| [US Federal GIS](#us-federal-gis) | US federal agencies | The public GIS portals of about 25 federal agencies, from the Census Bureau and NOAA to USGS and FEMA |
| [Socrata](#socrata) | Socrata | Government open-data portals |
| [CKAN](#ckan) | HDX | Humanitarian Data Exchange resources |
| [STAC Catalogs](#stac-catalogs) | any STAC | Any STAC API or static catalog, via STAC Index |
| [Source Cooperative](#source-cooperative) | Source.coop | Cloud-native products (PMTiles, GeoParquet, COG) |
| [Natural Earth](#natural-earth) | Natural Earth | The Natural Earth vector and raster themes |
| [Hugging Face](#hugging-face) | Hugging Face | Geospatial files in dataset repos — and uploads |
| [Satellite Embeddings](#satellite-embeddings) | Source.coop, Tessera | Pre-computed foundation-model embeddings (AlphaEarth, Tessera, Earth Index, …) |
| [Fields of the World](#fields-of-the-world) | Source.coop | Global agricultural field boundaries (2024, 2025) |
| [Ocean Data Platform](#ocean-data-platform) | HUB Ocean | Public ocean datasets: habitats, protected areas, fisheries, observations |
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

## OSM Downloader

Downloads current OpenStreetMap vector data through the public Overpass API.

- Start from the current map extent or type west, south, east, and north coordinates.
- Choose buildings, roads, amenities, waterways, land use, all tagged features, or a custom OSM tag key and optional value.
- Add the result as a normal GeoJSON layer or save it as a `.geojson` file.
- OSM nodes become points, ways follow OSM's line/area conventions, and multipolygon relations retain their outer and inner rings.

Public Overpass instances are intended for bounded interactive queries. Zoom to the area you need before downloading. To prevent accidentally requesting an enormous result, **All tagged features** is limited to 0.25 square degrees and filtered downloads are limited to 4 square degrees.

The panel identifies the source as © OpenStreetMap contributors and notes the Open Database License (ODbL); keep the required attribution when publishing derived maps or data.

## ArcGIS Hub

Searches public datasets published to [ArcGIS Hub](https://hub.arcgis.com/).

- Search by keyword, or tick **Search the current map area** to restrict results to the view.
- Each card shows the description and links out to the dataset's Hub page.
- **Add to map** loads supported layers, **Zoom** frames them, and **Download** saves the data. A dataset with several layers downloads only the first, and the panel tells you so.
- Results are paged: the panel shows how many of the total you are looking at, and the next page loads as you scroll to the end of the list (**Load more** does the same by hand).

![The ArcGIS Hub panel showing search results for national park boundaries, with the NPS feature service added to the map](https://assets.geolibre.app/images/web-services-arcgis-hub.webp)

## Tennessee GIS

Browses the State of Tennessee's [downloadable GIS data portal](https://geodata.tn.gov/) — roads, boundaries, parcels, hydrography, wildlife management areas, state parks, and the other datasets state agencies publish there.

- The panel lists the whole catalog as soon as it opens, alphabetically; type a keyword to narrow it. **Search the current map area** starts off, since most layers are statewide.
- **Add to map** loads feature services as editable vector layers and map or image services (such as statewide imagery) as raster layers. **Zoom** and **Details** work as in ArcGIS Hub, and Details opens the dataset's page on geodata.tn.gov. **Download** saves feature services as GeoJSON; map and image services only render imagery, so they have nothing to download.
- The portal is an ArcGIS Hub site, so the panel searches the groups that make up its catalog. It reads that list from the site when it opens, so datasets the state adds show up without a GeoLibre update.

## US State GIS

Browses the public GIS data portal of any US state or the District of Columbia — the state list follows [Open Source GIS Data](https://opensourcegisdata.com/state/index.html).

- Choose a state and the panel lists its catalog alphabetically; type a keyword to narrow it. Where a state has more than one portal (for example a statewide geoportal plus its transportation or natural-resources agency), a second menu picks between them. **Open portal** opens the portal's own website.
- **Add to map**, **Zoom**, **Download**, and **Details** work as in [Tennessee GIS](#tennessee-gis): feature services add as vector layers, map and image services (such as statewide imagery) as raster layers, and Download saves feature services as GeoJSON.
- Every portal listed is an ArcGIS Hub site or ArcGIS Online organization, which is what lets one panel search them all. A Hub site's catalog is read from the site when you pick it, so datasets the state adds show up without a GeoLibre update. A few states (Louisiana, Montana, Nevada, Ohio, Oklahoma, South Dakota, among others) have no Hub catalog to read, so the panel searches everything the state's ArcGIS organization publishes; expect some non-GIS items such as dashboards' source tables there. States whose main clearinghouse is not built on ArcGIS (such as PASDA or TNRIS) are represented by the agency portals that are.

## US Local GIS

Browses the public GIS and open-data portals of large US cities and counties, plus a few regional agencies (such as the Atlanta Regional Commission and Oregon Metro), for the local data a statewide portal rarely holds: parcels, zoning, building footprints, address points, street trees, bike lanes, and incident logs.

- Choose a state, then a city or county from the second menu; the panel lists that portal's catalog alphabetically, and a keyword narrows it. **Open portal** opens the portal's own website. Some large places have two portals, such as a city's open-data site next to its GIS hub (Los Angeles Open Data and Los Angeles GeoHub, Seattle Open Data and Seattle GeoData); both are listed.
- About three quarters of the portals are ArcGIS Hub sites, which behave as in [US State GIS](#us-state-gis): feature services add as vector layers, map and image services as raster layers, and Download saves feature services as GeoJSON.
- The rest are [Socrata](#socrata) portals, which many of the largest cities use (New York, Chicago, San Francisco, Seattle, Austin, Dallas). There the panel lists only datasets with a geometry column and adds each one as GeoJSON, zooming to what was loaded. A Socrata export is capped at 50,000 features, so a city-wide incident log arrives as its first 50,000 rows; filter it on the portal first for a complete subset. Socrata cannot search by extent, so **Search the current map area** is unavailable for those portals, and the result count is the number found so far rather than a total.
- Portals on other platforms (CKAN, OpenDataSoft, or custom sites such as Boston's or Pittsburgh's main portals) cannot be searched and are not listed, though their ArcGIS Hub sites are where one exists. Every listed portal was checked to return datasets in September 2026; `npm run check:gis-portals` repeats the check.

## US Federal GIS

Browses the public GIS portals of US federal agencies, for the national layers a state or city portal does not hold: Census boundaries, NOAA radar and weather warnings, USGS land cover, LANDFIRE fuels and PAD-US protected areas, NRCS soils, Fish and Wildlife Service wetlands, national transportation networks (NTAD), FEMA flood data, and NAIP imagery.

- Choose a department, then an agency from the second menu; the panel lists that agency's catalog alphabetically, and a keyword narrows it. **Open portal** opens the agency's own site. The map-area filter starts off, since most federal layers are national; turn it on to keep only datasets that cover the current view.
- Feature services add as vector layers, map and image services (radar, land cover and fuel rasters, imagery) as raster layers, and Download saves feature services as GeoJSON, as in [US State GIS](#us-state-gis).
- Agencies with an ArcGIS Hub site (Forest Service, BLM, National Park Service, Fish and Wildlife Service, FEMA, BTS, and others) are searched through the site's catalog. Agencies without one (USGS, NOAA, EPA, NRCS, NASA, the Census Bureau, NGA) are searched across everything their ArcGIS Online organization shares publicly, which is larger and includes some non-GIS items.
- The Census Bureau's own organization publishes mostly statistics (community resilience estimates, business patterns) rather than its boundary files, so TIGER boundaries (tracts, counties, ZCTAs, congressional districts) are easiest to find under **Multi-agency → Esri U.S. Federal Datasets**, which Esri maintains from the federal sources. The same menu holds the federal GeoPlatform, home of the National Geospatial Data Assets.
- HIFLD Open is not listed, since its ArcGIS Hub site no longer exists. Every listed agency was checked to return datasets in September 2026; `npm run check:gis-portals -- federal` repeats the check.

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

## Satellite Embeddings

A catalog of popular pre-computed **satellite embedding** datasets — per-pixel or per-patch vectors produced by geospatial foundation models — with search, on-map visualization, and download.

| Dataset | Layout | Resolution | Search | Visualize | Download |
| --- | --- | --- | --- | --- | --- |
| [AlphaEarth Foundations](https://source.coop/tge-labs/aef) (Google Satellite Embedding V1), 2017–2025 | 64-band raster | 10 m | ✓ | RGB composite of any three bands | Clipped GeoTIFF, source COG, VRT |
| [Tessera](https://github.com/ucam-eo/geotessera), 2017–2025 | 128-band raster | 10 m | ✓ | — | Embeddings and scales (`.npy`) |
| [Earth Index](https://source.coop/earthgenome/earthindexembeddings), 2024 | Points (GeoParquet) | ~320 m | ✓ | Points colored by principal components | Source GeoParquet |
| Clay, Major TOM, Copernicus-Embed | — | — | Links to the data source only | | |

- Pick a dataset to see its provider, model, resolution, dimensions, years, coverage, and license, with links to the data and the paper.
- Search by the **current map view** or a **box drawn on the map**, and (for annual datasets) a year. Result footprints are drawn as one entry in the Layers panel; hovering a result outlines it, and clicking a footprint scrolls to its result.
- **AlphaEarth → Visualize** adds the chosen bands (Earth Engine's `A01`, `A16`, `A09` by default) as an RGB layer, stretching de-quantized values across ±0.3 by default. When the raster rendering engine is **cog-tiler-wasm (WASM)** (the default) the whole tile becomes a regular COG layer, zoomable to full 10 m detail, with its bands and range adjustable in the Style panel; the stretch is applied to the raw int8 values, so colors differ slightly from the de-quantized stretch. The GPU and TiTiler engines cannot read these files, so on those the panel instead renders a snapshot image of the search area (from an overview when the area is large; the status line says so) rather than switching the engine for every raster on the map.
- **AlphaEarth → GeoTIFF** saves all 64 bands over the search area as a north-up GeoTIFF in the tile's UTM zone, either de-quantized to float32 (unit-length vectors, NoData as NaN) or as the raw int8 values (NoData −128). The clip is built in memory and capped at 256 MB: about 100 km² of float32 values, or 400 km² of int8.
- **Earth Index → Load points** adds the embeddings inside the search area as a point layer. Each point is colored by the top three principal components of the loaded vectors, so similar places get similar colors.

!!! note "AlphaEarth files are stored bottom-up"
    The AlphaEarth COGs on Source Cooperative put their southern row first, which many GDAL workflows do not expect. The WASM engine (cog-tiler-wasm 0.3.8 and later) and the panel's own reader flip them; the GPU engine does not yet. The panel also offers each tile's companion `.vrt`, which GDAL reads north-up. The data is licensed CC-BY 4.0: *The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.*

## Fields of the World

Browses [Fields of the World](https://fieldsofthe.world) (FTW), the global agricultural field boundaries predicted from Sentinel-2 imagery by the FTW PRUE model. It reads the same public files on [Source Cooperative](https://source.coop/ftw/global-data/) as the [FTW inference app](https://fieldsofthe.world/ftw-inference-app).

- Pick a **year** (2025 or 2024).
- **Field boundaries** adds that year's global archive as a PMTiles layer, colored by the model's confidence from red (low) to green (high). The 2025 archive has tiles at every zoom; the 2024 alpha archive starts at zoom 10, so zoom in to see its fields.
- **Field density** adds the global 500 m field-density raster as a COG layer, for the zoomed-out picture. It keeps the current view and hides itself above zoom 12, where the field boundaries take over; both can be changed in the Style panel.
- The **confidence threshold** (70% by default, as in the FTW app) hides fields the model is less confident about. It applies to every FTW field layer on the map, is saved with the project as the layer's filter, and can be edited later in the Style panel. Downloads are never filtered.
- **Search tiles** lists the 1° × 1° download tiles in the **current map view** or a **box drawn on the map** that have data for the year, most fields first, with each tile's field count and file size. Their outlines are drawn as one entry in the Layers panel; hovering a result outlines it, and clicking an outline selects its result.
- Each tile offers **Add to map** (its fields as an editable GeoJSON layer, styled and filtered like the archive), **GeoParquet** (the source file, unchanged), and **GeoJSON**. With **Only fields in the search area** checked (the default), Add to map and GeoJSON keep only the fields overlapping the search area. The file is read one row group at a time, so even the largest tiles (about 3 million fields) can be clipped to a small box; the result is limited to 250,000 fields on the map or 1,000,000 in a GeoJSON file. Download the GeoParquet for anything larger.

!!! note "Running the FTW model"
    The plugin shows and downloads the published global predictions. To run the FTW model on your own area and Sentinel-2 scenes, use the [FTW inference app](https://fieldsofthe.world/ftw-inference-app) or the [ftw-baselines](https://github.com/fieldsoftheworld/ftw-baselines) command-line tools, then add the result to GeoLibre. The data is licensed CC-BY-4.0.

## Ocean Data Platform

Browses the public datasets on HUB Ocean's [Ocean Data Platform](https://app.hubocean.earth/catalog) (ODP), which shares ocean data from research institutions, governments, and industry: benthic habitats, coral reefs, protected areas, fisheries, seafloor features, observations, and more.

- The panel loads the whole public catalog (a few hundred datasets, grouped into collections) when it opens. Type in **Search** to match every word against the title, description, collection, and keywords; titles that match rank first. Pick a **Collection** to narrow the list, or check **Only datasets in the map view** to keep those whose extent overlaps the view (the list follows the map as you pan). Datasets the catalog gives no extent for only appear with that box unchecked.
- **Add to map** streams the whole dataset as a vector tile layer with every attribute, and zooms to its extent. It is saved with the project. Tiles can take a few seconds the first time a dataset is viewed.
- **Features in view** reads the features in the current map view through OGC API Features and adds them as an editable GeoJSON layer; **GeoJSON** saves the same features to a file. Both read at most 10,000 features, and say so when the view held more: zoom in, or use Add to map for the whole dataset.
- **Zoom** fits the map to the dataset's extent, and **Details** opens its page in the ODP catalog, with its full description, provenance, and download options.

!!! note "Public datasets only"
    The panel lists and reads only datasets shared publicly on ODP; it does not sign in or take an API key. ODP's tile and features endpoints do not allow other websites to read them directly, so GeoLibre reads them through its own tile proxy (`tiles.geolibre.app`). Each dataset keeps its provider's license, shown in the result list; check it before reuse.

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
