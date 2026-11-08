# Network Endpoints

This page lists the external hosts GeoLibre contacts, grouped by feature, so
that reviewers and operators can see what leaves the device and decide what to
allow. It complements the [Privacy Policy](privacy.md), which explains what is
sent, and [Self-Hosting](self-hosting.md), which explains how to keep a
deployment internal.

The list reflects the source as of GeoLibre **v3.6.1** (November 2026). It is
maintained by hand; see [Keeping this page current](#keeping-this-page-current).

## How to read this page

Each entry is marked:

- **Default**: contacted without the user choosing that service, for example
  the default basemap at startup.
- **Opt-in**: contacted only when the user picks that data source, plugin,
  tool, or service, or opens a project that uses it.

The **Builds** column says which builds make the request: **desktop** (Tauri),
**web** (the browser build, hosted or Docker), and **Jupyter** (the `geolibre`
Python widget, which embeds the web build). "All" means all three.

The **Route** column says how the request travels:

- **Direct**: from the user's browser or webview (or the desktop app's native
  HTTP client) straight to the host.
- **Relay**: through a GeoLibre-operated proxy. The relays are described under
  [GeoLibre-operated hosts](#geolibre-operated-hosts). A relay sees the request
  (including any area of interest or query) and forwards it to a fixed upstream.

Requests to the app's own origin (the web build's assets, `deployment.json`,
`geolibre-runtime-config.js`, and the Docker image's `/sidecar` proxy to the
local Python sidecar) are not external and are not listed. Neither are user
supplied URLs (a WMS endpoint, a COG URL, an S3 bucket) or the data hosts a
project's layers point at: GeoLibre fetches whatever the user or project points
it at. A network allowlist built from this page alone will block those layers,
so add the hosts your projects use.

## Default requests

These are the requests this page found a fresh install making without the user
choosing a service, from a review of the source rather than an automated check.
GeoLibre has no telemetry and no crash reporting in any build.

