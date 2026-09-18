import assert from "node:assert/strict";
import { it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import { restoreDeckViz } from "../packages/plugins/src/plugins/deckgl-viz/overlay";
import { createDeckVizStoreLayer } from "../packages/plugins/src/plugins/deckgl-viz/store-layer";
import { DEFAULT_DECK_VIZ_STYLE } from "../packages/plugins/src/plugins/deckgl-viz/registry";

// The deck-viz overlay used to reach the map only through `app.getMap()`, which
// the Mapbox engine deliberately leaves null. This drives the overlay against a
// host that exposes a Mapbox map alone and checks that Deck.gl Layers still
// render, follow the store, and force the Mercator projection there.
it("renders Deck.gl Layers on a host that only exposes a Mapbox map", async () => {
  class Scatterplot {
    props: Record<string, unknown>;
    constructor(props: Record<string, unknown>) {
      this.props = props;
    }
    get id() {
      return this.props.id as string;
    }
  }
  let rendered: Scatterplot[] = [];
  class Overlay {
    setProps(props: { layers: Scatterplot[] }) {
      rendered = props.layers;
    }
  }
  const projections: string[] = [];
  let projection = "globe";
  // The surface both engines' maps share and the overlay is allowed to touch.
  const map = {
    getProjection: () => ({ name: projection }),
    setProjection: (next: { name: string }) => {
      projection = next.name;
      projections.push(next.name);
    },
    getZoom: () => 3,
    project: (position: [number, number]) => ({
      x: position[0],
      y: position[1],
    }),
    on: () => {},
    off: () => {},
    once: () => {},
  };
  const controls: unknown[] = [];
  const app = {
    getMap: () => null,
    getMapboxMap: () => map,
    getDeckGL: async () => ({
      layers: { ScatterplotLayer: Scatterplot },
      mapbox: { MapboxOverlay: Overlay },
    }),
    addMapControl: (control: unknown) => {
      controls.push(control);
      return true;
    },
    removeMapControl: () => {},
  } as unknown as GeoLibreAppAPI;

  useAppStore.getState().newProject();
  const layer = createDeckVizStoreLayer({
    id: "viz",
    name: "Manhattan",
    config: {
      layerKind: "scatterplot",
      fieldMapping: { lng: 0, lat: 1 },
      style: { ...DEFAULT_DECK_VIZ_STYLE, radius: 20 },
    },
    rows: [
      [-73.98, 40.75],
      [-73.95, 40.78],
    ],
  });
  useAppStore.getState().addLayer(layer);

  restoreDeckViz(app, true);
  // ensure() resolves the deck.gl modules asynchronously before rendering.
  for (let i = 0; i < 20 && rendered.length === 0; i++) await new Promise((r) => setTimeout(r, 5));

  assert.equal(controls.length, 1, "the shared overlay mounts on the Mapbox host");
  assert.deepEqual(
    rendered.map((entry) => entry.id),
    ["viz"],
  );
  assert.equal(rendered[0].props.getRadius, 20);
  assert.deepEqual(projections, ["mercator"], "deck layers force Mercator on the Mapbox map");

  // Store changes still flow through: hiding the layer clears the overlay.
  useAppStore.getState().updateLayer("viz", { visible: false });
  assert.deepEqual(rendered, []);
  useAppStore.getState().updateLayer("viz", { visible: true, opacity: 0.5 });
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].props.opacity, 0.5);

  restoreDeckViz(app, false);
  assert.deepEqual(rendered, []);
});
