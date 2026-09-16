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
  (`geolibre-cdn-engines` in `vite.config.ts`), so the renderer works offline
  afterwards like the other CDN-loaded engines.
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
  `script-src`. The SDK's stylesheet is fetched as text and inlined, since
  neither policy allows external stylesheets.

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
  `@geolibre/core` builds for the 2D map *per feature* with the style-spec
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
  SDK's own `FeatureLayer`, `TileLayer`, `MapImageLayer` and `ImageryLayer`.
- Georeferenced images, by the extent of their four corners.
- Shared layer/group visibility, opacity and ordering; synchronized or
  independent split-view cameras; the project's zoom and bounds constraints.
- Feature picking (click identify with a popup), selection highlighting, extent
  drawing, draggable placement, and engine-level image capture.
- The built-in controls the **Controls** menu governs, as the SDK's own widgets:
  fullscreen, compass (resets rotation), zoom (navigation), locate (geolocate)
  and the scale bar (metric or imperial). Attribution is drawn by the view
  itself (`attributionVisible`); Esri requires it and it cannot be hidden.

## Adding data

Files dropped onto the map, the host importers behind **Add Data → FlatGeobuf
Layer / GeoParquet Layer / KML / KMZ / Delimited Text**, and the **XYZ**,
**WMS**, **WMTS** and **ArcGIS Layer** dialogs all work on the ArcGIS map. The
**Vector Layer** and **Raster Layer** panels are MapLibre controls (the
`maplibre-gl-vector` and `maplibre-gl-raster` plugins) and do not mount here;
drop the file instead.

## Not supported yet

- A `MapView` is a flat Web Mercator map: no globe projection, no pitch, no
  terrain. A `SceneView`-backed 3D mode is the natural follow-up.
- deck.gl overlays (Deck.gl Layers, 3D Models, DuckDB query layers, 3D Tiles,
  LiDAR), COGs, Zarr, NetCDF, PMTiles and MBTiles archives, Gaussian splats and
  Cesium-only sources. **Add Data** greys these out while ArcGIS is the primary
  renderer, and the layer panels badge such layers **No ArcGIS**.
- Plugin controls. The engine has no MapLibre map for a `maplibre-gl` control
  to call into, so no bundled plugin declares `engines: ["arcgis"]`, and the
  on-map layer control is not mounted.
- Video overlays, heatmap and cluster point renderers (points draw as circles),
  SVG markers and fill patterns.

## Testing

`tests/arcgis-layers.test.ts` covers the layer compiler and basemap planner,
`tests/arcgis-engine.test.ts` drives the engine against a fake SDK, and
`tests/arcgis-renderer.test.ts` covers the project format, settings and loader
boundaries. None of them touch the network. `e2e/arcgis-renderer.spec.ts` is
the opt-in browser check against Esri's real CDN: set `ARCGIS_API_KEY` to run
it.

## License and terms

The ArcGIS Maps SDK for JavaScript is distributed by Esri under its own
[terms of use](https://developers.arcgis.com/javascript/latest/licensing/), not
an open-source license. GeoLibre does not redistribute it; the SDK is fetched
from Esri's CDN by the user's browser at runtime, and use of Esri's basemaps and
location services is governed by the account the API key belongs to.
