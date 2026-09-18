# MapLibre renderer

Choose **View → Rendering engine → MapLibre** to use GeoLibre's default
renderer. MapLibre GL JS is bundled with every GeoLibre distribution, requires
no account or access token, and is available for both the primary map and every
split pane.

MapLibre has the broadest feature and plugin compatibility in GeoLibre. New
projects use it unless `primaryRenderer` says otherwise, and an omitted
`viewKind` in a secondary pane also means MapLibre.

## Supported paths

- GeoJSON and imported vector data with single, categorized, graduated,
  rule-based, expression, proportional, heatmap, cluster, pattern, label, and
  extrusion styling.
- Raster and image sources, including XYZ, WMS, WMTS, COG/GeoTIFF, image and
  video overlays, raster PMTiles, and desktop MBTiles.
- Vector tiles and vector PMTiles or MBTiles, including imported Mapbox styles
  and ArcGIS vector-tile services.
- 3D Tiles, I3S, LiDAR and COPC point clouds, Gaussian splats, 3D models, Zarr,
  NetCDF/HDF, and deck.gl visualization layers through GeoLibre's specialized
  renderers and overlays.
- Feature picking, selection, editing, measurement, extent drawing, draggable
  placement, print and screenshot capture, and the full MapLibre-oriented
  plugin surface.

See [Supported Data Formats](data-formats.md) and [Features](features.md) for
the complete user-facing lists. Individual data sources can still have
platform, credential, or network requirements even though the MapLibre engine
itself does not.

## Map, globe, and terrain

MapLibre supports Mercator and globe projections. **Controls → Globe** switches
the projection, while **Controls → Terrain** adds elevation to either view. The
terrain source can be GeoLibre's global source or a compatible local or remote
COG DEM. This globe projection remains a MapLibre style map; choose the
[Cesium renderer](cesium-renderer.md) for a native 3D globe and Cesium-native
scene formats.

## Basemaps and plugins

The shared Basemaps panel provides keyless styles as well as optional provider
styles configured through **Settings → Environment Variables**. Provider keys
belong to those services and are not a requirement of MapLibre itself.

Plugins default to MapLibre support when their manifest omits `engines`.
MapLibre-specific plugins can access the native map through `app.getMap()`;
portable plugins should instead use the renderer-neutral or shared Style-Spec
APIs described in the [Plugin API](plugin-api.md).

## Architecture and license

`MapController` is the MapLibre implementation of `MapEngine`.
`packages/map/src/layer-sync.ts` reconciles project layer records with native
sources and style layers, while specialized controls register protocols or
shared overlays for formats that MapLibre does not draw directly. The reusable
headless surface is published as `@geolibre/map`.

MapLibre GL JS and GeoLibre are open source under permissive licenses. See the
[architecture](architecture.md#rendering-engine-model) for the shared engine
model and [Acknowledgements](acknowledgements.md) for project and license links.
