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
- HTTP(S) raster tiles (XYZ, WMTS tile templates), WMS (the GetMap template is
  split into the SDK's `WMSLayer` description), and vector tiles with named
  source layers (drawn by the SDK's `VectorTileLayer` from the same style
  layers the Mapbox engine compiles, minus text labels).
- ArcGIS services natively: FeatureServer, MapServer (tiled and dynamic) and
  ImageServer records added through **Add Data → ArcGIS Layer** draw through the
  SDK's own `FeatureLayer`, `TileLayer`, `MapImageLayer` and `ImageryLayer`. A
  FeatureServer layer's filters (quick filters, the expression filter, the time
  and embed filters) become the service's SQL `definitionExpression`; a filter
  with no SQL form is reported in the map's banner and the service draws
  unfiltered.
- Georeferenced images, placed by their four corners through a control-point
  georeference, so rotated and skewed fits land where they do on MapLibre.
- Shared layer/group visibility, opacity and ordering; synchronized or
  independent split-view cameras; the project's zoom and bounds constraints.
- Feature picking (click identify with a popup), selection highlighting, extent
  drawing, draggable placement, and engine-level image capture.
- **Search places** flies to places and coordinates with a temporary marker,
  and frames H3 cells with a filled outline. Clearing the search removes its
  highlight without removing a selection made elsewhere.
- The built-in controls the **Controls** menu governs, as the SDK's own widgets:
  fullscreen, compass (resets rotation), zoom (navigation), locate (geolocate)
  and the scale bar (metric or imperial, 2D only), plus a globe/Mercator
  toggle and terrain (see [2D and 3D](#2d-and-3d)). Attribution is drawn by the view
  itself (`attributionVisible`); Esri requires it and it cannot be hidden.

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

## Adding data

Files dropped onto the map, the host importers behind **Add Data → FlatGeobuf
Layer / GeoParquet Layer / KML / KMZ / Delimited Text**, and the **XYZ**,
**WMS**, **WMTS** and **ArcGIS Layer** dialogs all work on the ArcGIS map. The
**Vector Layer** and **Raster Layer** panels are MapLibre controls (the
`maplibre-gl-vector` and `maplibre-gl-raster` plugins) and do not mount here;
drop the file instead.

## Not supported yet

- Custom terrain sources (a COG DEM chosen in **Controls → Terrain exaggeration**): terrain is
  always Esri's World Elevation. Features with their own Z values
  (the Style panel's **3D (Z values)** mode) are not placed at their altitude.
- deck.gl overlays (Deck.gl Layers, 3D Models, DuckDB query layers, 3D Tiles,
  LiDAR), COGs, Zarr, NetCDF, PMTiles and MBTiles archives, Gaussian splats and
  Cesium-only sources. **Add Data** greys these out while ArcGIS is the primary
  renderer, and the layer panels badge such layers **No ArcGIS**.
- Plugin controls. The engine has no MapLibre map for a `maplibre-gl` control
  to call into, so no bundled plugin declares `engines: ["arcgis"]`, and the
  on-map layer control is not mounted.
- Video overlays, heatmap and cluster point renderers (points draw as circles)
  and fill patterns. Markers (built-in shapes, custom SVG, KML icons) do draw,
  as picture symbols baked from the same sprites MapLibre uses.

## Testing

`tests/arcgis-layers.test.ts` covers the layer compiler and basemap planner,
`tests/arcgis-engine.test.ts` drives the engine against a fake SDK, and
`tests/arcgis-renderer.test.ts` covers the project format, settings and loader
boundaries. None of them touch the network. `e2e/arcgis-renderer.spec.ts` is
the opt-in browser check against Esri's real CDN: set `ARCGIS_API_KEY` for
the full suite, or `ARCGIS_E2E=1` for keyless coordinate and H3 search coverage.

## License and terms

The ArcGIS Maps SDK for JavaScript is distributed by Esri under its own
[terms of use](https://developers.arcgis.com/javascript/latest/licensing/), not
an open-source license. GeoLibre does not redistribute it; the SDK is fetched
from Esri's CDN by the user's browser at runtime, and use of Esri's basemaps and
location services is governed by the account the API key belongs to.
