# Data Integrations

Beyond the [Add Data](adding-data.md) menu, GeoLibre connects to several hosted catalogs and imagery providers through dedicated panels and plugins. This page is a map of what is available and where to find it.

![Planetary Computer panel](https://data.geolibre.app/images/geolibre-planetary-computer.webp)

## Cloud catalogs

| Integration | Where | What it does |
| --- | --- | --- |
| **Planetary Computer** | Processing menu | Browse and load STAC data from Microsoft Planetary Computer (Sentinel, Landsat, and more). |
| **Earth Engine** | Processing menu | Browse and load Google Earth Engine datasets after authenticating. |
| **Overture Maps** | Plugins menu | Load Overture Maps data themes (such as buildings, places, and transportation). |
| **STAC** | Add Data menu | Search any STAC catalog and add matching raster items. See [Adding Data](adding-data.md#web-services). |

!!! note "Credentials"
    Earth Engine requires authentication, and some providers expect an API key or token. Set these in **Settings → Environment Variables**. See [Settings & Preferences](settings.md).

## Self-hosted catalogs

| Integration | Where | What it does |
| --- | --- | --- |
| **GeoLens** | Plugins menu | Connect to a self-hosted [GeoLens](https://getgeolens.com) catalog, search its datasets, and add them as signed vector tiles, OGC API Features GeoJSON, or server-rendered raster tiles. |

GeoLens is an open-source spatial catalog (FastAPI + PostGIS) that you run on
your own infrastructure, which makes it the recommended way to keep private data
private while still working with it in GeoLibre. In the plugin panel, enter your
server's base URL (for example `https://maps.example.org`) and, for private
datasets, a GeoLens API key. Each result links back to its metadata page, vector
tile tokens are refreshed automatically before they expire, and a dataset loaded
as GeoJSON can be edited and written back to GeoLens feature by feature when the
server allows it.

The API key is kept in memory for the session only: it is never written to the
project file or to browser storage, so a saved project records just the server
URL and dataset id. Layers from public datasets restore automatically; layers
from private ones stay blank until the recipient reconnects with their own key.

See [Self-Hosting & Private Data](../self-hosting.md) for the full deployment
guide, including how to serve GeoLibre and GeoLens from one origin behind a
single sign-on layer.

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
| **Historical Imagery** | Plugins menu | Browse historical Esri World Imagery snapshots. |
| **Street View** | Plugins menu | View Google Street View and Mapillary street-level imagery. Needs provider credentials (see [Getting Started](../getting-started.md#optional-imagery-credentials)). |

## Time series and comparison

| Plugin | What it does |
| --- | --- |
| **Time Slider** | Animate time series raster and vector data (COG, XYZ/WMTS, WMS-Time, and time-filtered GeoJSON) through a docked timeline. |
| **Layer Swipe** | Compare two layers side by side with a swipe handle. |

## AI analysis

| Plugin | What it does |
| --- | --- |
| **GeoAgent** | AI-assisted geospatial analysis. |

All of these are activated from the [Plugins menu](plugins.md), where you can also set their on-map position.

## Geocoding

GeoLibre can turn addresses into points and points into addresses. Both run through a selectable provider; the public [Nominatim](https://nominatim.openstreetmap.org/) service is the default and needs no key.

| Tool | Where | What it does |
| --- | --- | --- |
| **Geocode Addresses** | Processing menu | Pick a CSV with an address column and geocode each row into a point layer. Each matched row keeps its original columns plus `geocode_lat`, `geocode_lon`, `geocode_display_name`, and `geocode_importance` (a match score). A per-run provider picker lets you switch backend for that batch. |
| **Delimited Text Layer → Addresses** | Add Data | Geocode a CSV/TSV at import time instead of a separate step: choose "Addresses" as the import mode, pick one or more columns to concatenate into the address (e.g. street, city, state), and each row is geocoded through the project's configured provider. Matched rows become points; rows with no match are kept (not dropped) with `geocode_status: "unmatched"` so they stay visible and fixable in the attribute table. |
| **Reverse Geocode** | Controls menu | A toggle. While on, click anywhere on the map to look up the address at that point, shown in a popup with a copy button. |

All three send coordinates or addresses to a third-party service, so the first time you enable Reverse Geocode (and whenever you run a batch, including at CSV import time) your data leaves your device for those requests. Reverse Geocode shows a one-time notice before it is first enabled.

### Providers

Choose a backend in **Settings → Geocoding**. The selection, per-provider API keys, optional endpoint overrides, and contact email are saved with the project.

| Provider | API key | Notes |
| --- | --- | --- |
| **Nominatim (OpenStreetMap)** | No | Default. Public endpoint is paced and row-capped (see below); point it at a self-hosted instance to relax both. |
| **CartoCiudad (IGN España)** | No | Official Spanish national geocoder (IGN/CNIG). Free public API, no key required. |
| **Pelias** | Optional | Hosted [geocode.earth](https://geocode.earth/) needs a key; a self-hosted Pelias does not. |
| **ArcGIS World Geocoder** | Yes | Esri token / API key. |
| **Mapbox** | Yes | Mapbox access token (`pk.…`). |
| **Google** | Yes | Google Maps Geocoding API key. Google does not officially allow browser cross-origin requests to this API, so a same-origin proxy may be required. |

API keys are stored in plain text in the `.geolibre.json` project file, so avoid sharing a project that carries them (the Project → Share flow can strip environment variables, but provider keys live under Geocoding settings).

### Usage policy and limits

Requests to the public Nominatim endpoint are paced to one per second and a single batch run is capped at 1000 rows, in line with the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). Browsers cannot set a `User-Agent`, so the app identifies itself through the page `Referer` and the optional `email` parameter.

The public CartoCiudad endpoint is paced to roughly five requests per second and is not row-capped. IGN publishes no rate limit, so this is a courtesy default rather than their policy: it keeps a large batch from bursting at a free public service without borrowing Nominatim's much stricter numbers.

Self-hosted Nominatim and the keyed providers (Mapbox, ArcGIS, Google, hosted Pelias) are not paced or capped by GeoLibre; their own quotas apply.

### Configuring with environment variables

The Geocoding settings panel is the easiest way to configure a provider, but the same values can also be set as runtime environment variables (the same `VITE_`-prefixed mechanism used for [imagery credentials](../getting-started.md#optional-imagery-credentials)). Explicit environment variables override the Settings panel.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_GEOCODER_PROVIDER` | `nominatim` | Provider id: `nominatim`, `cartociudad`, `pelias`, `arcgis`, `mapbox`, or `google`. |
| `VITE_GEOCODER_API_KEY` | unset | API key / access token for the selected provider. |
| `VITE_GEOCODER_ENDPOINT` | provider default | Forward (address to point) search endpoint override. |
| `VITE_GEOCODER_REVERSE_ENDPOINT` | provider default | Reverse (point to address) endpoint override. |
| `VITE_GEOCODER_EMAIL` | unset | Contact email sent as the `email` query parameter to identify your client to Nominatim. |
