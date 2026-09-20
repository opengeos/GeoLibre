import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  canOpenLayerAttributeTable,
  isVectorControlAttributeSource,
} from "../apps/geolibre-desktop/src/lib/attribute-table-source";

function tiledLayer(): GeoLibreLayer {
  return {
    id: "cores",
    name: "evaluation_cores",
    type: "vector-tiles",
    source: { type: "vector-tiles" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: "maplibre-gl-vector",
      externalNativeLayer: true,
      vectorState: { ingestMode: "table", renderMode: "tiles" },
    },
  };
}

describe("attribute table sources", () => {
  it("offers the attribute table for a tiled GeoPackage before features are materialized", () => {
    const layer = tiledLayer();
    assert.equal(layer.geojson, undefined);
    assert.equal(canOpenLayerAttributeTable(layer), true);
    assert.equal(isVectorControlAttributeSource(layer), true);
  });
  it("respects the query capability override", () => {
    assert.equal(
      canOpenLayerAttributeTable({ ...tiledLayer(), capabilities: { query: false } }),
      false,
    );
  });
  it("does not offer complete tables for arbitrary tiles or streamed GeoParquet", () => {
    assert.equal(canOpenLayerAttributeTable({ ...tiledLayer(), metadata: {} }), false);
    const layer = tiledLayer();
    layer.metadata.vectorState = { ingestMode: "stream" };
    assert.equal(canOpenLayerAttributeTable(layer), false);
    assert.equal(canOpenLayerAttributeTable(undefined), false);
  });
  it("keeps GeoJSON tables available", () => {
    const layer = { ...tiledLayer(), type: "geojson" as const };
    assert.equal(canOpenLayerAttributeTable(layer), true);
    assert.equal(isVectorControlAttributeSource(layer), true);
    assert.equal(canOpenLayerAttributeTable({ ...layer, metadata: {} }), true);
  });
  it("offers a read-only attribute table for a CZML layer with materialized rows", () => {
    const layer: GeoLibreLayer = {
      ...tiledLayer(),
      id: "satellites",
      name: "Satellites",
      type: "3d-tiles",
      source: { type: "3d-tiles", czmlData: [{ id: "document" }] },
      metadata: { sourceKind: "czml", externalNativeLayer: true },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "celestrak-25544",
            geometry: null,
            properties: { name: "ISS", catalogNumber: "25544" },
          },
        ],
      },
    };
    assert.equal(canOpenLayerAttributeTable(layer), true);
    assert.equal(canOpenLayerAttributeTable({ ...layer, geojson: undefined }), false);
    // The branch is CZML's, not "anything carrying a geojson": a layer that
    // keeps one for its own reasons must not quietly acquire the table.
    assert.equal(
      canOpenLayerAttributeTable({
        ...layer,
        metadata: { ...layer.metadata, sourceKind: "3d-tiles-url" },
      }),
      false,
    );
  });
});
