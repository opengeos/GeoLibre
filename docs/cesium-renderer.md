# Cesium renderer

Choose **View → Rendering engine → Cesium** to render the primary workspace as
a native CesiumJS globe. Cesium is also available from the rendering-engine
menu in every split pane, so a project can place a globe beside any of the
other three engines. Primary and pane choices are saved with the project.

## Credentials

The renderer works without credentials. In that mode it draws the project's
basemap on an ellipsoid. An optional Cesium ion token adds Cesium World Terrain,
Ion World Imagery as a fallback, and access to ion-hosted assets.

Enter the token under **Settings → Environment Variables → Cesium Ion token**.
It is stored on the current device rather than in the project file. Developers
can alternatively set `CESIUM_TOKEN` or `VITE_CESIUM_TOKEN` at build time. See
[Optional 3D globe credentials](getting-started.md#optional-3d-globe-credentials-cesium-ion).

## Supported paths

- Styled GeoJSON, including categorized, graduated, rule-based, expression,
  proportional, marker, cluster, label, pattern, extrusion, and Z-aware
  rendering.
- XYZ, WMS, WMTS, COG, raster PMTiles, local MBTiles, image overlays, and other
  tile sources connected through GeoLibre's protocol bridge.
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
