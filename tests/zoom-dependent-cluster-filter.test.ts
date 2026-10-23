import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import { hasZoomDependentClusterFilter } from "../packages/map/src/layer-sync";

function clusteredPointLayer(
  patch: Partial<GeoLibreLayer> = {},
  style: Partial<LayerStyle> = {},
): GeoLibreLayer {
  return {
    id: "points",
    name: "points",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, pointRenderer: "cluster", ...style },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { action: "zoom" },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    },
    ...patch,
  } as GeoLibreLayer;
}

describe("hasZoomDependentClusterFilter", () => {
  it("spots a clustered layer whose filter reads the zoom", () => {
    const layer = clusteredPointLayer({ filterExpression: [">=", ["zoom"], 8] });

    assert.equal(hasZoomDependentClusterFilter([layer]), true);
  });

  it("ignores a clustered layer whose filter does not", () => {
    const layer = clusteredPointLayer({ filterExpression: ["==", ["get", "action"], "pan"] });

    assert.equal(hasZoomDependentClusterFilter([layer]), false);
  });

  it("ignores a zoom-dependent filter on a layer that is not clustered", () => {
    const layer = clusteredPointLayer(
      { filterExpression: [">=", ["zoom"], 8] },
      {
        pointRenderer: "single",
      },
    );

    assert.equal(hasZoomDependentClusterFilter([layer]), false);
  });

  it('does not mistake a literal value of "zoom" for the zoom operator', () => {
    // A categorical Quick Filter compiles to ["in", ["get", f], ["literal", …]],
    // so a field whose selected value is the string "zoom" would otherwise
    // attach a listener and re-derive the cluster source on every zoom.
    const layer = clusteredPointLayer({
      quickFilters: [{ id: "q1", field: "action", kind: "categorical", values: ["zoom", "pan"] }],
    });

    assert.equal(hasZoomDependentClusterFilter([layer]), false);
  });

  it('does not mistake a single-value literal of "zoom" either', () => {
    const layer = clusteredPointLayer({
      quickFilters: [{ id: "q1", field: "action", kind: "categorical", values: ["zoom"] }],
    });

    assert.equal(hasZoomDependentClusterFilter([layer]), false);
  });

  it("still sees the zoom beside a literal that mentions it", () => {
    const layer = clusteredPointLayer({
      filterExpression: [
        "all",
        [">=", ["zoom"], 8],
        ["in", ["get", "action"], ["literal", ["zoom"]]],
      ],
    });

    assert.equal(hasZoomDependentClusterFilter([layer]), true);
  });

  it("ignores a layer with no authored filter at all", () => {
    assert.equal(hasZoomDependentClusterFilter([clusteredPointLayer()]), false);
  });
});
