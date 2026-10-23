# Web Services

**Plugins → Web Services** is a submenu of catalog and service browsers. Each entry connects to one public (or self-hosted) data provider, searches it, and adds what you pick to the map as a normal GeoLibre layer.

They are grouped together because they behave the same way, not because they share a data source: every one of them opens a **docked side panel** rather than a floating on-map control, so it sits alongside the Layers and Style panels, resizes with them, and can be collapsed. That is also why these entries have no "position" submenu: there is no on-map control to place in a corner.

![The Plugins menu with the Web Services submenu open, listing the catalog and service browsers](https://assets.geolibre.app/images/web-services-menu.webp)

## How the panels behave

- **Activating** an entry opens its panel; closing the panel deactivates the plugin. A check mark next to **Web Services** in the Plugins menu means at least one of them is active.
- **Layers you add are real layers.** Whatever a panel puts on the map is mirrored into the GeoLibre layer store, so it appears in the [Layers panel](layers.md), can be reordered, hidden, restyled, and removed there, and is saved into the `.geolibre.json` [project file](projects.md). Reopening the project restores the layer and hands it back to its panel.
- **The catalog browsers are mutually exclusive.** STAC Catalogs, Planet Open Data, and Portolan share panel state, so activating one deactivates the other; if the switch fails, the plugin that was displaced comes back.
- **Nothing here needs an account** except ArcGIS Portal (an ArcGIS sign-in), private S3 buckets (an S3 connection), Hugging Face uploads (a user access token), and GeoLens private datasets (an API key).

## At a glance

| Panel | Provider | What you get |
| --- | --- | --- |
| [FEMA NFHL](#fema-nfhl) | FEMA | National Flood Hazard Layer WMS layers |
| [NASA Earthdata](#nasa-earthdata) | NASA GIBS | 1,100+ pre-rendered global imagery layers, by date |
| [US EPA EnviroAtlas](#us-epa-enviroatlas) | EPA | Environmental and ecosystem map services |
| [USGS National Map](#usgs-national-map) | USGS | Topo, imagery, hydrography, elevation, and index services |
| [USGS NLDI](#usgs-nldi) | USGS | Flowline tracing, hydrolocation, basins, and network navigation |
| [USGS 3DEP](#usgs-3dep) | USGS | 3DEP digital elevation models (1 m, 1/3 and 1 arc-second, and more) |
| [USGS LiDAR](#usgs-lidar) | USGS | 3DEP LiDAR point clouds clipped to an area of interest, as COPC |
| [Vantor Open Data](#vantor-open-data) | Vantor | Disaster-event satellite imagery (COG) |
| [Planet Open Data](#planet-open-data) | Planet Labs | Planet's disaster data releases, through the STAC browser |
| [Portolan](#portolan) | Portolan Registry | Registered geospatial catalogs, or a publisher's catalog URL, through the STAC browser |
| [Earthdata GIS](#earthdata-gis) | NASA EOSDIS | ArcGIS image, map, and feature services, and published web maps |
| [NASA Earthaccess](#nasa-earthaccess) | NASA CMR / Earthdata Login | Search any NASA Earthdata dataset for granules over the map view, and download them; ICESat-2 and GEDI granules open straight onto the map |
| [OpenAerialMap](#openaerialmap) | OpenAerialMap | Openly licensed drone and aerial imagery |
| [OSM Downloader](#osm-downloader) | OpenStreetMap / Overpass | Buildings, roads, amenities, waterways, land use, or custom OSM tags |
| [IGN LiDAR HD](#ign-lidar-hd) | IGN (France) | LiDAR HD tile coverage and COPC point clouds |
| [ArcGIS Portal](#arcgis-portal) | Esri | The content of your ArcGIS Online organization or Enterprise portal, after signing in |
| [ArcGIS Hub](#arcgis-hub) | Esri | Public datasets published to ArcGIS Hub |
| [Tennessee GIS](#tennessee-gis) | State of Tennessee | The geodata.tn.gov open GIS data portal |
| [US Federal GIS](#us-federal-gis) | US federal agencies | The public GIS portals of 24 federal agencies, from the Census Bureau and NOAA to USGS and FEMA |
| [US State GIS](#us-state-gis) | US state GIS offices | The public GIS data portals of all 50 states and DC |
| [US Local GIS](#us-local-gis) | US cities and counties | The GIS and open-data portals of about 150 large US cities, counties, and regional agencies |
| [Socrata](#socrata) | Socrata | Government open-data portals |
| [CKAN](#ckan) | HDX | Humanitarian Data Exchange resources |
| [STAC Catalogs](#stac-catalogs) | any STAC | Any STAC API or static catalog, via STAC Index |
| [Source Cooperative](#source-cooperative) | Source.coop | Cloud-native products (PMTiles, GeoParquet, COG) |
| [S3 Browser](#s3-browser) | Amazon S3 / S3-compatible | Browse any bucket, public or private, and add its files |
| [Natural Earth](#natural-earth) | Natural Earth | The Natural Earth vector and raster themes |
| [Hugging Face](#hugging-face) | Hugging Face | Geospatial files in dataset repos — and uploads |
| [Satellite Embeddings](#satellite-embeddings) | Source.coop, Tessera | Pre-computed foundation-model embeddings (AlphaEarth, Tessera, Earth Index, …) |
| [Fields of the World](#fields-of-the-world) | Source.coop | Global agricultural field boundaries (2017–2025) |
| [Sentinel-2 Explorer](#sentinel-2-explorer) | Source.coop, AWS | Every Sentinel-2 L2A scene since 2015, searched from static GeoParquet |
| [Ocean Data Platform](#ocean-data-platform) | HUB Ocean | Public ocean datasets: habitats, protected areas, fisheries, observations |
| [Dynamical](#dynamical) | dynamical.org | Weather forecasts, ensembles and analyses (NOAA GFS, GEFS, HRRR and MRMS, ECMWF AIFS and IFS, DWD ICON-EU, ECCC HRDPS, NASA IMERG) as Zarr layers with forecast run, lead time and member sliders, and time-series charts at a point |
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

## USGS 3DEP

Searches The National Map for [3D Elevation Program](https://www.usgs.gov/3d-elevation-program) digital elevation models.

- Search the **current view**, a **bounding box drawn on the map**, typed **coordinates**, or a USGS **1:24,000 topographic quad** by name and state.
- Pick the **elevation datasets** (1 m DEM, 1/3 arc-second, 1 arc-second, Alaska 5 m, and others) and the file **format**, and optionally hide redundant partial tiles.
- Footprints render on the map and in the Layers panel; click one to select its result, or export them all to GeoJSON.
- **Load on Map** streams a GeoTIFF DEM through GeoLibre's raster path; **Download** saves the source file (IMG products are download-only).

## USGS LiDAR

Clips a USGS [3D Elevation Program](https://www.usgs.gov/3d-elevation-program) LiDAR point cloud to an area of interest and downloads the result as COPC. While the panel is open, a 3DEP Elevation Index layer shows where point clouds exist, and the map switches to the Mercator projection (your previous projection is restored when you close it), since the streamed point cloud does not render on the globe.

## Vantor Open Data

A STAC explorer for [Vantor's](https://www.vantor.com/) open disaster imagery releases.

- Filter scenes by **event** and by **phase** (pre-event or post-event).
- Restrict the search to the current view or to a **bounding box drawn on the map**; footprints render on the map and highlight as you hover a result.
- Cloud-Optimized GeoTIFFs are added through GeoLibre's own raster path, so they become persistent layers you can restyle — and you can pick the **COG rendering engine** (GPU/deck.gl, the WebAssembly tiler, or a TiTiler server).
- Download the source scene.

## Planet Open Data

The same panel as [STAC Catalogs](#stac-catalogs), pinned to [Planet Labs PBC's](https://www.planet.com/disasterdata/) continuously updated disaster data releases so the catalog is already selected when it opens. Everything below about searching, filtering, and adding assets applies here too.

## Portolan

The same panel as [STAC Catalogs](#stac-catalogs), opened on the public [Portolan Registry](https://github.com/portolan-sdi/portolan-registry) of catalogs. Pick a registered catalog, or enter a publisher's catalog URL to connect to it directly, then add assets as in STAC Catalogs.

## Earthdata GIS

Searches NASA's [Earthdata GIS portal](https://gis.earthdata.nasa.gov) — the ArcGIS services EOSDIS publishes for its DAACs and disaster responses.

This is a different catalog from [NASA Earthdata](#nasa-earthdata) above: GIBS serves pre-rendered global imagery tiles, while Earthdata GIS serves analysis-ready ArcGIS services.

- **ImageServer** and **MapServer** items are added as raster layers rendered through their export endpoints.
- **FeatureServer** items are added as GeoJSON vector layers, arriving with attributes, styling, and export intact.
- Published **web maps** are expanded into their constituent layers.
- An ArcGIS service can be **exported to a Cloud-Optimized GeoTIFF**; GeoLibre re-encodes the plain GeoTIFF ArcGIS returns, since ArcGIS has no COG output of its own.

## NASA Earthaccess

Searches NASA's [Common Metadata Repository](https://cmr.earthdata.nasa.gov/search) (CMR), the catalog behind Earthdata Search, and downloads files with your Earthdata Login: the in-app counterpart of the Python [earthaccess](https://earthaccess.readthedocs.io) library.

- Pick a **popular dataset** (ICESat-2 ATL03, ATL06 and ATL08, GEDI L2A, L2B and L4A, HLS, NASADEM) or search by keyword. A popular pick uses the newest version in Earthdata Cloud.
- **Search this view** lists the dataset's granules over the map view and a date range, newest first, and draws their footprints as one entry in the Layers panel. Click a footprint to find its card.
- **Open** (ICESat-2 ATL06/ATL08 and GEDI L2A/L2B/L4A) downloads the granule and hands it to [Add Data → ICESat-2 / GEDI](adding-data.md), where you pick beams and fields as for a local file.
- **Open** on an ICESat-2 **ATL03** granule does not download it: Add Data → ICESat-2 / GEDI reads the photons in the map view straight from NASA in byte ranges (several beams at once), showing how many MB have arrived. A dense daytime granule can take about a minute for a wide view; zoom in for faster reads.
- **Download** saves the granule's file (**Download all** for a multi-file granule such as an HLS scene: the desktop app asks for a folder once), **Zoom** fits the map to it, and **Details** opens it in Earthdata Search.
- **Files** lists a granule's files, each with its own **Download**; a GeoTIFF also gets **Add**, which puts it on the map as a COG layer (HLS bands, NASADEM tiles, …).

Searching needs no account. Downloading needs an [Earthdata Login](https://urs.earthdata.nasa.gov) token: paste one from your profile's **Generate Token** page, or, in the desktop app, sign in with your user name and password (only the token is kept). The token is stored in the system keychain on the desktop and in browser storage on the web. Some datasets also require accepting their EULA on the Earthdata Login site once.

NASA's data servers do not allow browser (CORS) requests, so the desktop app downloads natively and streams large files to disk, while the web app relays downloads through GeoLibre's tile service, which forwards your token to the NASA data host only and never stores it. COG layers read through that relay on both the web and the desktop app: the layer (and a saved project) keeps only the relay URL, and GeoLibre adds your saved token to its requests, so a project with NASA COG layers reopens wherever the token is saved. In the browser a download is held in memory until it is saved, so prefer the desktop app for multi-gigabyte GEDI L2A granules.

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

## IGN LiDAR HD

Searches the tile coverage of France's [IGN LiDAR HD](https://geoservices.ign.fr/lidarhd) program and adds its COPC point clouds.

- **Use map extent** and **Search tiles** list the LiDAR HD tiles in the area; their footprints are drawn as one entry in the Layers panel, and hovering a tile highlights its footprint.
- **Add to map** streams a tile as a point cloud layer (MapLibre, Mapbox, or ArcGIS renderer), and **Download** saves the COPC file. Check several tiles and choose **Add selected to map** to add them in one go.
- The data is © IGN, published under the Licence Ouverte 2.0.

## ArcGIS Portal

Browses the content of your own ArcGIS Online organization or ArcGIS Enterprise
portal, including items shared only with your organization or your groups, and
adds it to the map.

- Sign in from the panel. Leave the portal URL blank for ArcGIS Online, or enter
  your organization URL (`https://yourorg.maps.arcgis.com`) to get its sign-in
  page (including SSO), or your Enterprise portal. You need an OAuth client ID
  registered on the portal; the hosted web app fills one in for ArcGIS Online.
  See [Signing in with ArcGIS](../arcgis-editing.md#signing-in-with-arcgis).
- **Browse** picks the scope: **My content**, **My favorites**, **My groups**
  (then choose the group), **My organization**, or **All of the portal**.
  Narrow it with a keyword or an item type. Results are newest first, or by
  relevance once you type a keyword.
- **Add to map** loads feature, map, image, and vector tile services. A web map
  adds its feature, map service, and image service layers. Once added, the
  button reads **Remove from map** and removes them again; it turns back to
  **Add to map** if you remove the layers elsewhere, such as in the Layers
  panel. **Zoom** frames the item and **Details** opens its page on the portal.
- The session is the same one Add Data → ArcGIS uses, so signing in or out in
  either place applies to both. Layers you add renew their token while you stay
  signed in. **Another portal** signs in to a second portal, and the portal
  picker switches between them.
- Your sign-in token is sent only to services on the portal's own host, or on
  Esri's `arcgis.com` hosting for ArcGIS Online. A web map layer or item that
  points anywhere else is loaded without it, so only public services there load.

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

## US Federal GIS

Browses the public GIS portals of US federal agencies, for the national layers a state or city portal does not hold: Census boundaries, NOAA radar and weather warnings, USGS land cover, LANDFIRE fuels and PAD-US protected areas, NRCS soils, Fish and Wildlife Service wetlands, national transportation networks (NTAD), FEMA flood data, and NAIP imagery.

- Choose a department, then an agency from the second menu; the panel lists that agency's catalog alphabetically, and a keyword narrows it. **Open portal** opens the agency's own site. The map-area filter starts off, since most federal layers are national; turn it on to keep only datasets that cover the current view.
- Feature services add as vector layers, map and image services (radar, land cover and fuel rasters, imagery) as raster layers, and Download saves feature services as GeoJSON, as in [US State GIS](#us-state-gis).
- Agencies with an ArcGIS Hub site (Forest Service, BLM, National Park Service, Fish and Wildlife Service, FEMA, BTS, and others) are searched through the site's catalog. Agencies without one (USGS, NOAA, EPA, NRCS, NASA, the Census Bureau, NGA) are searched across everything their ArcGIS Online organization shares publicly, which is larger and includes some non-GIS items.
- The Census Bureau's own organization publishes mostly statistics (community resilience estimates, business patterns) rather than its boundary files, so TIGER boundaries (tracts, counties, ZCTAs, congressional districts) are easiest to find under **Multi-agency → Esri U.S. Federal Datasets**, which Esri maintains from the federal sources. The same menu holds the federal GeoPlatform, home of the National Geospatial Data Assets.
- HIFLD Open is not listed, since its ArcGIS Hub site no longer exists. Every listed agency was checked to return datasets in September 2026; `npm run check:gis-portals -- federal` repeats the check.

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

## S3 Browser

Browses Amazon S3 and S3-compatible buckets. Public buckets are read anonymously; private ones with the S3 connections in **Settings → Cloud Storage**, including AWS profiles, SSO, and IAM roles on the desktop app.

- Type `s3://bucket/prefix/` and press **Go**, or pick a connection and **List buckets**.
- **Add** puts COG, GeoParquet, GeoJSON, FlatGeobuf, GeoPackage, CSV, PMTiles, and COPC/LAZ/LAS point cloud files on the map through the same paths as [Add Data](adding-data.md); layers keep the `s3://` URI, never a signed URL. Tick several files and choose **Add selected** to add them in one go.
- **Set as default** makes the current folder the one the browser opens at.

See [Cloud Storage](cloud-storage.md) for connections, credential sources, and the CORS rule private buckets need on the web.

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
| [Tessera](https://registry.opendata.aws/tessera/), 2017–2025 | 128-band raster | 10 m | ✓ | RGB composite of any three bands | Embeddings and scales (`.npy`) |
| [Earth Index](https://source.coop/earthgenome/earthindexembeddings), 2024 | Points (GeoParquet) | ~320 m | ✓ | Points colored by principal components | Source GeoParquet |
| Clay, Major TOM, Copernicus-Embed | — | — | Links to the data source only | | |

- Pick a dataset to see its provider, model, resolution, dimensions, years, coverage, and license, with links to the data and the paper.
- Search by the **current map view** or a **box drawn on the map**, and (for annual datasets) a year. Result footprints are drawn as one entry in the Layers panel; hovering a result outlines it, and clicking a footprint scrolls to its result.
- **AlphaEarth → Visualize** adds the chosen bands (Earth Engine's `A01`, `A16`, `A09` by default) as an RGB layer, stretching de-quantized values across ±0.3 by default. When the raster rendering engine is **cog-tiler-wasm (WASM)** (the default) the whole tile becomes a regular COG layer, zoomable to full 10 m detail, with its bands and range adjustable in the Style panel; the stretch is applied to the raw int8 values, so colors differ slightly from the de-quantized stretch. The GPU and TiTiler engines cannot read these files, so on those the panel instead renders a snapshot image of the search area (from an overview when the area is large; the status line says so) rather than switching the engine for every raster on the map.
- **AlphaEarth → GeoTIFF** saves all 64 bands over the search area as a north-up GeoTIFF in the tile's UTM zone, either de-quantized to float32 (unit-length vectors, NoData as NaN) or as the raw int8 values (NoData −128). The clip is built in memory and capped at 256 MB: about 100 km² of float32 values, or 400 km² of int8.
- **Tessera → Visualize** reads the chosen bands (0, 1, 2 by default) of the v1.1 embeddings released on [AWS Open Data](https://registry.opendata.aws/tessera/) over the search area clipped to the 0.1° tile, de-quantizes them (int8 × the per-pixel scale), and adds them as a three-band float32 GeoTIFF raster layer in the tile's UTM zone, stretching each band to its own 2–98% range; the Style panel can re-stretch or reorder the bands, and Identify reads the embedding values. Unembedded pixels are NoData. The store has no overviews, so the read is always full 10 m resolution and costs about 1 MB per km² whichever bands you pick; it is capped at 1,300 chunks of 320 × 320 m (about 130 MB, enough for one whole tile). Chunks are fetched as a few merged byte ranges per shard rather than one request each. The status line shows the progress and the upper bound. The **`.npy`** downloads still fetch the v1 tiles.
- **Earth Index → Load points** adds the embeddings inside the search area as a point layer. Each point is colored by the top three principal components of the loaded vectors, so similar places get similar colors.

!!! note "AlphaEarth files are stored bottom-up"
    The AlphaEarth COGs on Source Cooperative put their southern row first, which many GDAL workflows do not expect. The WASM engine (cog-tiler-wasm 0.3.8 and later) and the panel's own reader flip them; the GPU engine does not yet. The panel also offers each tile's companion `.vrt`, which GDAL reads north-up. The data is licensed CC-BY 4.0: *The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.*

!!! note "Where the Tessera v1.1 data is read from"
    The AWS release (`s3://tessera-embeddings/v1.1/dclimate.icechunk`) is an Icechunk repository whose `scales` array is PCodec-encoded, which no browser Zarr reader decodes. The panel reads the publishers' plain Zarr v3 mirror of the same snapshot on [Source Cooperative](https://source.coop/tessera/tessera/zarr/v1.1-dclimate) instead. A 0.1° tile always lies in one UTM zone, so no reprojection across zones is needed.

## Fields of the World

Browses the 2nd Edition of [Fields of the World](https://fieldsofthe.world) (FTW) global data: about 1.24 billion agricultural field polygons predicted for each year from 2017 to 2025 from Sentinel-2 quarterly mosaics. It reads the public files on [Source Cooperative](https://source.coop/ftw/global-data-2e) directly; the publishers' [interactive map](https://research.taylorgeospatial.org/global-ftw-2e/web/) shows the same data.

- Pick a **year** (2017 to 2025).
- **Field boundaries** adds that year's field polygons from the global PMTiles archive, colored by score with the dataset's own bins (red below 45, through orange, yellow and light green, to green from 80). The archive draws fields from zoom 9, so zoom in to see them.
- **Field density** adds the same archive's A5 summary cells for the year, colored by the share of each cell covered by fields, for the zoomed-out picture. It hides itself from zoom 9, where the field boundaries take over; both can be changed in the Style panel.
- The **score threshold** (0 by default, so every field shows) hides fields scoring below it. The score is the model's mean field probability inside the field × 100: a ranking, not a calibrated probability, which is why the dataset's authors advise using it continuously rather than as a hard cutoff. The threshold applies to every FTW field layer the plugin added, is saved with the project as the layer's filter, and can be edited later in the Style panel. Downloads are never filtered.
- **Search area** finds the UTM zones with fields in the **current map view** or a **box drawn on the map**. Each year's fields are stored as one GeoParquet file per UTM zone (up to about 6.6 GB), sorted spatially into row groups of 8,192 fields whose extents are recorded in the file footer. The search reads only the footers (up to about 2.7 MB each) and lists each zone with how much the area needs to read. It spans at most six zones; zoom in for larger areas. The parts of the search area each zone covers are drawn as one entry in the Layers panel; hovering a result outlines it, and clicking an outline selects its result.
- Each zone offers **Add to map** (its fields overlapping the search area as an editable GeoJSON layer, styled and filtered like the archive), **GeoJSON** (the same fields saved to a file), and **GeoParquet** (the zone's whole source file). Only the overlapping row groups are fetched, and fields are kept whole rather than cut at the box. A read is limited to about 512 MB of compressed data and 250,000 fields, for the map and for a GeoJSON file alike. A zone file over 256 MB is too large to save from the app, so **GeoParquet** copies its URL instead; DuckDB, GDAL or GeoPandas can query it in place over HTTP range requests.

!!! note "Coverage and caveats"
    Only Sentinel-2 tiles with at least 1% cropland were processed, so an empty area may simply not have been mapped. A field here is a predicted remote-sensing field unit, not a cadastral or legal parcel. A field crossing a UTM zone line can appear in both zones' files. 1st Edition layers in older projects keep working, but the panel's threshold no longer drives them.

!!! note "Running the FTW model"
    The plugin shows and downloads the published global predictions. To run the FTW model on your own area and Sentinel-2 scenes, use the [FTW inference app](https://fieldsofthe.world/ftw-inference-app) or the [ftw-baselines](https://github.com/fieldsoftheworld/ftw-baselines) command-line tools, then add the result to GeoLibre. The data is licensed CC-BY-4.0.

## Sentinel-2 Explorer

Finds and views Sentinel-2 L2A imagery anywhere on Earth, the way Taylor Geospatial's [reference explorer](https://research.taylorgeospatial.org/s2-stac-geoparquet/) does. It reads the [s2-stac-geoparquet](https://github.com/taylor-geospatial/s2-stac-geoparquet) catalog on [Source Cooperative](https://source.coop/tge-labs/s2-stac-geoparquet), which republishes every scene Earth Search indexes as partitioned STAC-GeoParquet. There is no API or server behind it: each search is a set of HTTP range reads against static files, and each image streams from the scene's Cloud-Optimized GeoTIFFs on AWS.

- Pick a **collection**: **Collection 1** (ESA's uniform reprocessing, from October 2015, the default) or the original **L2A** index (from November 2016).
- Set the **From** and **To** dates. The map colors every MGRS tile by its statistics over that window, read from the catalog's small monthly stats files: the **clearest scene**'s cloud cover, the **scene count**, the **median cloud** cover, or the **coverage** (the most of the tile any one scene fills). Green is good and dark red is poor.
- The **Max cloud %**, **Min coverage %**, and **Min scenes per tile** filters grey out tiles that fail them. Max cloud and Min coverage also filter the scene list. **Show the tile grid** hides the grid without closing the panel.
- **Click a tile** to search its scenes. The panel reads only the row groups of the window's GeoParquet parts that can hold the tile, usually a few hundred KB, and reports how many range reads it took. The scenes can be sorted by least cloud, most coverage, or newest, and hovering a scene outlines its footprint.
- **Add scenes as** picks what **Add to map** streams:
    - the **true color** (TCI) image, or any **single band** (B01 to B12, B8A, AOT, WVP, the SCL scene classification, and for Collection 1 the cloud and snow probability masks), added as a COG layer and restyled in the Style panel like any raster;
    - a **composite** of several band files: **false color infrared** (B08, B04, B03), **agriculture** (B11, B08, B02), or **short-wave infrared** (B12, B8A, B04), or an **index**: **NDVI** (B08/B04) or **NDWI** (B03/B08) on a diverging ramp. Each map tile reads the bands' windows straight from their COGs at the matching overview, warps them from UTM, and paints them in the browser, so 10 m and 20 m bands combine at full resolution. Reflectance is corrected for the 1000 offset of processing baseline 04.00 and later. Composites need the MapLibre renderer.
- Once a scene is on the map in the chosen display, its button reads **Remove from map**; removing the layer in the Layers panel turns it back into **Add to map**. All of these layers are saved with the project. The selected tile is left unfilled so the scene shows through.
- **Download** lists the scene's files (TCI, every band, SCL, and the Collection 1 masks). Each opens the Cloud-Optimized GeoTIFF in your browser (the system browser on desktop), which saves it.
- **About this explorer** at the top of the panel collapses to save space.

!!! note "Data and license"
    The imagery is Copernicus Sentinel-2 data processed by ESA, indexed by Element 84's Earth Search, and hosted on the AWS Registry of Open Data. The catalog is published by Taylor Geospatial under CC-BY-4.0.

## Ocean Data Platform

Browses the public datasets on HUB Ocean's [Ocean Data Platform](https://app.hubocean.earth/catalog) (ODP), which shares ocean data from research institutions, governments, and industry: benthic habitats, coral reefs, protected areas, fisheries, seafloor features, observations, and more.

- The panel loads the whole public catalog (a few hundred datasets, grouped into collections) when it opens. Type in **Search** to match every word against the title, description, collection, and keywords; titles that match rank first. Pick a **Collection** to narrow the list, or check **Only datasets in the map view** to keep those whose extent overlaps the view (the list follows the map as you pan). Datasets the catalog gives no extent for only appear with that box unchecked.
- **Add to map** streams the whole dataset as a vector tile layer with every attribute, and zooms to its extent. It is saved with the project. Tiles can take a few seconds the first time a dataset is viewed.
- **Features in view** reads the features in the current map view through OGC API Features and adds them as an editable GeoJSON layer; **GeoJSON** saves the same features to a file. Both read at most 10,000 features, and say so when the view held more: zoom in, or use Add to map for the whole dataset.
- **Zoom** fits the map to the dataset's extent, and **Details** opens its page in the ODP catalog, with its full description, provenance, and download options.

!!! note "Public datasets only"
    The panel lists and reads only datasets shared publicly on ODP; it does not sign in or take an API key. ODP's tile and features endpoints do not allow other websites to read them directly, so GeoLibre reads them through its own tile proxy (`tiles.geolibre.app`). Each dataset keeps its provider's license, shown in the result list; check it before reuse.

## Dynamical

Browses the open weather data catalog of [dynamical.org](https://dynamical.org/catalog/), which republishes forecasts and analyses from NOAA, ECMWF, DWD, ECCC, and NASA as cloud-optimized Icechunk (Zarr) archives, updated as each model run lands. GeoLibre reads a variable straight from its archive and draws it as a Zarr raster layer.

- Pick a **Dataset**: the list loads the whole catalog when the panel opens, with the map-ready datasets first and the regional ones (see below) after them. The card below shows its summary, domain, resolution, and time range, a **Documentation** link to the dataset's page, and **Zoom to extent**.
- Pick a **Variable**, then a slice: **Forecast run** starts on the newest run and **Lead time** on the analysis hour, and the panel shows the valid time they add up to. An analysis has a single **Time** slider instead, and an ensemble adds an **Ensemble member** slider.
- **Colormap**, **Min**, and **Max** start from the variable: fixed ranges for temperature (-30 to 40 °C), percentages, wind components, precipitation rate, and sea-level pressure; for anything else leave them empty and the panel reads one chunk of the chosen slice to set a range.
- **Add to map** adds the layer, named after the dataset, variable, and slice. Moving the sliders afterward re-slices that layer in place, so you can step through a forecast; stepping lead times is quick, since each chunk already holds a run's lead times. Add the variable again to keep a slice side by side. Unlike the other panels' layers, a Dynamical layer is not restored when a saved project is reopened (true of every Zarr layer on the MapLibre renderer); add it again from the panel.
- **Time series at a point** charts the chosen variable at one grid cell: click **Pick a point on the map**, then click the map. A forecast is charted across its lead times (for the run the slider names), an analysis across time, and an ensemble as its mean over the range of its members. The series reads whole chunks around the chosen step, so the card says which steps it covers: a whole run for most forecasts and ensembles, weeks to months for an analysis, and about a day of steps for a virtual dataset, which reads one GRIB2 message per step. Hover the chart (or focus it and use the arrow keys) to read values; click a step, or press Enter, to show it on the map. **Show values** lists the numbers and **Download CSV** saves them. The point stays picked when you change the variable, dataset or run, and the chart follows. Steps the archive has no data for yet, such as a run still being published, are left as gaps.
- Projected grids are placed from the archive's own CRS: HRRR's Lambert conformal conic grid and HRDPS's rotated-pole grid.
- The low-latency *virtual* datasets (marked "virtual") do not copy the data: each chunk points at one message in the producer's own GRIB2 files on NOAA's and ECMWF's open-data buckets, which GeoLibre decodes in the browser. They carry many more variables than the copied archives, including pressure levels, and a new run appears as soon as the producer publishes it.

!!! note "Regional datasets draw when zoomed in"
    A map draws one slice, but the reader has to decode whole chunks. The forecasts dynamical.org stores one run per chunk (NOAA GFS forecast, NOAA HRRR 48-hour forecast, ECMWF AIFS Single, DWD ICON-EU, ECCC HRDPS) and the virtual datasets (one GRIB2 message per chunk) draw the whole globe in seconds. The analyses and ensembles (NOAA GFS, GEFS, HRRR and MRMS analyses, GEFS 35-day, ECMWF AIFS and IFS ensembles, NASA IMERG) pack hundreds to thousands of time steps or members into each chunk, so a whole-globe map would read gigabytes. They are listed as **Regional** and draw from a minimum zoom, worked out from the chunk size and the size of the map so a view reads at most about 256 MB: around zoom 3 to 6 for the global ones, 8 for HRRR and 9 to 10 for MRMS. The panel names that zoom, **Add to map** zooms the map in to it (over the dataset, if the view is elsewhere), and the layer hides when you zoom out past it. Moving the sliders while zoomed out reads nothing until you zoom back in, and stepping through time is quick once a region is loaded, since its chunks already hold the neighbouring steps. The data is free under CC BY 4.0; credit the source shown under the panel.

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
