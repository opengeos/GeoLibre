import { render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { FeatureCollection } from "geojson";
import type { VectorLayerInfo } from "maplibre-gl-vector";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  adoptedVectorLayerPatch,
  createVectorStoreLayer,
} from "../packages/plugins/src/plugins/vector-layer-sync";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { StylePanel } = await import("../apps/geolibre-desktop/src/components/panels/StylePanel");

const polygons: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Block A", area: 12 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

function polygonInfo(patch: Partial<VectorLayerInfo> = {}): VectorLayerInfo {
  return {
    id: "blocks",
    name: "Blocks",
    source: { kind: "url", url: "https://example.com/blocks.parquet" },
    format: "parquet",
    renderMode: "geojson",
    geometryType: "polygon",
    featureCount: 1,
    fields: ["name", "area"],
    visible: true,
    opacity: 1,
    picker: false,
    ingestMode: "table",
    style: {
      fillColor: "#3388ff",
      fillOpacity: 0.4,
      lineColor: "#3388ff",
      lineWidth: 2,
      circleColor: "#3388ff",
      circleRadius: 5,
      circleOpacity: 0.85,
    },
    sourceId: "blocks-source",
    layerIds: ["blocks-fill", "blocks-outline"],
    ...patch,
  };
}

/** A layer the control still draws, as a tiled load leaves it. */
function controlLayer(): GeoLibreLayer {
  return createVectorStoreLayer(polygonInfo({ renderMode: "tiles" }));
}

/** The same file after GeoLibre adopted it. */
function adoptedLayer(): GeoLibreLayer {
  const info = polygonInfo();
  const layer = createVectorStoreLayer(info);
  return { ...layer, ...adoptedVectorLayerPatch(layer, info, polygons) };
}

function renderFor(layer: GeoLibreLayer) {
  const labelled: GeoLibreLayer = {
    ...layer,
    // Labels on, so the label controls render and can be checked too.
    style: { ...layer.style, labels: { ...layer.style.labels, enabled: true, field: "name" } },
  };
  useAppStore.setState({ layers: [labelled], selectedLayerId: labelled.id });
  return render(
    createElement(StylePanel, {
      mapControllerRef: { current: null },
      onResizeStart: () => {},
      collapsed: false,
      onCollapsedChange: () => {},
    }),
  );
}

function hasHeading(text: string): boolean {
  return screen.queryAllByText(text, { exact: true }).length > 0;
}

describe("StylePanel for Add Vector Layer layers", () => {
  it("offers an adopted layer the full panel, like a drag-and-drop layer", () => {
    const { container } = renderFor(adoptedLayer());

    for (const heading of ["Joins", "Virtual fields", "Popup", "Fill pattern"]) {
      assert.ok(hasHeading(heading), `expected the ${heading} section`);
    }
    assert.ok(container.querySelector("#strokeWidthUnit"));
    assert.ok(container.querySelector("#labelMinZoom"));
    assert.ok(container.querySelector("#labelExpression"));
  });

  it("hides what the control cannot draw on a layer it still owns", () => {
    const { container } = renderFor(controlLayer());

    // No features in the store, so the feature-backed sections stay hidden.
    for (const heading of ["Joins", "Virtual fields", "Popup"]) {
      assert.equal(hasHeading(heading), false, `unexpected ${heading} section`);
    }
    // Shown before #2715 but ignored by the control.
    assert.equal(hasHeading("Fill pattern"), false);
    assert.equal(container.querySelector("#strokeWidthUnit"), null);
    assert.equal(container.querySelector("#labelMinZoom"), null);
    assert.equal(container.querySelector("#labelExpression"), null);
    // What the control does draw stays.
    assert.ok(container.querySelector("#fillColor"));
    assert.ok(container.querySelector("#labelField"));
    assert.ok(container.querySelector("#labelHaloWidth"));
  });
});
