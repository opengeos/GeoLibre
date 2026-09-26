import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "../types";

/**
 * The primary 2D map, whichever of the two Style Spec engines is drawing it.
 *
 * `app.getMap()` answers `null` on the Mapbox renderer by design, so a plugin
 * that reaches the map only through it silently no-ops there — the same
 * failure mode `engines` declarations exist to rule out on the globe. A plugin
 * that declares `engines: ["maplibre", "mapbox"]` reads the map through this
 * helper instead: the MapLibre map when there is one, else the Mapbox map
 * presented through MapLibre's types. That is the cast the Mapbox engine
 * itself applies when it hosts a MapLibre-typed control
 * (`MapboxEngine.adaptControl`), and it is honest for the surface both
 * libraries share: sources and style layers (`addSource`, `addLayer`,
 * `setPaintProperty`, `setLayoutProperty`, `setFilter`, `getSource`,
 * `getLayer`, `getStyle`, `moveLayer`), images (`addImage`, `updateImage`,
 * `hasImage`), the camera (`getBounds`, `getZoom`, `getCenter`, `easeTo`,
 * `jumpTo`, `fitBounds`, `project`, `unproject`), events (`on`, `off`, `once`,
 * `fire`), the DOM (`getCanvas`, `getCanvasContainer`, `getContainer`) and
 * picking (`queryRenderedFeatures`, `querySourceFeatures`).
 *
 * It is not honest for MapLibre-only members, which simply do not exist on a
 * Mapbox map: `addProtocol`, `setTransformRequest`, the terrain-aware camera
 * helpers (`calculateCameraOptionsFromCameraLngLatAltRotation`,
 * `getCenterClampedToGround`), the `transform`/`_camera` internals and
 * `CustomLayerInterface` layers. `setTerrain`/`getTerrain` exist on both but
 * take engine-specific DEM sources, so terrain goes through the host
 * (`app.setTerrainEnabled`). `getProjection()` also differs in shape
 * (`{ type }` on MapLibre, `{ name }` on Mapbox). `tests/plugin-engine-audit.test.ts`
 * fails a Mapbox-declaring plugin that reaches for one of those, or that still
 * reads the map through `app.getMap()` alone.
 *
 * @param app - The plugin host API, or nothing while a plugin is inactive.
 *   Anything with the same two doors works, so the host's own engine (whose
 *   `getMap` answers null on Mapbox and whose Mapbox engine carries
 *   `getMapboxMap`) can be passed directly.
 * @returns The MapLibre map, the Mapbox map through MapLibre's types, or `null`
 *   when neither 2D engine is mounted (a Cesium primary, or a map mid-swap).
 */
export function getStyleMap(
  app: Pick<GeoLibreAppAPI, "getMap" | "getMapboxMap"> | null | undefined,
): MapLibreMap | null {
  if (!app) return null;
  // The one read of the MapLibre-only door that is meant to be here: this is
  // the fallback the audit sends every Mapbox-capable plugin to.
  // engine-audit-allow: getMap-mapbox
  const map = app.getMap?.();
  if (map) return map;
  const mapbox = app.getMapboxMap?.();
  return mapbox ? (mapbox as unknown as MapLibreMap) : null;
}

/**
 * The map a plugin control talks to on any 2D renderer: {@link getStyleMap},
 * or on ArcGIS the host's control facade, whose style calls succeed and read
 * back without reaching the SDK.
 *
 * On ArcGIS the host draws what that style holds in two ways: a layer the
 * plugin mirrors into the GeoLibre store (a Web Services raster, registered
 * footprints) is drawn from the store record, and any other GeoJSON fill,
 * line, circle or text layer (a grid, a highlight, a draw preview) is drawn as
 * the host's own graphics. Use it where that covers what the plugin shows:
 * raster or vector-tile sources it does not mirror, icons, custom layers,
 * `Marker`/`Popup` and MapLibre-only APIs still need an ArcGIS path of their
 * own. See "Plugin controls" in docs/arcgis-renderer.md.
 *
 * @param app - The plugin host API, or nothing while a plugin is inactive.
 * @returns The MapLibre or Mapbox map, the ArcGIS control facade, or `null`
 *   when none is mounted (a Cesium primary, or a map mid-swap).
 */
export function getControlMap(
  app: Pick<GeoLibreAppAPI, "getMap" | "getMapboxMap" | "getArcgisControlMap"> | null | undefined,
): MapLibreMap | null {
  return getStyleMap(app) ?? app?.getArcgisControlMap?.() ?? null;
}
