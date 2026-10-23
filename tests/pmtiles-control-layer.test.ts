import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PMTilesLayerInfo } from "maplibre-gl-components";
import { isPlaceholderLayer } from "../packages/map/src/placeholders";
import { pmtilesStoreLayers } from "../packages/plugins/src/plugins/maplibre-components";

/** What the PMTiles control reports for an archive it has just loaded. */
function controlLayer(patch: Partial<PMTilesLayerInfo> = {}): PMTilesLayerInfo {
  return {
    id: "pmtiles-1",
    url: "https://example.org/units.pmtiles",
    name: "",
    tileType: "vector",
    sourceLayers: ["units"],
    // Built the way the real control builds them: `${sourceId}-${rawName}-${kind}` for what it drew.
    layerIds: ["pmtiles-1-units-fill", "pmtiles-1-units-line", "pmtiles-1-units-circle"],
    opacity: 0.8,
    pickable: true,
    ...patch,
  };
}

/**
 * The one layer an archive of a single source layer produces. An archive holding several is split
 * into a layer each, which `pmtiles-archive-layers.test.ts` covers.
 */
function pmtilesStoreLayer(id: string, info: PMTilesLayerInfo) {
  // Nothing ticked, so the whole archive: what the panel reports before a user touches it.
  const layers = pmtilesStoreLayers(id, info, []);
  assert.equal(layers.length, 1);
  return layers[0]!;
}

describe("the store layer the PMTiles control's layeradd produces", () => {
  it("renders rather than placeholding, on the control's own layer ids", () => {
    const layer = pmtilesStoreLayer("pmtiles-1", controlLayer());

    assert.equal(isPlaceholderLayer(layer), false);
    // The control made these; deriving a second set here would draw over the layers it added.
    assert.deepEqual(layer.metadata.nativeLayerIds, [
      "pmtiles-1-units-fill",
      "pmtiles-1-units-line",
      "pmtiles-1-units-circle",
    ]);
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

    // The colour lands in the layer's own style, which is the only thing that paints it.
    assert.equal(layer.style.fillColor, "#ff0000");
  });

  it("carries a picking opt-out through, rather than assuming the default", () => {
    const layer = pmtilesStoreLayer("pmtiles-1", controlLayer({ pickable: false }));

    assert.equal(layer.metadata.pickable, false);
  });
});
