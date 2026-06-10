# Data Integrations

Beyond the [Add Data](adding-data.md) menu, GeoLibre connects to several hosted catalogs and imagery providers through dedicated panels and plugins. This page is a map of what is available and where to find it.

## Cloud catalogs

| Integration | Where | What it does |
| --- | --- | --- |
| **Planetary Computer** | Processing menu | Browse and load STAC data from Microsoft Planetary Computer (Sentinel, Landsat, and more). |
| **Earth Engine** | Processing menu | Browse and load Google Earth Engine datasets after authenticating. |
| **Overture Maps** | Plugins menu | Load Overture Maps data themes (such as buildings, places, and transportation). |
| **STAC** | Add Data menu | Search any STAC catalog and add matching raster items. See [Adding Data](adding-data.md#web-services). |

!!! note "Credentials"
    Earth Engine requires authentication, and some providers expect an API key or token. Set these in **Settings → Environment Variables**. See [Settings & Preferences](settings.md).

## Federal Web Services

The **Web Services** submenu of the [Plugins menu](plugins.md) bundles four United States federal data sources:

| Service | Data |
| --- | --- |
| **FEMA** | National Flood Hazard Layer (NFHL) flood data. |
| **NASA Earthdata** | NASA satellite and Earth science imagery. |
| **EPA EnviroAtlas** | Environmental and ecosystem data. |
| **USGS** | The National Map topographic and geographic layers. |

## Imagery and street-level

| Integration | Where | What it does |
| --- | --- | --- |
| **Esri Wayback** | Plugins menu | Browse historical Esri World Imagery snapshots. |
| **Street View** | Plugins menu | View Google Street View and Mapillary street-level imagery. Needs provider credentials (see [Getting Started](../getting-started.md#optional-imagery-credentials)). |

## Time series and comparison

| Plugin | What it does |
| --- | --- |
| **Time Slider** | Animate time series raster and vector data (COG, XYZ/WMTS, WMS-Time, and time-filtered GeoJSON) through a docked timeline. |
| **Layer Swipe** | Compare two layers side by side with a swipe handle. |
| **GeoAgent** | AI-assisted geospatial analysis. |

All of these are activated from the [Plugins menu](plugins.md), where you can also set their on-map position.
