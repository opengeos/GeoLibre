# ArcGIS renderer

Choose **View → Rendering engine → ArcGIS** to render a project with the
[ArcGIS Maps SDK for JavaScript](https://developers.arcgis.com/javascript/latest/).
The engine is also available from the rendering-engine menu in each split pane.
MapLibre remains the default. Projects save the primary and secondary renderer
choices, and the Python and iframe APIs accept `arcgis` as a renderer name.

## Nothing is bundled

The SDK is **not** part of GeoLibre's build. `@arcgis/core` is 84 MB unpacked
across 18,810 files, and bundling it would grow the web build, the Python wheel
and the desktop installers by tens of megabytes. Instead the engine imports the
modules it needs from Esri's versioned ES-module CDN the first time an ArcGIS
pane mounts (`https://js.arcgis.com/<version>/@arcgis/core/…`), the same way
the PostGIS and Sedona SQL engines are fetched from jsDelivr. Only the adapter
code in `packages/map/src/arcgis-*.ts` ships with GeoLibre.

Consequences:

- The first ArcGIS pane needs network access, on the desktop too. The service
  worker caches the SDK modules and stylesheet after first use
  (`geolibre-arcgis-sdk` in `vite.config.ts`), so the SDK itself boots offline
  afterwards like the other CDN-loaded engines. Esri basemaps, tile services
  and other remote layers still need the network, as on every renderer.
- The SDK version is pinned in `packages/map/src/arcgis-sdk.ts`
  (`ARCGIS_SDK_VERSION`). Bumping it is a deliberate change; see
  [Maintenance](maintenance.md#arcgis-maps-sdk-for-javascript-loaded-from-esris-cdn).
- Esri documents the ES-module CDN as a prototyping path and logs "Only use ES
  modules from ArcGIS CDN for testing" once per session; its supported
  production path is an npm build, which is exactly what this integration
  avoids for size. The first load pulls a few hundred small modules, so the
  first ArcGIS pane of a session takes longer to appear than a Mapbox one.
- The content-security policies of the desktop app (`tauri.conf.json`) and the
  Docker image (`docker/nginx.conf`) allow-list `https://js.arcgis.com/` in
  `script-src` and `font-src` (the SDK's icon and text fonts). The SDK's
  stylesheet is fetched as text and inlined, since neither policy allows
  external stylesheets.

## API key

The renderer works without a key. It translates the project basemap into tiles
the SDK can draw (the same translation the 3D globe uses) and draws your layers
through the SDK's own layer classes.

An **ArcGIS API key** adds Esri's basemap styles. Create one in your ArcGIS
account (ArcGIS Online or ArcGIS Location Platform) under **Content → New item
→ Developer credentials → API key credentials** with the **Basemaps**
privilege, then paste it into **Settings → Environment Variables → ArcGIS API
key** and click **Save Settings**. Like the Mapbox and Cesium tokens, it is
stored on this device, outside the project file. Alternatively, launch the
development server with `ARCGIS_API_KEY` in its environment. Key changes
recreate ArcGIS maps. Requests made with the key are metered against its
account and subject to Esri's terms; basemap requests have a generous free
allotment.

With a key, new projects use **ArcGIS Streets** for the ArcGIS renderer. The
**Change background** picker offers Esri's Streets, Navigation, Topographic,
Light Gray, Dark Gray, Imagery, Imagery (no labels), Oceans, Outdoor and
OpenStreetMap styles when ArcGIS is active
and a key is configured. Selecting one preserves the camera. The
choice is saved as `preferences.map.arcgisBasemap` (an Esri basemap style id
such as `arcgis/streets`, `arcgis/imagery` or `osm/standard`); selecting a
basemap from the shared **Basemaps** panel while ArcGIS is active clears it,
so the pane follows the shared MapLibre/Cesium basemap again. Without a key the
override is set aside and the shared basemap is translated instead.

## Supported paths

- Native GeoJSON, including the vector importer's materialized data, FlatGeobuf
  and GeoParquet imports, and ArcGIS feature layers already loaded into the
  project. Point, line and polygon symbology, fill and stroke opacity, circle
  radius, labels (field or expression, size, colour, halo, placement, offset,
  rotation, case transform), and the data-driven colour modes — categorized,
  graduated, rule-based, expression and simplestyle — all render. The SDK has no
  MapLibre Style Spec, so the engine evaluates the same MapLibre expressions
  `@geolibre/core` builds for the 2D map _per feature_ with the style-spec
  engine and bakes the answers into the features; the layer's renderer is a
  unique-value renderer over the resulting symbol keys. Layer filters, quick
  filters, the time slider's filter and the embed filter are applied the same
  way before features reach the SDK. Zoom-dependent expressions (metre-unit
  strokes, per-rule zoom ranges) are re-evaluated when the integer zoom
  changes.
- The symbology pack draws through companion layers built from the filtered
  features: the **inverted fill** as a world mask with the polygons cut out
  (clamped to the Web Mercator latitude limit, as on Mapbox), the **geometry
  generator** (centroids, bounding boxes, convex hulls, buffers) in its own
  fill, stroke and proportional circle size, and **line decorations** as a CIM
  marker line that repeats the shape at the style's spacing and turns arrows
  to follow the line (a flat `MapView` only; the SDK draws no CIM line symbols
  in a scene). **Label de-duplication** labels the aggregated points from a
  label-only layer. The label size, colour, opacity and visibility
  expressions are evaluated per feature and grouped into one label class per
  resolved size and colour, since the SDK's label symbols are not
  data-driven. Companion layers are not identified or selected.
- HTTP(S) raster tiles (XYZ, WMTS tile templates), WMS (the GetMap template is
  split into the SDK's `WMSLayer` description), and vector tiles with named
  source layers (drawn by the SDK's `VectorTileLayer` from the same style
  layers the Mapbox engine compiles). Markers, line decorations and fill
  patterns are GeoLibre's generated images, baked into a sprite sheet the SDK
  reads through a request interceptor; labels use Arial from Esri's public
  glyph service, so they need the network. Past a source's maximum zoom the
  SDK magnifies its last tiles, patterns and decoration spacing with them,
  where MapLibre keeps them crisp. A raster template
  `WebTileLayer` cannot express — a `{bbox-epsg-3857}` request, a TMS scheme,
  `{-y}` or `{quadkey}`, a 512 px tile size, a source `minzoom`/`maxzoom`, or
  several templates — draws through a custom tile layer that requests each
  tile as MapLibre would, cropping 512 px tiles and overzooming past `maxzoom`.
  A template on a registered MapLibre protocol (the desktop app's CORS-exempt
  `geolibre-wms://` WMS fetcher, say) is asked of that protocol's handler, as
  the globe does.
- **Add Data → ArcGIS Layer** stores cached MapServer and ImageServer services
  as tile templates and dynamic ones (sublayers, a rendering rule, no usable
  cache) as `/export` / `/exportImage` bounding-box templates, both drawn as
  above. FeatureServer layers, and any service recorded as `type: "arcgis"`
  (hand-authored or Python records), draw through the SDK's own
  `FeatureLayer`, `TileLayer`, `MapImageLayer` and `ImageryLayer`; a single
  MapServer sublayer (`MapServer/2`) is a `FeatureLayer` too. A service layer
  draws with its layer style, as on the 2D map; its identified features can be
  highlighted, and its features read back as GeoJSON (paged past the service's
  per-request record limit, up to 50 requests). A
  FeatureServer layer's filters (quick filters, the expression filter, the time
  and embed filters) become the service's SQL `definitionExpression`; a filter
  with no SQL form is reported in the map's banner and the service draws
  unfiltered.
- Georeferenced images, placed by their four corners through a control-point
  georeference, so rotated and skewed fits land where they do on MapLibre.
- Shared layer/group visibility, opacity and ordering; synchronized or
  independent split-view cameras; the project's zoom and bounds constraints.
- The Style panel's raster brightness, contrast, saturation and hue sliders,
  as the SDK's CSS-filter `effect` on raster layers, and every layer's blend
  mode as the SDK's `blendMode` (`add` is the SDK's `plus`). A `SceneView`
  ignores the raster effects, and blends only tiled and imagery layers.
- Geo Editor text markers and annotation text, drawn as text at their points
  in their own colours.
- Feature picking (click identify with the layer's popup template and field
  visibility; **Identify visible layers** groups every layer's hits, including
  WMS GetFeatureInfo, Time Slider pixels, COG/NetCDF pixels and DuckDB
  layers), selection highlighting, extent
  drawing, draggable placement, and engine-level image capture. **Layers →
  Select features** (single, rectangle, polygon, freehand and radius) runs the
  same gestures as on MapLibre on the primary map. The status bar's pointer
  elevation reads the ground under the cursor from the scene's elevation
  surface, or (with consent) the same remote lookup the other maps use.
- **GPS Tracking** (the position marker, accuracy circle and track, following
  the position), **Add comment**, the Georeferencer's **Link on map**, and the
  Pixel Time Series and NetCDF sample markers work through the engine's render
  surface and click events.
- Plugin controls hosted on the map receive MapLibre's `move`, `zoom`,
  `rotate`, `click` and `mousemove` events, so readouts such as View State and
  the minimap follow the camera. Story chapter layer fades run over the
  chapter's transition.
- **Search places** flies to places and coordinates with a temporary marker,
  and frames H3 cells with a filled outline. Clearing the search removes its
  highlight without removing a selection made elsewhere.
- Point heatmaps use the shared color ramp, radius, intensity and optional
  weight field in both 2D and 3D. Esri's density kernel differs from MapLibre's,
  so the visual density can differ; SceneView caps the radius at 112 points.
  Clustering uses native count labels and the configured radius and maximum
  zoom in 2D. Built-in and custom SVG fill patterns also render in 2D, with
  per-feature fill opacity and independent outlines.
- The built-in controls the **Controls** menu governs, as the SDK's own widgets:
  fullscreen, compass (resets rotation), zoom (navigation), locate (geolocate)
  and the scale bar (metric or imperial, 2D only), plus a globe/Mercator
  toggle and terrain (see [2D and 3D](#2d-and-3d)). Attribution is drawn by the view
  itself (`attributionVisible`); Esri requires it and it cannot be hidden.
- **Plugins → Layer Control** toggles the native ArcGIS layer list, enabled by
  default on the primary map like the shared plugin. Its visibility
  toggles update the project and the sidebar, and sidebar changes update the
  list. Mixed-geometry GeoJSON records have one entry for all their parts.
  Temporary search and selection highlights are omitted. Split panes keep the
  control hidden by default and retain their independent layer visibility.
- Plugins that only add store layers: **ArcGIS Hub**, **Socrata** and **CKAN**
  search, the **OSM Downloader**, and the **Weather** overlays (Clouds and
  Precipitation). **Controls** menu entries whose plugin needs a MapLibre,
  Mapbox or Cesium map (Atmospheric Effects, Sun, Route Animation, Flight
  Simulator, Graticule, Directions, Reverse Geocode) are greyed out with the
  reason while ArcGIS is the primary renderer.
- If the SDK cannot be loaded from the CDN, the map's banner offers **Retry**,
  which reloads the page: the browser keeps a failed module import for the life
  of the page, so only a reload can fetch it again.

## 2D and 3D

The SDK draws flat maps and 3D scenes through two different view classes, so
the ArcGIS pane picks one from the project's map preferences and rebuilds the
view when the choice changes. The camera (centre, zoom, bearing and pitch)
carries over.

| Projection | Terrain   | View                               |
| ---------- | --------- | ---------------------------------- |
| Globe      | off or on | `SceneView`, global (a 3D globe)   |
| Mercator   | on        | `SceneView`, local (a flat 3D map) |
| Mercator   | off       | `MapView` (a flat 2D map)          |

New projects use the globe projection, so an ArcGIS pane opens as a globe.
The globe button under the compass switches projection (as on MapLibre, a
split pane's button only switches that pane), and **Controls → Terrain** turns
terrain on or off. The 3D modules (`views/SceneView` and the elevation layers, close to a
megabyte) are not part of the first load: a flat ArcGIS map fetches them in the
background once the page is idle, so the first switch to a globe does not wait
on the network. While a new view loads, the previous one stays on screen and is
swapped out once the new view's basemap has drawn; data layers and terrain
finish loading on the new view.

In a scene:

- The camera tilts (right-drag, or the project's saved pitch), limited by the
  project's maximum pitch. The status bar shows the camera's altitude.
- Lighting follows the camera (the SDK's virtual lighting), so the whole
  visible map is lit. The SDK's default simulated sun would leave part of the
  globe on the night side.
- Terrain drapes the map over Esri's
  [World Elevation](https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer)
  service. It needs no API key. **Controls → Terrain exaggeration** scales the
  heights.
- **Controls → Terrain exaggeration** also accepts a local or remote COG DEM
  in EPSG:3857 or EPSG:4326, using the same reader as the other engines.
  The local file stays on the device. The source and exaggeration survive
  switches between flat maps, local scenes and the globe during the session;
  they are not saved in the project. Missing DEM pixels and areas outside the
  COG use zero metres. **Use global terrain** restores Esri's World Elevation.
- Polygon layers whose style extrudes (the Style panel's **3D extrusion**) draw as
  extruded 3D shapes with the same height and colour as MapLibre's
  fill-extrusion: the height property times the height scale (or the advanced
  height expression) is the top and the base height the bottom, and the colour
  follows the layer's categorized, graduated or rule-based symbology, the
  advanced colour expression, or the extrusion colour. On a 2D `MapView` they
  stay flat fills.
- Identify, selection highlighting, extent drawing and capture work as in 2D.
  The scale bar does not: the SDK's scale bar only measures a `MapView`, so
  the Controls menu cannot show it in a scene. The project's minimum and
  maximum zoom still clamp camera moves the app makes, but not the user's own
  navigation.
- **3D (Z values)** places vector coordinates at their absolute altitude, with
  the configured vertical scale and offset. Selection highlights use the same
  transformed coordinates. Source data stays unchanged.

## Adding data

Files dropped onto the map, the host importers behind **Add Data → FlatGeobuf
Layer / GeoParquet Layer / KML / KMZ / Delimited Text**, and the **XYZ**,
**WMS**, **WMTS** and **ArcGIS Layer** dialogs all work on the ArcGIS map. The
**Vector Layer** panel uses the shared store bridge for bounded vector imports;
large streaming GeoParquet still requires MapLibre. **Raster Layer** opens a
host dialog for a local GeoTIFF or HTTP(S) URL.

GeoTIFF/COG files and URLs render through the existing WebAssembly COG tiler
and a native ArcGIS tile layer in 2D and 3D. Saved RGB bands, continuous color
ramps, stretch, gamma, nodata and opacity are honored; edit them in the Style
panel. Browser files last for the session; desktop local paths can be reopened
on the same device. GPU-only classified/custom color ramps still require the
MapLibre raster control.

## deck.gl layers

**Add Data → Deck.gl Layer / 3D Model** works on the primary flat map and
local 3D scene. The shared overlay renders saved visualizations and models,
follows visibility, opacity and ordering among deck.gl layers, and releases
its GPU resources on a renderer switch. The shared overlay is one native SDK
layer; deck.gl layers cannot be interleaved individually with native ArcGIS
layers. Native feature Z rendering stays owned by ArcGIS.

The adapter uses the MIT-licensed compositor from `@deck.gl/arcgis` 9.4.0
with CDN-loaded SDK classes, avoiding a bundled `@arcgis/core` dependency.
Local 3D rendering uses the upstream experimental camera approximation: it can
drift at extreme camera angles and does not share the terrain depth buffer.
Global scenes and secondary panes do not host the overlay; the menus and layer
badges reflect that restriction. Switch back to a flat map or local scene to
restore the layers.

## Tile archives

**Add Data → PMTiles** loads remote vector (MVT) and raster archives directly
through the shared PMTiles reader. Native vector tiles retain polygon, line and
point styles; raster archives use native tiled imagery and resample their last
native level when zooming in. Existing in-memory archives in the shared registry
also work. **Add Data → MBTiles** uses the desktop file reader for both vector
and raster tiles. MBTiles still requires the desktop app.

The vector adapter owns a request interceptor per layer and removes it when the
layer is replaced or removed. Tiles are read on demand, including cancellation;
synthetic tile addresses never go to the network. MLT encoding and archive text
labels are not supported. The adapter reads PMTiles zoom limits from the archive
header, including for older projects that omit those limits.

Each vector source layer uses a separate native VectorTileLayer so its style and
visibility can be controlled independently. The PMTiles reader is shared, but
the SDK decodes tiles separately for each native layer. Archives with many source
layers therefore use more decoding work and memory than the shared MapLibre
source; enable only the layers needed for the current view.

## Zarr and NetCDF grids

**Add Data → Zarr** loads numeric Zarr v2/v3 variables through native tiled
imagery. The reader supports regularly spaced, one-dimensional spatial axes,
ascending or descending latitude, 0–360° longitude, CF scale/offset and fill
values, and integer selectors for other dimensions. The Time Slider uses the
same selector path. Projected grids require a CRS or proj4 definition through
the import API. Curvilinear coordinates and automatic multiscale selection are
not supported; a pyramid level can be selected by its variable path. The plugin
`queryZarrLayer` API (point values and region statistics) is not yet supported
for native ArcGIS grids.

**Add Data → NetCDF** uses the existing file dialog. Image slices render as
native image overlays; kerchunk-backed grids share the tiled Zarr reader.
Reference manifests are preserved in the layer source for project restoration.
Registered local Zarr stores remain session-local. Reads return bounded windows
and retain at most 32 MiB of compressed data per layer; coarse views of large
untiled arrays can still require many chunk requests.

## Adapted plugin panels

**LiDAR**, **DuckDB** and ordinary **3D Tiles** render through deck.gl on the
primary flat map or local scene. Google Photorealistic and I3S tiles still
require another renderer. The global globe and secondary panes do not
host these overlays. LiDAR keeps the existing COPC/EPT streaming and styling
controls; its terrain toggle delegates to the host terrain setting. Saved URL
LiDAR and 3D Tiles layers restore when the view is rebuilt. Browser-local point
cloud files and cached DuckDB query results retain their existing session
lifetime; reopen the source/query when necessary. Scene overlays have the same
experimental alignment and depth limitations described above.

## Not supported yet

- Gaussian splats and Cesium-only sources, STAC search results and video
  overlays. **Add Data** greys these out while ArcGIS is the primary
  renderer, and the layer panels badge such layers **No ArcGIS**. A layer a
  plugin draws on MapLibre only (Planetary Computer, say) is named in the map's
  banner too.
- The Print Layout atlas, in any view; an Esri vector tile service's own icon
  and label layers (its stored style keeps no sprite or glyphs); and, in a 3D
  `SceneView`, the project's zoom and bounds constraints and the nautical
  scale unit.
- Measure and the geometry editor draw through the MapLibre/Mapbox style API;
  the Controls menu greys Measure out, and editing a layer's geometry says the
  renderer does not support it.
- Diagrams and the label priority expression (the SDK has no per-feature
  label priority); clustering, fill patterns, blend modes and line
  decorations in a `SceneView`; extrusion on a flat map. The Style panel names
  whichever of these a layer turns on.
- Arbitrary MapLibre custom layers and rendering APIs still require adapters.
  The primary view hosts DOM controls with navigation methods; Vector, LiDAR,
  DuckDB and 3D Tiles have explicit rendering bridges. Layer Control delegates
  to ArcGIS's native layer list.
- Video overlays. The SDK does not support clustering or picture-fill patterns
  in SceneView: scenes retain individual point symbols and solid polygon fills.
  Heatmap labels are also unsupported in scenes.
  Markers (built-in shapes, custom SVG, KML icons) do draw,
  as picture symbols baked from the same sprites MapLibre uses.

## Testing

`tests/arcgis-layers.test.ts` covers the layer compiler and basemap planner,
`tests/arcgis-engine.test.ts` drives the engine against a fake SDK, and
`tests/arcgis-renderer.test.ts` covers the project format, settings and loader
boundaries. None of them touch the network. `e2e/arcgis-renderer.spec.ts` is
the opt-in browser check against Esri's real CDN: set `ARCGIS_API_KEY` for
the full suite, or `ARCGIS_E2E=1` for keyless coordinate and H3 search coverage.
With `ARCGIS_E2E=1`, `e2e/arcgis-offline.spec.ts` also verifies a fresh keyless
boot under the production Tauri CSP, cached SDK/inline-data startup with the
browser offline, and a visible error when the CDN is unavailable on first use.
The CSP test runs in Chromium with the exact policy header; it does not replace
native webview testing on each desktop platform.

## License and terms

The ArcGIS Maps SDK for JavaScript is distributed by Esri under its own
[terms of use](https://developers.arcgis.com/javascript/latest/licensing/), not
an open-source license. GeoLibre does not redistribute it; the SDK is fetched
from Esri's CDN by the user's browser at runtime, and use of Esri's basemaps and
location services is governed by the account the API key belongs to.
