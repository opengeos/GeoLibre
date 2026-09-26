import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LayerSpecification } from "maplibre-gl";
import {
  pickOverlayGraphics,
  shadowOverlayGraphics,
  type OverlayStyle,
} from "../packages/map/src/arcgis-shadow-overlay";

const square = {
  type: "Polygon" as const,
  coordinates: [
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
  ],
};

function style(layers: LayerSpecification[]): OverlayStyle {
  return {
    sources: {
      cells: {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            { type: "Feature", id: 1, properties: { res: 5, name: "a" }, geometry: square },
            {
              type: "Feature",
              id: 2,
              properties: { res: 9, name: "b" },
              geometry: { type: "Point", coordinates: [5, 5] },
            },
          ],
        },
      },
      remote: { type: "geojson", data: "https://example.com/cells.geojson" },
    },
    layers,
  };
}

const never = () => false;

describe("ArcGIS shadow overlay", () => {
  it("draws fill, line, circle and text with per-feature paint", () => {
    const graphics = shadowOverlayGraphics(
      style([
        {
          id: "fill",
          type: "fill",
          source: "cells",
          paint: {
            "fill-color": ["case", [">", ["get", "res"], 6], "#ff0000", "#0000ff"],
            "fill-opacity": 0.5,
          },
        },
        {
          id: "line",
          type: "line",
          source: "cells",
          paint: { "line-color": "#00ff00", "line-width": 3, "line-dasharray": [2, 2] },
        },
        { id: "dots", type: "circle", source: "cells", paint: { "circle-radius": 4 } },
        {
          id: "labels",
          type: "symbol",
          source: "cells",
          layout: { "text-field": ["get", "name"], "text-size": 11 },
        },
      ]),
      4,
      never,
    );
    const byLayer = (id: string) => graphics.filter((graphic) => graphic.layerId === id);
    assert.deepEqual(byLayer("fill")[0].symbol, {
      type: "simple-fill",
      color: [0, 0, 255, 0.5],
      outline: { color: [0, 0, 0, 0], width: 0 },
    });
    assert.equal(byLayer("fill").length, 1, "a fill draws polygons only");
    const [line] = byLayer("line");
    assert.equal(line.geometry.type, "MultiLineString", "a line layer strokes the polygon rings");
    assert.equal(line.featureGeometry.type, "Polygon");
    assert.equal(line.symbol.width, "3px");
    assert.equal(line.symbol.style, "dash");
    assert.equal(byLayer("dots").length, 1, "a circle draws points only");
    assert.equal(byLayer("dots")[0].symbol.size, "8px");
    const labels = byLayer("labels");
    assert.deepEqual(
      labels.map((label) => [label.symbol.text, label.geometry]),
      [
        ["a", { type: "Point", coordinates: [1, 1] }],
        ["b", { type: "Point", coordinates: [5, 5] }],
      ],
      "a polygon is labelled at its centroid",
    );
    assert.equal((labels[0].symbol.font as { size: string }).size, "11px");
  });

  it("honours filters, visibility, zoom ranges and mirrored layers", () => {
    const layers: LayerSpecification[] = [
      { id: "filtered", type: "fill", source: "cells", filter: ["==", ["get", "res"], 9] },
      { id: "hidden", type: "fill", source: "cells", layout: { visibility: "none" } },
      { id: "zoomed", type: "fill", source: "cells", minzoom: 6 },
      { id: "mirrored", type: "fill", source: "cells" },
      { id: "remote", type: "fill", source: "remote" },
    ];
    const graphics = shadowOverlayGraphics(style(layers), 4, (id) => id === "mirrored");
    assert.deepEqual(graphics, []);
    assert.equal(
      shadowOverlayGraphics(style([layers[2]]), 6, never).length,
      1,
      "drawn once the zoom reaches the range",
    );
  });

  it("evaluates zoom expressions at the view's zoom", () => {
    const layer: LayerSpecification = {
      id: "line",
      type: "line",
      source: "cells",
      paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 11] },
    };
    assert.equal(shadowOverlayGraphics(style([layer]), 5, never)[0].symbol.width, "6px");
  });

  it("picks the topmost graphic of a layer and reports the feature's own geometry", () => {
    const graphics = shadowOverlayGraphics(
      style([{ id: "line", type: "line", source: "cells" }]),
      4,
      never,
    );
    const hits = pickOverlayGraphics(graphics, [2, 1], "line", 0.01);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].featureId, "1");
    assert.equal(hits[0].geometry?.type, "Polygon");
    assert.deepEqual(pickOverlayGraphics(graphics, [1, 1], "line", 0.01), [], "inside is a miss");
    assert.deepEqual(pickOverlayGraphics(graphics, [2, 1], "other", 0.01), []);
  });
});