| Host | What and when | Builds | Route | How to change it |
| --- | --- | --- | --- | --- |
| `tiles.openfreemap.org` | The default basemap (OpenFreeMap Liberty): style, vector tiles, sprites, and glyphs for the visible map, on every start and in every new project. | All | Direct | Pick another basemap or a blank background, or serve your own style (see [Reducing outbound requests](self-hosting.md#reducing-outbound-requests)). A project's saved basemap replaces it when that project opens. |
| `plugins.geolibre.app` | `blocklist.json` (plugins pulled from the registry for safety), fetched once per session before external plugins load. It is fetched even when no registry plugin is installed. The registry itself (`plugin-registry.json`) is fetched only when Settings → Manage Plugins is opened. See [Privacy Policy](privacy.md#plugins-from-the-plugin-registry). | All | Direct | Set `plugins.registryUrl` in [`deployment.json`](deployment-policy.md#plugins) to your own registry; the blocklist is then read from beside it. |
| `api.github.com` | `GET /repos/opengeos/GeoLibre/releases/latest`, the startup update check. Throttled to once every 6 hours. Not present in the Microsoft Store build. | Desktop | Direct | Settings → Updates: turn off "Check for updates on startup". Help → Check for updates makes the same request on demand. |
| `extensions.duckdb.org` | The DuckDB Spatial extension, downloaded the first time a local vector file needs DuckDB to read it (Shapefile, GeoPackage, GeoParquet, and similar), then cached. It is triggered by opening a local file, not by picking a remote service. | All | Direct | Set `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` to a mirrored copy (build time, or Settings → Environment variables). See [Getting Started](getting-started.md#optional-runtime-mirrors-offline-and-air-gapped). |
| `www.googletagmanager.com` | Google Analytics. Loaded only by a web build that sets `VITE_GEOLIBRE_GA_MEASUREMENT_ID`, which the OpenGeos hosted deploys (geolibre.app, geolibre.app/demo, web.geolibre.app) do. | Hosted web only | Direct | Never present in the desktop app or the Jupyter widget, and absent from any web build that leaves the ID unset (the default). The Docker image cannot enable it. See [Privacy Policy](privacy.md#website-analytics). |

Two builds go further than this because the OpenGeos project configures them:
the hosted web builds (geolibre.app/demo, web.geolibre.app, studio.geolibre.app)
bake in `wss://collab.geolibre.app` so the Collaborate menu works, and
studio.geolibre.app also bakes in `https://ai.geolibre.app` for the AI
assistant. Neither connects until the user starts a session or sends a prompt.
The desktop release, the Jupyter wheel, and the Docker image configure neither.

Three built-in plugins are active in a fresh project (Layer Control, Deck.gl
Layer, and Atmospheric Effects). None of them makes a request until the user
builds a visualization with it.

## GeoLibre-operated hosts

These hosts are run by the OpenGeos project, currently on Cloudflare (Workers,
Durable Objects, R2) and GitHub Pages. All of them are opt-in except the
plugin blocklist above.

| Host | Purpose | Source | Configure or replace |
| --- | --- | --- | --- |
| `tiles.geolibre.app` | Tile and service relay for upstreams that send no CORS headers, need server-side reprojection, or need a fixed, cached query. Routes are listed [below](#the-tilesgeolibreapp-relay). | `workers/tiles` | Not configurable per route today. Features that need it fail when it is blocked. |
| `share.geolibre.app` | Project → Share uploads, the public Gallery, and opening shared links. | `workers/viewer`, [Server API](server-api.md) | `sharing.shareUrl` in `deployment.json` (`off` removes Share and the Gallery), or `GEOLIBRE_SHARE_URL`. |
| `collab.geolibre.app` | Live collaboration relay (WebSocket). See [Collaboration](collaboration.md). | `workers/collab` | `sharing.collabUrl`, or run `workers/collab-node` yourself. |
| `ai.geolibre.app` | AI proxy used by studio.geolibre.app. Forwards chat to Cloudflare AI Gateway (`api.cloudflare.com`), web search to Tavily (`api.tavily.com`), and the System One fast path to `api.typesafe.ai`. | `workers/ai-proxy` | Docker: `ai.enabled` plus `GEOLIBRE_AI_URL=/ai` and `GEOLIBRE_AI_PROXY_URL`, so the browser only talks to the same-origin `/ai` route. |
| `plugins.geolibre.app` | Plugin registry, blocklist, and registry plugin files. | geolibre-plugins repository | `plugins.registryUrl`. |
| `languages.geolibre.app` | Optional Whitebox tool translation packs, downloaded on request from Settings. | `apps/geolibre-desktop/src/lib/language-pack.ts` | `VITE_LANGUAGE_PACK_BASE_URL`; removed by `GEOLIBRE_NO_EXTERNAL_CDN=1`. |
| `assets.geolibre.app` | Starter project thumbnails and files shown in the New Project dialog. | `apps/geolibre-desktop/src/lib/starter-projects.json` | Fetched only when that dialog is opened. |
| `datasets.geolibre.app` | A public GeoLens catalog offered as a sample server in the GeoLens plugin. | `packages/plugins/src/plugins/maplibre-geolens.ts` | `geolens.url` in `deployment.json`. |
| `web.geolibre.app` | The app URL that a standalone HTML export from the Python package (`render_project_html`) loads by default. | `python/src/geolibre/geolibre.py` | Pass `app_url=` to load the app from your own host. |

### The `tiles.geolibre.app` relay

Every route forwards to fixed upstreams from an allowlist
(`workers/tiles/src/allowlisted-fetch.ts`); it is not an open proxy. Where the
desktop app can reach an upstream directly with its native HTTP client, it does
so and skips the relay; the table notes those cases.

| Route | Upstream | Used by | Desktop |
| --- | --- | --- | --- |
| `/opm/...`, `/wms/...` | `s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net`, `s3.us-east-2.amazonaws.com/opmmarstiles`, `s3.amazonaws.com/opmbuilder`, `planetarymaps.usgs.gov` | Mars, Moon, and other planetary basemaps (`packages/core/src/ellipsoids.ts`) | Relay |
| `/overpass` (POST) | `z.overpass-api.de` (run by FOSSGIS e.V.), then `overpass.private.coffee` (run by Private.coffee, an Austrian non-profit association) on a 429, 5xx, network error, or timeout, then `maps.mail.ru` (`/osm/tools/overpass/api/interpreter`, run by VK) as a last fallback. Each instance that is tried sees the query and its area of interest. | OSM Downloader plugin, God's Eye View road layers | Relay |
| `/oam/meta` | `api.openaerialmap.org` | OpenAerialMap search | Direct |
| `/source-coop/...` | `source.coop` (API and feed) | Source Cooperative and Natural Earth plugins | Direct |
| `/ckan/search` | `data.humdata.org` | CKAN plugin search | Relay |
| `/odp/...` | `api.hubocean.earth` | Ocean Data Platform tiles and features | Features direct, tiles relay |
| `/earthdata/download` | NASA Earthdata DAAC hosts, then CloudFront or S3 redirects. Carries the user's Earthdata token on the first hop only. | Earthdata Search downloads and COG layers | Downloads direct |
| `/pmtiles/...` | `build.protomaps.com` | Basemap extract (download an offline basemap) | Relay |
| `/github-raw` | `raw.githubusercontent.com` | Vector files added from `github.com/.../raw/...` URLs | Relay |
| `/celestrak/...`, `/launch-library/recent` | `celestrak.org`, `ll.thespacedevs.com` | God's Eye View satellites and launches | Relay |
| `/opensky/states`, `/adsb-lol/military`, `/adsbdb/aircraft/...` | `opensky-network.org`, `api.adsb.lol`, `api.adsbdb.com` | God's Eye View aircraft | Relay |
| `/firms/viirs/...` | `firms.modaps.eosdis.nasa.gov` | God's Eye View active fires | Relay |
| `/transit/vehicles/...` | `cdn.mbta.com`, `data.texas.gov`, `svc.metrotransit.org`, `realtime.hsl.fi`, `gtfs.ovapi.nl`, `gtfsrt.api.translink.com.au` | God's Eye View transit | Relay |
| `/cctv/...` | `trafficcam.calgary.ca`, `cctv.austinmobility.io`, `511on.ca`, `www.drivebc.ca`, `data.livetraffic.com`, `webcams.transport.nsw.gov.au`, `cwwp2.dot.ca.gov` | God's Eye View traffic cameras | Relay |

!!! note "Pending change"
    [#3367](https://github.com/opengeos/GeoLibre/pull/3367) removes `maps.mail.ru`
    from the `/overpass` chain and adds an `x-overpass-upstream` response header
    naming the instance that answered. Update the row above when it merges.

## Opt-in: core features

| Feature | Hosts | Builds | Route |
| --- | --- | --- | --- |
| Basemap picker and Basemaps plugin | OpenFreeMap, CARTO (`basemaps.cartocdn.com`), Esri (`server.arcgisonline.com`, `services.arcgisonline.com`), EOX (`tiles.maps.eox.at`), USGS (`basemap.nationalmap.gov`), NASA GIBS, OpenStreetMap, Protomaps, Mapbox, MapTiler, Stadia, TomTom, HERE, Amazon Location, Tianditu, Google, swisstopo, BKG, Waymarked Trails, OpenRailwayMap. Opening the Basemaps panel loads a thumbnail per visible row, which contacts many of these hosts before the user picks one. Keyed providers receive the key the user or build supplies. | All | Direct |
| Regional basemaps (China) | Amap (`webst01.is.autonavi.com`, `wprd01.is.autonavi.com`) and Tencent (`rt0.map.gtimg.com`). Only when the user selects one, or opens a project that selected one. | All | Direct |
| Place search and reverse geocoding | Nominatim (`nominatim.openstreetmap.org`) by default; Pelias (`api.geocode.earth`), ArcGIS (`geocode.arcgis.com`), Mapbox, Google (`maps.googleapis.com`), and CartoCiudad (`www.cartociudad.es`) when configured. The query text or clicked point is sent. Reverse geocoding asks for consent first. | All | Direct |
| Routing, isochrones, drive and walk time | `valhalla1.openstreetmap.de` (FOSSGIS Valhalla), or `VITE_ROUTING_ENDPOINT`. The Directions plugin uses `router.project-osrm.org` and asks for consent first. | All | Direct |
| Pointer elevation readout, elevation profile | `api.open-meteo.com` when 3D terrain has no sample. The status-bar readout is off by default and asks for consent first. | All | Direct |
| 3D terrain | `s3.amazonaws.com/elevation-tiles-prod` (Terrarium and GeoTIFF tiles); ArcGIS renderer uses `elevation3d.arcgis.com`. | All | Direct |
| Place info cards | `<lang>.wikipedia.org` (geosearch and page summary) after a one-time consent notice. | All | Direct |
| Administrative boundaries | `www.geoboundaries.org`, `media.githubusercontent.com` | All | Direct |
| Add Data menus | Starter services and prefilled examples point at public hosts such as `tile.openstreetmap.org`, `ahocevar.com`, `earthquake.usgs.gov`, `*.nationalmap.gov`, `wms.gebco.net`, `api.pdok.nl`, `csw.open.canada.ca`, `sdi.eea.europa.eu`, `www.mrlc.gov`, and `data.source.coop`. Nothing is fetched until the user connects. Full list: `apps/geolibre-desktop/src/components/layout/add-data/constants.ts` and `service-library.ts`. | All | Direct |
| AI assistant | The provider the user configures: Google Gemini (`generativelanguage.googleapis.com`), Anthropic (`api.anthropic.com`), OpenAI (`api.openai.com`), OpenRouter (`openrouter.ai`), Vercel AI Gateway (`ai-gateway.vercel.sh`), Amazon Bedrock (`bedrock-runtime.<region>.amazonaws.com`), a local Ollama, or any OpenAI-compatible URL. Web search uses `api.duckduckgo.com` or Tavily (`api.tavily.com`) when enabled. Or the operator's `/ai` proxy (see `ai.geolibre.app` above). | All | Direct, or the operator's proxy |
| Cesium renderer (3D globe) | Cesium ion (`api.cesium.com`, `assets.ion.cesium.com`) when a token is set; `tile.openstreetmap.org` as the keyless fallback imagery. Google Photorealistic 3D Tiles use `tile.googleapis.com` with a Google Maps key. | All | Direct |
| Mapbox renderer | `api.mapbox.com` (Mapbox GL JS from Mapbox's CDN, styles, and tiles) with the user's token. | All | Direct |
| ArcGIS renderer | `js.arcgis.com` (the ArcGIS Maps SDK), `basemaps.arcgis.com` | All | Direct |
| ArcGIS sign-in and portals | `www.arcgis.com` or the user's portal (`<org>.maps.arcgis.com`, ArcGIS Enterprise) | All | Direct |
| Earth Engine | `accounts.google.com`, `earthengine.googleapis.com`, `www.googleapis.com`, `storage.googleapis.com`, `raw.githubusercontent.com` (dataset catalogs) | All | Direct |
| Cloud storage (S3 browser) | The user's S3 endpoint; on desktop, AWS STS (`sts.<region>.amazonaws.com`) and the instance or container metadata endpoints (`169.254.169.254`, `169.254.170.2`) only when the chosen AWS profile needs them. | All (STS desktop only) | Direct |
| SQL workspace engines | PGlite and PostGIS, CereusDB (Sedona), and `gdal3.js` load from `cdn.jsdelivr.net` on first use by default; DuckDB-WASM does too in the `lite:build` variant. | All | Direct |
| Python console and Python vector engine | Pyodide from `cdn.jsdelivr.net`, or `VITE_PYODIDE_INDEX_URL`. | All | Direct |
| Object detection, Segment Everything | Model weights from `cdn.jsdelivr.net` and `huggingface.co`; ONNX Runtime from `cdn.jsdelivr.net`. | All | Direct |
| 3D Tiles | Draco and KTX2 decoders from `unpkg.com` | All | Direct |
| Story map HTML export | The exported page loads MapLibre from `unpkg.com` and fonts from `demotiles.maplibre.org`. | All | Direct (from the exported page) |
| Python sidecar and Notebook panel | First use downloads `uv` from `astral.sh` (unless `uv` is installed), a Python build through `uv` (from GitHub), and packages from PyPI (`pypi.org`, `files.pythonhosted.org`). Applies to the sidecar itself and to the Whitebox, conversion, point cloud, and OBIA runtimes. | Desktop (and a self-run sidecar) | Direct, from the native process |
| Project sharing, Gallery, Collaboration | See [GeoLibre-operated hosts](#geolibre-operated-hosts). | All | Direct to the GeoLibre host |

## Opt-in: built-in plugins

Every plugin here makes requests only once the user turns it on, uses it, or
opens a project in which it was active. Catalog plugins with many portals are
summarised by host family; follow the source file for the full list. Paths are
under `packages/plugins/src/plugins/`.

| Plugin | Hosts | Route |
| --- | --- | --- |
| Components (Search, STAC Search, sample data) | `nominatim.openstreetmap.org`, `earth-search.aws.element84.com`, `planetarycomputer.microsoft.com`, `flatgeobuf.org`, `data.source.coop`, `r2-public.protomaps.com`, `overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com`, `carbonplan-maps.s3.us-west-2.amazonaws.com`, LiDAR sample buckets on S3. **Note:** the FlatGeobuf and choropleth controls of the `maplibre-gl-components` package retry a CORS-blocked URL through `corsproxy.io`, a third-party proxy, so that URL is sent there. | Direct (`corsproxy.io` fallback) |
| Carto Light basemap | `basemaps.cartocdn.com` | Direct |
| Clouds | `gibs.earthdata.nasa.gov` | Direct |
| Deck.gl Layer | `raw.githubusercontent.com` (deck.gl example data and models) | Direct |
| H3 Grid | `raw.githubusercontent.com` (one icosahedron GeoJSON) | Direct |
| DGGAL, DGGRID, A5, Geohash, OLC, S2, Tilecode, MGRS, Gridlines | None (computed locally) | n/a |
| Directions | `router.project-osrm.org` (consent first) | Direct |
| Dynamical | `stac.dynamical.org` and the Icechunk hosts it lists | Direct |
| Earthdata Search | `cmr.earthdata.nasa.gov`, `urs.earthdata.nasa.gov` (desktop sign-in), DAAC data hosts | Direct; web downloads via `/earthdata/download` |
| Earthdata GIS | `gis.earthdata.nasa.gov` | Direct |
| Earth Engine, GeoAgent | Google hosts listed under Earth Engine above; GeoAgent also calls the LLM provider the user configures | Direct |
| EnviroAtlas | `enviroatlas.epa.gov` | Direct |
| Historical Imagery (Esri Wayback) | `s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com`, `wayback.maptiles.arcgis.com` | Direct |
| FEMA flood hazard | `hazards.fema.gov` | Direct |
| DuckDB | `data.source.coop` (sample database), `extensions.duckdb.org`, `cdn.jsdelivr.net` (the plugin's own DuckDB engine) | Direct |
| Fields of the World | `data.source.coop` | Direct |
| GeoLens | `datasets.geolibre.app`, `demo.getgeolens.com`, or the server the user enters; nothing until one is chosen | Direct |
| 3D Tiles | `unpkg.com` (decoders), samples on `tile.googleapis.com`, `tiles.arcgis.com`, `data.3dbag.nl` | Direct |
| ArcGIS Hub, ArcGIS Portal | `www.arcgis.com/sharing/rest` and the feature service hosts it returns | Direct |
| God's Eye View | Through the relay: see the `/celestrak`, `/opensky`, `/adsb-lol`, `/adsbdb`, `/firms`, `/transit`, `/cctv`, and `/overpass` routes. Direct: `earthquake.usgs.gov`, `all.api.radio-browser.info`, `data.source.coop`, GBFS bike feeds (`gbfs.lyft.com` and others), `api.entur.io`, `api.tfl.gov.uk`, `data.austintexas.gov`, `data.calgary.ca`, `tie.digitraffic.fi`, camera image hosts, `api.tomtom.com` (with the user's key), and `wss://stream.aisstream.io` (with the user's key). Satellites and earthquakes are on as soon as the plugin is activated. Source: `gods-eye-view-*.ts`. | Relay and direct |
| Hugging Face | `huggingface.co` (optional user token) | Direct |
| IGN LiDAR HD | `data.geopf.fr` and the tile URLs it returns | Direct |
| India GIS | `raw.githubusercontent.com`, `media.githubusercontent.com`. The government portal URLs in `india-gis-catalogs.ts` are links only. | Direct |
| JAXA Earth | `data.earth.jaxa.jp` (catalog, and a JavaScript module that is checked against a pinned SHA-256 before it runs), `s3.ap-northeast-1.wasabisys.com` | Direct |
| Mapillary, Street View | `tiles.mapillary.com`, `graph.mapillary.com`, Mapillary image CDN, `maps.googleapis.com`, `www.google.com/maps/embed` (with the configured token or key) | Direct |
| NASA Earthdata (GIBS) | `gibs.earthdata.nasa.gov` | Direct |
| USGS National Map | `*.nationalmap.gov`, `services.arcgisonline.com`, `hazards.fema.gov`, `gis.blm.gov`, `fwspublicservices.wim.usgs.gov` | Direct |
| Ocean Data Platform | `api.hubocean.earth` | Direct and `/odp` relay |
| Socrata, CKAN | `api.us.socrata.com` and the dataset domain; CKAN search via `/ckan/search` | Direct and relay |
| OpenAerialMap | `api.openaerialmap.org` (web via `/oam/meta`), tiles from `titiler.hotosm.org` (third party) | Direct and relay |
| OSM Downloader | `/overpass` relay, `api.openstreetmap.org` | Relay and direct |
| Overture Maps | `labs.overturemaps.org`, `stac.overturemaps.org`, `overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com` | Direct |
| Planetary Computer | `planetarycomputer.microsoft.com` (STAC, tiler, SAS token signing), Azure Blob asset hosts | Direct |
| Precipitation | `api.rainviewer.com`, `tilecache.rainviewer.com` | Direct |
| Raster and Time Slider panels | User URLs and `data.source.coop` samples. The `titiler` engine, used for COGs on the Mapbox renderer, defaults to `titiler.d2s.org` (third party), which then fetches the COG. CRS lookups can fall back to `epsg.io`. | Direct |
| Vector panel | User URLs and `data.source.coop` samples | Direct |
| Reverse Geocode | The configured geocoder (Nominatim by default), consent first | Direct |
| S3 Browser | The user's S3 endpoint, `<bucket>.s3.amazonaws.com` | Direct |
| SamGeo | The user's SamGeo server (default `http://127.0.0.1:8000`) | Local |
| Satellite Embeddings | `data.source.coop`, `s3.us-west-2.amazonaws.com/tessera-embeddings` | Direct |
| Sentinel-2 Explorer | `data.source.coop`, `e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com`, `sentinel-cogs.s3.us-west-2.amazonaws.com` | Direct |
| Source Cooperative, Natural Earth | `source.coop` (web via `/source-coop`), `data.source.coop` | Direct and relay |
| STAC Catalogs, Planet Open Data, Portolan | `stacindex.org`, `raw.githubusercontent.com`, `data.source.coop`, `stac.astrogeology.usgs.gov`, Planetary Computer signing, and the catalog the user picks | Direct |
| Tennessee, US Federal, US State, and US Local GIS | `www.arcgis.com/sharing/rest` for search, the feature service hosts it returns, and `api.us.socrata.com` plus the dataset domain for Socrata portals. About 240 portals in `us-*-gis-catalogs.ts`; their portal URLs are links only. | Direct |
| Timelapse | `tiles.maps.eox.at`, `gibs.earthdata.nasa.gov` | Direct |
| USGS DEM | `tnmaccess.nationalmap.gov`, `carto.nationalmap.gov`, and the download URLs it returns | Direct |
| USGS LiDAR | `index.nationalmap.gov`, `raw.githubusercontent.com`, `planetarycomputer.microsoft.com` | Direct |
| USGS NLDI | `api.water.usgs.gov` | Direct |
| Vantor Open Data | `vantor-opendata.s3.amazonaws.com` | Direct |

External plugins (from the registry, a zip, or a manifest URL) can contact any
host the CSP allows, and GeoLibre does not track which. Review a plugin before
allowing it, and use `plugins.allowed` to limit which ones load (see
[Plugin API](plugin-api.md)).

## Differences between builds

- **Desktop** adds the startup update check and the Python sidecar bootstrap.
  It reaches some upstreams directly over native HTTP (OpenAerialMap, Source
  Cooperative, Ocean Data Platform features, Earthdata downloads) where the web
  build needs the relay. Its native HTTP scope for the fetch plugin is limited
  to the sidecar, the geocoders, `share.geolibre.app`, `datasets.geolibre.app`,
  and `api.typesafe.ai` (`src-tauri/capabilities/default.json`).
- **Web** hosted by the OpenGeos project adds Google Analytics and the baked-in
  collaboration (and, on studio.geolibre.app, AI) URLs. A Docker or
  self-built web deployment adds neither.
- **Jupyter** serves the bundled web build from the Jupyter server, so the app
  assets and `deployment.json` are local; map and data requests are the same as
  the web build. The Python package itself makes network requests only for
  GeoJSON URLs passed to it.

## Restricting network access

- **[`deployment.json`](deployment-policy.md)** turns off or redirects the
  GeoLibre-operated services: `sharing.shareUrl: "off"`, `sharing.collabUrl`,
  `plugins.registryUrl`, `plugins.allowed` and `plugins.sideload`,
  `services.builtins: false` and a curated `services.catalog`, `geolens.url`,
  and `ai.enabled`.
- **Interface profiles** (`interface.hiddenDataSources`,
  `interface.hiddenPlugins`, `interface.hiddenMenuItems`) hide data sources,
  plugins, and menu items so users do not reach them. See
  [UI Profiles](ui-profiles.md). This hides entry points; it is not a network
  control.
- **Build flags.** `GEOLIBRE_NO_EXTERNAL_CDN=1` strips GeoLibre's own CDN
  references (jsDelivr, unpkg, the language pack host); see
  [Self-Hosting](self-hosting.md#2-host-the-geolibre-web-build-next-to-it).
  `VITE_PYODIDE_INDEX_URL`, `VITE_DUCKDB_SPATIAL_EXTENSION_PATH`,
  `VITE_ROUTING_ENDPOINT`, and the geocoder settings point those features at
  internal hosts.
- **Content Security Policy.** `connect-src` and `img-src` allow any `https:`
  host in both the desktop app (`tauri.conf.json`, which also allows `http:`)
  and the Docker image (`docker/nginx.conf`), so the CSP does not limit which
  data hosts are reached. Only `script-src` is pinned to specific CDN paths. An
  operator who needs a host allowlist should enforce it with an egress proxy or
  firewall and include the data hosts its projects use as well as the hosts on
  this page. To restrict browser requests with CSP instead, narrow both
  `connect-src` and `img-src` (and review `media-src` and `frame-src`) in a
  derived image.
- **Relays.** A browser-side control (CSP or an egress rule on the client) only
  sees the request to `tiles.geolibre.app`, not the upstream the relay then
  contacts. If an upstream listed under
  [the relay](#the-tilesgeolibreapp-relay) is not acceptable, block
  `tiles.geolibre.app` itself, which disables the features that use it.

[Self-Hosting: Reducing outbound requests](self-hosting.md#reducing-outbound-requests)
has the per-feature checklist.

## Keeping this page current

This page is written by hand from the source. A change that adds a host the app
contacts (a new basemap, plugin, relay route, CDN asset, or default service)
should add it here in the same pull request, and say whether it is default or
opt-in. Useful starting points for an audit:

```bash
grep -rhoE "(https?|wss?)://[a-zA-Z0-9.-]+" packages apps/geolibre-desktop/src workers \
  --include='*.ts' --include='*.tsx' --include='*.json' | sort | uniq -c | sort -rn
```

plus `workers/tiles/src/allowlisted-fetch.ts` for relay upstreams and the
`maplibre-gl-*` packages in `packages/plugins/package.json`, which carry hosts
of their own.
