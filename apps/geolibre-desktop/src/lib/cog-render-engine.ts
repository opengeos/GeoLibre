import type { GeoLibreCogLayerOptions, GeoLibreCogRenderEngine } from "@geolibre/plugins";

/**
 * The renderer the raster control decodes a COG with when a caller of
 * `addCogLayer` says nothing. The WASM tiler is aimed at local files and can
 * leave a remote programmatic layer registered without producing pixels, so a
 * caller that has not thought about it keeps the GPU renderer.
 */
export const LEGACY_COG_ENGINE: GeoLibreCogRenderEngine = "maplibre-gl-raster";

/**
 * Resolve the `defaults` fragment `addCogLayer` hands the raster control.
 *
 * The engine is a **control-wide** setting: naming one re-renders every raster
 * already on the map, not just the layer being added. So `"auto"` has to yield
 * no `engine` key at all rather than a default, which is what lets the STAC
 * panel's "Leave unchanged" option add a layer without clobbering rasters that
 * another panel put there.
 *
 * Lives here rather than inline in `usePlugins.ts` so it can be tested without
 * importing the whole built-in plugin registry (see `plugin-query-api.test.ts`).
 */
export function cogEngineDefaults(engine: GeoLibreCogLayerOptions["engine"]): {
  engine?: GeoLibreCogRenderEngine;
} {
  if (engine === "auto") return {};
  return { engine: engine ?? LEGACY_COG_ENGINE };
}

/**
 * Leave the raster control on its native, globe-compatible default for URL
 * deep links. A deep link starts an empty workspace, so the first COG mounts a
 * fresh control whose default is `cog-tiler-wasm`; later entries in the same
 * link keep that engine. Omitting the key also avoids re-rendering every layer
 * if this loader is reused with an existing control.
 */
export function deepLinkCogDefaults(): { engine?: GeoLibreCogRenderEngine } {
  return cogEngineDefaults("auto");
}
