# Rendering Engines

GeoLibre can draw the same project with four rendering engines. **MapLibre GL
JS** is the default, but the primary map and every pane in a split layout can
independently use MapLibre, Mapbox GL JS, CesiumJS, or the ArcGIS Maps SDK for
JavaScript.

| Engine | Best suited to | Credentials and loading |
| --- | --- | --- |
| **MapLibre GL JS** | The broadest GeoLibre feature and plugin support; vector styles, raster data, terrain, and lightweight 3D content | No credential required; bundled with GeoLibre |
| **Mapbox GL JS** | Mapbox styles and services, Mapbox globe and terrain, and a Style-Spec-compatible alternative to MapLibre | A Mapbox access token is required; the engine is loaded only when selected |
| **CesiumJS** | A native 3D globe, terrain, 3D Tiles, CZML, Cesium ion assets, I3S, and globe-oriented analysis | A Cesium ion token is required; the web version bundles a demo token, desktop and mobile need your own; loaded only when selected |
| **ArcGIS Maps SDK for JavaScript** | Native ArcGIS services, Esri basemaps, and ArcGIS 2D maps or 3D scenes | Works without a key; an ArcGIS API key adds Esri basemap styles; SDK modules load from Esri's CDN when first selected |

## Switch the primary map

Choose **View → Rendering engine**, then select **MapLibre**, **Mapbox**,
**Cesium**, or **ArcGIS**. GeoLibre replaces the active canvas; it does not keep
the previous engine hidden and consuming graphics resources.

The project store is independent of any renderer, so the camera, layers,
groups, visibility, opacity, and most styling remain in place when you switch.
The selected engine is saved in the project and restored when it is reopened.
Some layer types and tools are engine-specific; unsupported layers remain in
the project and return when you switch to a compatible engine.

## Mix engines in split panes

Open **View → Split View** to create a multi-map layout. Use the rendering-engine
menu in a pane to choose any of the four engines for that pane. Panes can share
the primary camera or keep independent views, which makes it possible to compare
2D and 3D renderings, basemaps, or engine behavior side by side. Each pane's
engine choice and view state are saved with the project.

## Credentials

Open **Settings → Environment Variables** to enter a Mapbox access token, a
Cesium ion token, or an ArcGIS API key. These credentials are stored on the
current device and are not written to the shared project file.

- MapLibre needs no credential.
- Mapbox requires an access token and is subject to Mapbox's terms and usage
  pricing.
- Cesium requires a Cesium ion token. The web version bundles a demo token;
  the desktop and mobile apps need your own. The token enables Cesium World
  Terrain and ion-hosted imagery and assets.
- ArcGIS works without a key by translating the project basemap. A key enables
  Esri basemap styles. The renderer itself still needs access to
  `js.arcgis.com` on its first load because the SDK is not bundled.

See [Getting Started](../getting-started.md#optional-3d-globe-credentials-cesium-ion)
for credential setup. The [MapLibre](../maplibre-renderer.md),
[Mapbox](../mapbox-renderer.md), [Cesium](../cesium-renderer.md), and
[ArcGIS](../arcgis-renderer.md) renderer references cover engine-specific
behavior, supported layers, licensing, and deployment details.

## Feature compatibility

GeoLibre exposes only the tools and plugins supported by the active engine.
MapLibre currently has the widest compatibility. Mapbox shares much of the
MapLibre Style Specification surface, while Cesium and ArcGIS use native layer
and scene adapters. A plugin also declares which engines it supports, so an
unsupported plugin is suspended rather than allowed to fail silently.

For automation, the renderer names are `maplibre`, `mapbox`, `cesium`, and
`arcgis`. They are accepted by the Python API, MCP tools, iframe API, project
format, and plugin manifest. See [Embedding & Sharing](embedding.md#switching-renderers),
[Python](../python.md#rendering-engines-and-mixed-pane-layouts), and the
[project format](../project-format.md) for examples.
