import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GeoLibreLayer, LayerStyle } from "../packages/core/src/types";
import { buildLegend } from "../apps/geolibre-desktop/src/lib/print-legend";

function makeLayer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Layer 1",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {} as LayerStyle,
    metadata: {},
    ...overrides,
  } as unknown as GeoLibreLayer;
}

describe("buildLegend", () => {
  it("omits hidden layers", () => {
    const legend = buildLegend([
      makeLayer({ id: "a", name: "A", visible: false }),
      makeLayer({ id: "b", name: "B", visible: true }),
    ]);
    assert.deepEqual(
      legend.map((e) => e.name),
      ["B"],
    );
  });

  it("omits 3D and media layer types", () => {
    const legend = buildLegend([
      makeLayer({ id: "a", name: "Cloud", type: "lidar" }),
      makeLayer({ id: "b", name: "Tiles", type: "3d-tiles" }),
      makeLayer({ id: "c", name: "Clip", type: "video" }),
      makeLayer({ id: "d", name: "Points", type: "geojson" }),
    ]);
    assert.deepEqual(
      legend.map((e) => e.name),
      ["Points"],
    );
  });

  it("returns layers top-of-stack first", () => {
    const legend = buildLegend([
      makeLayer({ id: "bottom", name: "Bottom" }),
      makeLayer({ id: "top", name: "Top" }),
    ]);
    assert.deepEqual(
      legend.map((e) => e.name),
      ["Top", "Bottom"],
    );
  });

  it("uses the layer fill color for single-symbol vector layers", () => {
    const legend = buildLegend([
      makeLayer({
        name: "Parcels",
        style: { vectorStyleMode: "single", fillColor: "#ff0000" } as LayerStyle,
      }),
    ]);
    assert.equal(legend[0].swatches.length, 1);
    assert.equal(legend[0].swatches[0].color, "#ff0000");
  });

  it("expands graduated symbology into ramp swatches with labels", () => {
    const legend = buildLegend([
      makeLayer({
        name: "Population",
        style: {
          vectorStyleMode: "graduated",
          vectorStyleStops: [
            { value: 0, color: "#eef" },
            { value: 100, color: "#88a" },
            { value: 200, color: "#114" },
          ],
        } as LayerStyle,
      }),
    ]);
    assert.equal(legend[0].swatches.length, 3);
    assert.equal(legend[0].swatches[0].color, "#eef");
    assert.equal(legend[0].swatches[1].label, "≥ 100");
  });

  it("caps ramp swatches at six samples", () => {
    const stops = Array.from({ length: 12 }, (_, i) => ({
      value: i,
      color: `#0000${(i % 10).toString()}0`,
    }));
    const legend = buildLegend([
      makeLayer({
        name: "Many",
        style: {
          vectorStyleMode: "categorized",
          vectorStyleStops: stops,
        } as LayerStyle,
      }),
    ]);
    assert.equal(legend[0].swatches.length, 6);
  });

  it("gives raster and service layers a single neutral swatch", () => {
    const legend = buildLegend([
      makeLayer({ name: "Imagery", type: "raster" }),
      makeLayer({ name: "WMS", type: "wms" }),
    ]);
    assert.equal(legend.length, 2);
    assert.equal(legend[0].swatches.length, 1);
    assert.equal(legend[1].swatches.length, 1);
  });
});
