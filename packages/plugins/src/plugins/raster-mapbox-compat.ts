import type { RasterControl } from "maplibre-gl-raster";

/** Mapbox cannot fetch the custom protocol registered by the WASM tiler. */
export function configureMapboxRasterEngine(control: Pick<RasterControl, "setEngine">): void {
  const setEngine = control.setEngine.bind(control);
  // Apply to programmatic callers and restored settings as well as the panel.
  control.setEngine = (engine) =>
    setEngine(engine === "cog-tiler-wasm" ? "maplibre-gl-raster" : engine);
  control.setEngine("maplibre-gl-raster");
}
