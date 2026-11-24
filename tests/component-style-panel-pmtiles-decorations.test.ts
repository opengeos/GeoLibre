import { render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { createPMTilesStoreLayer } from "../packages/map/src/pmtiles-layer";

const { StylePanel } = await import("../apps/geolibre-desktop/src/components/panels/StylePanel");

describe("PMTiles line decorations in the real Style panel", () => {
  for (const renderer of ["maplibre", "mapbox", "cesium", "arcgis"] as const) {
    it(`offers generated tile decorations only when ${renderer} has a style document`, () => {
      const layer = createPMTilesStoreLayer({
        id: "streams",
        name: "Streams",
        url: "https://example.org/streams.pmtiles",
        tileType: "vector",
        sourceLayers: ["streams"],
      });
      useAppStore.setState({
        primaryRenderer: renderer,
        layers: [layer],
        selectedLayerId: layer.id,
      });
      render(
        createElement(StylePanel, {
          mapControllerRef: { current: null },
          onResizeStart: () => {},
          collapsed: false,
          onCollapsedChange: () => {},
        }),
      );
      const present = screen.queryAllByText("Line decoration", { exact: true }).length > 0;
      assert.equal(present, renderer === "maplibre" || renderer === "mapbox");
    });
  }
});
