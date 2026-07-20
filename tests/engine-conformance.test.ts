import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MapLibreEngine } from "../packages/map/src/engine/maplibre-engine";
import { ArcGISSceneEngine } from "../packages/map/src/engine/arcgis-scene-engine";
import { createMapController } from "../packages/map/src/map-controller";
import type { GeoLibreLayer, MapViewState } from "@geolibre/core";

// Re-use the fake MapLibre map stub pattern from map-controller.test.ts
function makeFakeMap() {
  const calls: { method: string; args: unknown[] }[] = [];
  const queryResults: any[] = [];
  const map = {
    getCenter: () => ({ lng: -100, lat: 40 }),
    getZoom: () => 4,
    getBearing: () => 0,
    getPitch: () => 0,
    getProjection: () => ({ type: "mercator" }),
    getBounds: () => ({
      getWest: () => -120,
      getSouth: () => 30,
      getEast: () => -80,
      getNorth: () => 50,
    }),
    flyTo: (args: any) => calls.push({ method: "flyTo", args }),
    easeTo: (args: any) => calls.push({ method: "easeTo", args }),
    jumpTo: (args: any) => calls.push({ method: "jumpTo", args }),
    queryRenderedFeatures: (point: any) => {
      calls.push({ method: "queryRenderedFeatures", args: [point] });
      return queryResults;
    },
    on: (event: string, handler: any) => {
      calls.push({ method: "on", args: [event, handler] });
    },
    off: (event: string, handler: any) => {
      calls.push({ method: "off", args: [event, handler] });
    },
    getCanvas: () => ({ style: { cursor: "" } }),
  };

  return { map, calls, queryResults };
}

describe("Engine Conformance — MapLibreEngine", () => {
  it("satisfies basic MapEngine contract and properties", () => {
    const engine = new MapLibreEngine();
    assert.equal(engine.getController(), null);
    assert.equal(engine.supportsLayer({ id: "test", type: "geojson" } as GeoLibreLayer), true);
  });

  it("reads and applies view state correctly", () => {
    const engine = new MapLibreEngine();
    const controller = createMapController();
    const { map, calls } = makeFakeMap();

    (controller as any).map = map;
    (controller as any).styleReady = true;
    (engine as any).controller = controller;

    assert.equal(engine.getController(), controller);

    // Test readView
    const view = engine.readView();
    assert.deepEqual(view.center, [-100, 40]);
    assert.equal(view.zoom, 4);

    // Test applyView
    const targetView: MapViewState = {
      center: [-122, 37],
      zoom: 10,
      bearing: 15,
      pitch: 45,
    };
    engine.applyView(targetView);

    // Verify applyView called jumpTo
    const hasCameraCall = calls.some((c) => c.method === "jumpTo");
    assert.equal(hasCameraCall, true);
  });

  it("handles hit testing correctly", async () => {
    const engine = new MapLibreEngine();
    const controller = createMapController();
    const { map, queryResults } = makeFakeMap();

    queryResults.push({
      id: "feat1",
      layer: { id: "layer1" },
      properties: { name: "Feature 1" },
      geometry: { type: "Point", coordinates: [-122, 37] },
    });

    (controller as any).map = map;
    (controller as any).styleReady = true;
    (engine as any).controller = controller;

    const hits = await engine.hitTest({ x: 50, y: 50 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].layerId, "layer1");
    assert.equal(hits[0].featureId, "feat1");
    assert.deepEqual(hits[0].properties, { name: "Feature 1" });
    assert.deepEqual(hits[0].coordinate, [-122, 37]);
  });

  describe("ArcGISSceneEngine", () => {
    it("satisfies basic MapEngine contract and properties", () => {
      const engine = new ArcGISSceneEngine("view1");
      assert.equal(engine.supportsLayer({ id: "test", type: "geojson" } as GeoLibreLayer), true);
      assert.equal(engine.supportsLayer({ id: "test", type: "vector" } as GeoLibreLayer), false);
    });

    it("reads and applies view state correctly", () => {
      const engine = new ArcGISSceneEngine("view1");
      const calls: any[] = [];
      const mockView = {
        center: { longitude: -100, latitude: 40 },
        zoom: 4,
        camera: {
          heading: 0,
          tilt: 0,
          position: { longitude: -100, latitude: 40 }
        },
        goTo: (target: any, options: any) => {
          calls.push({ method: "goTo", target, options });
        }
      };
      (engine as any).view = mockView;

      const view = engine.readView();
      assert.deepEqual(view.center, [-100, 40]);
      assert.equal(view.zoom, 4);

      const targetView: MapViewState = {
        center: [-122, 37],
        zoom: 10,
        bearing: 15,
        pitch: 45,
      };
      engine.applyView(targetView);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "goTo");
      assert.deepEqual(calls[0].target, {
        target: [-122, 37],
        zoom: 10,
        heading: 15,
        tilt: 45
      });
    });

    it("handles hit testing correctly", async () => {
      const engine = new ArcGISSceneEngine("view1");
      const mockView = {
        hitTest: async (point: any) => {
          return {
            results: [
              {
                type: "graphic",
                graphic: {
                  layer: { id: "layer1" },
                  uid: "feat1",
                  attributes: { name: "Feature 1" }
                },
                mapPoint: { longitude: -122, latitude: 37 }
              }
            ]
          };
        }
      };
      (engine as any).view = mockView;

      const hits = await engine.hitTest({ x: 50, y: 50 });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].layerId, "layer1");
      assert.equal(hits[0].featureId, "feat1");
      assert.deepEqual(hits[0].properties, { name: "Feature 1" });
      assert.deepEqual(hits[0].coordinate, [-122, 37]);
    });
  });
});
