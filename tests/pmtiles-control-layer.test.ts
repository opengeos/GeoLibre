import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PMTilesLayerInfo } from "maplibre-gl-components";
import { isPlaceholderLayer } from "../packages/map/src/placeholders";
import { pmtilesStoreLayer } from "../packages/plugins/src/plugins/maplibre-components";

/** What the PMTiles control reports for an archive it has just loaded. */
function controlLayer(patch: Partial<PMTilesLayerInfo> = {}): PMTilesLayerInfo {
  return {
    id: "pmtiles-1",
    url: "https://example.org/units.pmtiles",
    name: "",
    tileType: "vector",
    sourceLayers: ["units"],
    layerIds: ["control-fill", "control-line"],
    opacity: 0.8,
    pickable: true,
    ...patch,
  };
}

describe("the store layer the PMTiles control's layeradd produces", () => {
  it("renders rather than placeholding, on the control's own layer ids", () => {
    const layer = pmtilesStoreLayer("pmtiles-1", controlLayer());

    assert.equal(isPlaceholderLayer(layer), false);
    // The control made these; deriving ids here would name layers that do not exist.
    assert.deepEqual(layer.metadata.nativeLayerIds, ["control-fill", "control-line"]);
    assert.equal(layer.opacity, 0.8);
  });

  it("draws the control's 'unknown' tile type as vector, which is how it renders it", () => {
    const layer = pmtilesStoreLayer("pmtiles-1", controlLayer({ tileType: "unknown" }));

    assert.equal(layer.source.type, "vector");
    assert.equal(layer.metadata.tileType, "vector");
  });

  it("keeps a raster archive dimmed the way the panel shows it", () => {
    const layer = pmtilesStoreLayer(
      "pmtiles-1",
      controlLayer({ tileType: "raster", sourceLayers: [], layerIds: ["control-raster"] }),
    );

    assert.equal(layer.source.type, "raster");
    assert.equal(layer.style.fillOpacity, 0.6);
  });

  it("paints a source layer the color the control assigned it", () => {
    const layer = pmtilesStoreLayer(
      "pmtiles-1",
      controlLayer({ sourceLayerColors: { units: "#ff0000" } }),
    );

    assert.equal(layer.style.fillColor, "#ff0000");
    assert.deepEqual(layer.metadata.sourceLayerColors, { units: "#ff0000" });
  });

  it("carries a picking opt-out through, rather than assuming the default", () => {
    const layer = pmtilesStoreLayer("pmtiles-1", controlLayer({ pickable: false }));

    assert.equal(layer.metadata.pickable, false);
  });
});
