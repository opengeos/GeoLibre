import { render, screen } from "./helpers/dom";
import { createElement } from "react";
import { it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";

const { LabelsSection } =
  await import("../apps/geolibre-desktop/src/components/panels/style-panel/LabelsSection");

const layer: GeoLibreLayer = {
  id: "polygon",
  name: "Polygon",
  type: "geojson",
  source: { type: "geojson" },
  visible: true,
  opacity: 1,
  style: DEFAULT_LAYER_STYLE,
  metadata: {},
  geojson: { type: "FeatureCollection", features: [] },
};

for (const supported of [false, true]) {
  it(`shows the polygon anchor control only on a supported engine (${supported})`, () => {
    render(
      createElement(LabelsSection, {
        layer,
        labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true },
        updateLabels: () => {},
        hasPolygons: true,
        supportsPolygonAnchors: supported,
        vectorStylePropertyOptions: [],
        setExpressionBuilderTarget: () => {},
      }),
    );
    assert.equal(screen.queryByLabelText(/One label per polygon/) !== null, supported);
  });
}
