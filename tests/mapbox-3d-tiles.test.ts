import assert from "node:assert/strict";
import { it } from "node:test";
import { useAppStore, DEFAULT_LAYER_STYLE } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  restoreMapboxTiles,
  flyToDeckTilesLocation,
} from "../packages/plugins/src/plugins/mapbox-3d-tiles";

it("restores Mapbox tiles, applies store changes, reports load errors and disposes on map removal", async () => {
  class Tile {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
    get id() {
      return this.props.id;
    }
    renderLayers() {
      return [];
    }
  }
  let rendered: Tile[] = [];
  class Overlay {
    setProps(props: { layers: Tile[] }) {
      rendered = props.layers;
    }
  }
  const removed: (() => void)[] = [];
  const map = {
    getProjection: () => ({ name: "mercator" }),
    once: (event: string, fn: () => void) => {
      if (event === "remove") removed.push(fn);
    },
    flyTo: () => {},
  };
  const app = {
    getMap: () => null,
    getMapboxMap: () => map,
    getDeckGL: async () => ({
      geoLayers: { Tile3DLayer: Tile },
      mapbox: { MapboxOverlay: Overlay },
    }),
    getMapProjection: () => "mercator",
    setMapProjection: () => {},
    addMapControl: () => true,
    removeMapControl: () => {},
  } as unknown as GeoLibreAppAPI;
  useAppStore.getState().newProject();
  useAppStore.getState().addLayer({
    id: "tiles",
    name: "Tiles",
    type: "3d-tiles",
    visible: true,
    opacity: 0.7,
    style: { ...DEFAULT_LAYER_STYLE },
    source: { url: "https://example.com/tileset.json", altitudeOffset: -300 },
    metadata: { sourceKind: "3d-tiles-url", externalNativeLayer: true },
  });
  try {
    await restoreMapboxTiles(app);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].props.altitudeOffset, -300);
    assert.equal(rendered[0].props.opacity, 0.7);
    rendered[0].props.onTilesetLoad({ cartographicCenter: [-75, 40, 320], zoom: 15 });
    assert.deepEqual(useAppStore.getState().layers[0].metadata.center, [-75, 40]);
    useAppStore.getState().updateLayer("tiles", { visible: false, opacity: 0.2 });
    assert.equal(rendered[0].props.visible, false);
    assert.equal(rendered[0].props.opacity, 0.2);
    rendered[0].props.onError(new Error("403: denied"));
    assert.equal(useAppStore.getState().layers[0].metadata.status, "error");
    assert.equal(useAppStore.getState().layers[0].metadata.error, "403: denied");
    // A changed source is a new deck layer; a stale instance's late callbacks
    // must not touch the store once it has been superseded.
    const stale = rendered[0];
    useAppStore.getState().updateLayer("tiles", {
      source: { url: "https://example.com/tileset.json", altitudeOffset: 0 },
    });
    assert.notEqual(rendered[0].id, stale.id);
    stale.props.onError(new Error("late"));
    assert.equal(useAppStore.getState().layers[0].metadata.error, "403: denied");
    rendered[0].props.onTilesetLoad({ cartographicCenter: [-75, 40, 320], zoom: 15 });
    assert.equal(useAppStore.getState().layers[0].metadata.status, "loaded");
    // Adding a tileset re-runs the restore; loaded layers keep their revision
    // (deck.gl would otherwise reload them under a new id).
    const loadedId = rendered[0].id;
    useAppStore.getState().addLayer({
      id: "second",
      name: "Second",
      type: "3d-tiles",
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      source: { url: "https://example.com/second.json" },
      metadata: { sourceKind: "3d-tiles-url", externalNativeLayer: true },
    });
    await restoreMapboxTiles(app, "second");
    assert.equal(rendered.length, 2);
    assert.ok(rendered.some((layer) => layer.id === loadedId));
    useAppStore.getState().removeLayer("second");
    useAppStore.getState().removeLayer("tiles");
    assert.equal(rendered.length, 0);
    await restoreMapboxTiles(app);
    assert.equal(removed.length, 1, "repeated restore must not accumulate remove listeners");
  } finally {
    removed.forEach((remove) => remove());
    useAppStore.getState().newProject();
  }
});

it("flies 3D tile panel actions through the ArcGIS view", () => {
  const targets: unknown[] = [];
  const app = {
    getArcgisView: () => ({
      goTo: async (target: unknown) => {
        targets.push(target);
      },
    }),
    getMapboxMap: () => null,
  } as unknown as GeoLibreAppAPI;
  flyToDeckTilesLocation(app, [-73, 40], 15);
  assert.deepEqual(targets, [{ center: [-73, 40], zoom: 15, tilt: 60 }]);
});
