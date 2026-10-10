# Cesium renderer

Choose **View → Rendering engine → Cesium** to render the primary workspace as
a native CesiumJS globe. Cesium is also available from the rendering-engine
menu in every split pane, so a project can place a globe beside any of the
other three engines. Primary and pane choices are saved with the project.

## Credentials

The globe works without a Cesium ion token: it drapes the project basemap as
its base imagery, uses keyless Terrarium elevation (or a configured COG) for
terrain, and shows a hint that links to the token setting. A token adds
Cesium World Terrain, Ion World Imagery as the fallback for a basemap with no
raster form, and access to ion-hosted assets. The hosted web version bundles a
demo token; the desktop and mobile apps need your own for those features.

Enter the token under **Settings → Environment Variables → Cesium Ion token**.
It is stored on the current device rather than in the project file. Developers
can alternatively set `CESIUM_TOKEN` or `VITE_CESIUM_TOKEN` at build time. See
[Optional 3D globe credentials](getting-started.md#optional-3d-globe-credentials-cesium-ion).

## Supported paths

- Styled GeoJSON, including categorized, graduated, rule-based, expression,
  proportional, marker, cluster, label, pattern, extrusion, and Z-aware
  rendering. Labels follow their anchor, offset, maximum width, and
  data-defined size, colour, opacity, and visibility; they are not rotated,
  not drawn along a line's path, and not thinned by collision. Points and
  labels on the far side of the Earth are hidden.
- XYZ, WMS, WMTS, COG, raster PMTiles, local MBTiles, image overlays, and other
  tile sources connected through GeoLibre's protocol bridge. COGs whose JPEG
  tiles omit their own tables (Maxar/Vantor open data) decode through
  geotiff.js, as on the 2D map.
- Vector tiles, vector PMTiles, and vector MBTiles draped through a hidden
  MapLibre renderer so their Style Specification output is preserved.
- Native 3D Tiles, Cesium ion tilesets and imagery, CZML, KML/KMZ, I3S scene
  layers, supported point clouds, and Gaussian-splat tilesets.
- Globe-native picking and highlighting, extent drawing, draggable placement,
  screenshots, print layouts, video and camera tours, terrain-aware elevation
  profiles, and environment effects.

The Layers panel retains unsupported content rather than deleting it. Such a
layer is marked as unavailable for the active engine and returns when the
project is switched to a compatible renderer. Plugins follow the same model:
only plugins whose `engines` list contains `cesium` remain active.

## Plugin controls

A plugin control on the globe receives the same MapLibre-shaped map it gets
on the ArcGIS renderer (issue #3088): camera, pointer events and DOM act on
the globe, and its Style Spec calls (`addSource`, `addLayer`,
`setPaintProperty`, `getStyle`, ...) are recorded into a style that is never
drawn as such. What that style holds reaches the globe in two ways:

- A layer the plugin mirrors into the GeoLibre store (a Web Services WMS or
  tile layer, STAC footprints) is drawn by the globe's layer sync from that
  store record, like any other layer.
- Any other GeoJSON layer (a grid, a graticule, a selection outline, a draw
  preview) is drawn as ground-clamped globe entities. Fill, line, circle and
  text layers are drawn with filters, zoom ranges, data-driven and zoom
  expressions, and text anchors and offsets evaluated per feature as MapLibre
  evaluates them. Lines and polygon edges follow rhumb lines, as a straight
  segment on the 2D map does. Points and labels past the horizon are hidden.
  Icons, fill patterns, extrusions and text along lines are not drawn, and
  labels have no collision handling.

Layer-scoped events (`map.on("click", layerId, ...)`, `mouseenter`,
`mouseleave`) and a point `queryRenderedFeatures` answer from whichever of
the two draws the layer, including the `layer-<id>-fill`-style ids MapLibre
derives for a store layer. `dragPan.disable()` and `scrollZoom.disable()`
suspend the globe's own camera inputs, so a control's box or line drawing
receives the drag; the `mousedown`/`mousemove`/`mouseup` events a browser
drops during a press on the globe are re-dispatched for it. Plugins read this
map through `getControlMap` in `packages/plugins/src/plugins/style-map.ts`.

A custom layer has no WebGL context to render into on the globe, so
`addLayer` with `type: "custom"` throws and a control that needs one fails to
mount, as before. Raster files added through the host's COG helpers import as
store `cog` records the globe draws natively. The LiDAR and Gaussian splat
panels cannot mount and are disabled in Add Data on the globe.

The Web Services catalogs (FEMA NFHL, USGS National Map, US EPA EnviroAtlas,
NASA Earthdata, NASA Earthaccess, Earthdata GIS, Ocean Data Platform, GeoLens,
Hugging Face, OpenAerialMap, Vantor Open Data, Fields of the World, USGS 3DEP, Satellite
Embeddings, and the STAC browsers), Esri Wayback, Gridlines, and the DGGS
grids run on the globe this way. Street View runs too: its location marker is a DOM element the
globe positions over the canvas each frame (`cesium-dom-marker.ts` in the
plugins package), in place of MapLibre's `Marker`, which reads a map
transform the facade does not have.
USGS NLDI and Reverse Geocode run as well: their popups go through
`createMapPopup` (`map-popup.ts`), which keeps MapLibre's `Popup` on a MapLibre
map and otherwise places the same markup through `project()` on every frame
(the facade fires `render` from the scene's `postRender`). The facade also
drops the `click` that ends a drag, as MapLibre's click tolerance does, so
panning the globe does not trigger a click-driven control.

## Scene and camera

The globe provides 3D, 2D, and Columbus scene modes, terrain, native globe
lighting, and a camera translated to and from GeoLibre's shared longitude,
latitude, zoom, bearing, and pitch state. Mixed panes synchronize by ground
resolution rather than raw zoom, keeping their apparent scales aligned even
when panes have different sizes.

## Loading and architecture

Cesium's JavaScript is loaded only when the first Cesium canvas mounts. Its
Workers, Assets, and Widgets are staged with the application and resolved from
`CESIUM_BASE_URL`; choosing another engine unmounts the Cesium canvas and
releases its rendering resources.

`CesiumEngine` implements the shared `MapEngine` interface, and
`CesiumLayerSync` translates project layers into Cesium data sources, imagery
layers, and primitives. See [3D globe view (CesiumJS)](architecture.md#3d-globe-view-cesiumjs)
for the detailed implementation, compatibility boundaries, camera conversion,
and persistence model.

CesiumJS is open source under the Apache 2.0 license. Cesium ion is a separate
hosted service with its own account terms and usage limits.
