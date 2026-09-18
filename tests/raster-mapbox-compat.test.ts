import assert from "node:assert/strict";
import { it } from "node:test";
import type { RenderEngine } from "maplibre-gl-raster";
import { configureMapboxRasterEngine } from "../packages/plugins/src/plugins/raster-mapbox-compat";

it("uses GPU rendering on Mapbox, including restored WASM choices", () => {
  const selected: RenderEngine[] = [];
  const control = {
    setEngine(engine: RenderEngine) {
      selected.push(engine);
    },
  };
  configureMapboxRasterEngine(control);
  control.setEngine("cog-tiler-wasm");
  control.setEngine("titiler");
  assert.deepEqual(selected, ["maplibre-gl-raster", "maplibre-gl-raster", "titiler"]);
});
