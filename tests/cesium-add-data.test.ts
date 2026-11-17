import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  supportsAddDataRenderer,
  unsupportedAddDataTitleKey,
} from "../apps/geolibre-desktop/src/lib/add-data-renderer";

describe("Cesium Add Data support", () => {
  it("disables the panels whose MapLibre controls cannot mount on the globe", () => {
    // The LiDAR and Gaussian splat controls need a MapLibre transform and
    // WebGL context the globe's control host does not have; offering them
    // would open nothing.
    for (const id of ["lidar", "splatting"])
      assert.equal(supportsAddDataRenderer(id, "cesium"), false, id);
  });

  it("keeps the sources the globe draws natively or through the store", () => {
    for (const id of [
      "vector",
      "raster",
      "stac",
      "pmtiles",
      "zarr",
      "3d-tiles",
      "cesium-ion",
      "czml",
    ])
      assert.equal(supportsAddDataRenderer(id, "cesium"), true, id);
  });

  it("names the globe, not another engine, in the disabled-entry tooltip", () => {
    for (const id of ["lidar", "splatting"])
      assert.equal(unsupportedAddDataTitleKey("cesium", id), "renderer.layerUnsupported", id);
    assert.equal(
      unsupportedAddDataTitleKey("mapbox", "mbtiles"),
      "renderer.layerMapboxUnsupported",
    );
    assert.equal(
      unsupportedAddDataTitleKey("arcgis", "lidar"),
      "renderer.layerArcgisViewUnsupported",
    );
    assert.equal(unsupportedAddDataTitleKey("arcgis", "stac"), "renderer.layerArcgisUnsupported");
  });
});
