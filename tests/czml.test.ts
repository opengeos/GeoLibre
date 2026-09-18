import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CZML_QUICK_PICKS,
  CZML_SOURCE_KIND,
  createCzmlLayer,
  czmlSource,
  isCesiumOnlyLayer,
  isCzmlLayer,
  parseCzml,
} from "../packages/core/src";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";

// CZML (Cesium Language) dynamic 3D scenes (issue #2290).
// Tests cover the layer builder, parser, quick picks, and CesiumLayerSync integration.

describe("czml layer builder & parser", () => {
  it("parses czml text into documents and rejects invalid input", () => {
    const arrayJson = JSON.stringify([
      { id: "document", name: "test", version: "1.0" },
      { id: "sat", point: { color: { rgba: [255, 0, 0, 255] } } },
    ]);
    const parsedArray = parseCzml(arrayJson);
    assert.ok(Array.isArray(parsedArray));
    assert.equal(parsedArray.length, 2);

    const singleJson = JSON.stringify({ id: "document", version: "1.0" });
    const parsedSingle = parseCzml(singleJson);
    assert.ok(Array.isArray(parsedSingle));
    assert.equal(parsedSingle.length, 1);

    assert.equal(parseCzml(""), null);
    assert.equal(parseCzml("not json"), null);
    assert.equal(parseCzml("12345"), null);
    assert.equal(parseCzml("null"), null);
  });

  it("builds a CZML layer from a URL", () => {
    const layer = createCzmlLayer({
      name: "Satellite Track",
      url: "https://example.com/orbit.czml",
    });
    assert.equal(layer.type, "3d-tiles");
    assert.equal(layer.source.url, "https://example.com/orbit.czml");
    assert.equal(layer.metadata.sourceKind, CZML_SOURCE_KIND);
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.metadata.identifiable, false);
    assert.deepEqual(layer.metadata.nativeLayerIds, [layer.id]);
    assert.equal(isCzmlLayer(layer), true);
    assert.equal(isCesiumOnlyLayer(layer), true);
    assert.equal(isCesiumSupportedLayerType(layer), true);

    const source = czmlSource(layer);
    assert.ok(source);
    assert.equal(source.url, "https://example.com/orbit.czml");
    assert.equal(source.data, undefined);
  });

  it("builds a CZML layer from inline data packets", () => {
    const packets = [
      { id: "document", name: "Simple Point", version: "1.0" },
      { id: "point1", point: { pixelSize: 10 } },
    ];
    const layer = createCzmlLayer({
      name: "Point Sample",
      data: packets,
      sourcePath: "/local/data/point.czml",
    });
    assert.equal(layer.type, "3d-tiles");
    assert.deepEqual(layer.source.czmlData, packets);
    // The document is stored once; `czml` is only read as a legacy fallback.
    assert.equal("czml" in layer.source, false);
    assert.equal(layer.source.sourcePath, "/local/data/point.czml");
    assert.equal(layer.sourcePath, "/local/data/point.czml");
    assert.equal(isCzmlLayer(layer), true);
    assert.equal(isCesiumOnlyLayer(layer), true);
    assert.equal(isCesiumSupportedLayerType(layer), true);

    const source = czmlSource(layer);
    assert.ok(source);
    assert.deepEqual(source.data, packets);
  });

  it("provides valid quick picks with document packets and timestamps", () => {
    assert.ok(CZML_QUICK_PICKS.length >= 2);
    for (const pick of CZML_QUICK_PICKS) {
      assert.ok(pick.name.length > 0);
      assert.ok(Array.isArray(pick.data));
      assert.ok(pick.data.length >= 2);
      const docPacket = pick.data[0];
      assert.equal(docPacket.id, "document");
      assert.equal(docPacket.version, "1.0");
    }
  });

  it("does not mistake ordinary 3D tiles or layers for CZML", () => {
    const tileset: GeoLibreLayer = {
      id: "plain-3d",
      name: "Tileset",
      type: "3d-tiles",
      source: { type: "3d-tiles", url: "https://example.com/tileset.json" },
      visible: true,
      opacity: 1,
      style: {},
      metadata: { sourceKind: "3d-tiles-url" },
    };
    assert.equal(isCzmlLayer(tileset), false);
    assert.equal(czmlSource(tileset), null);
  });
});

function makeGlobe() {
  const calls = {
    czmlLoads: [] as unknown[],
    dataSourcesAdded: [] as unknown[],
    dataSourcesRemoved: [] as unknown[],
  };

  const Cesium = {
    CzmlDataSource: {
      load: async (czml: unknown) => {
        calls.czmlLoads.push(czml);
        const clock = {
          startTime: { dayNumber: 2459000, secondsOfDay: 0 },
          stopTime: { dayNumber: 2459001, secondsOfDay: 0 },
          currentTime: { dayNumber: 2459000, secondsOfDay: 100 },
          clockRange: 1,
          multiplier: 60,
        };
        return {
          kind: "czml-data-source",
          show: true,
          clock,
          isLoading: false,
          entities: { values: [] },
        };
      },
    },
    Event: class {
      addEventListener() {
        return () => {};
      }
    },
  };

  const viewer = {
    clock: {
      startTime: null as unknown,
      stopTime: null as unknown,
      currentTime: null as unknown,
      clockRange: null as unknown,
      multiplier: null as unknown,
    },
    camera: { moveEnd: new Cesium.Event(), changed: new Cesium.Event() },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      primitives: {
        add: () => {},
        remove: () => {},
      },
      requestRender: () => {},
    },
    imageryLayers: {
      addImageryProvider: () => ({ show: true, alpha: 1 }),
      remove: () => {},
      raiseToTop: () => {},
    },
    dataSources: {
      add: async (ds: unknown) => {
        calls.dataSourcesAdded.push(ds);
        return ds;
      },
      remove: (ds: unknown) => {
        calls.dataSourcesRemoved.push(ds);
      },
    },
  };

  return { calls, Cesium, viewer };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CesiumLayerSync with CZML", () => {
  it("loads a CZML layer, adds dataSource, and syncs viewer clock", async () => {
    const { calls, Cesium, viewer } = makeGlobe();
    const sync = new CesiumLayerSync(Cesium as never, viewer as never, () => 10);

    const layer = createCzmlLayer({
      id: "czml-sat",
      name: "Satellite",
      url: "https://example.com/sat.czml",
    });

    sync.sync([layer]);
    for (let i = 0; i < 4; i++) await flush();

    assert.equal(calls.czmlLoads.length, 1);
    assert.equal(calls.czmlLoads[0], "https://example.com/sat.czml");
    assert.equal(calls.dataSourcesAdded.length, 1);

    // Verify clock synchronization
    assert.deepEqual(viewer.clock.startTime, { dayNumber: 2459000, secondsOfDay: 0 });
    assert.deepEqual(viewer.clock.stopTime, { dayNumber: 2459001, secondsOfDay: 0 });
    assert.deepEqual(viewer.clock.currentTime, { dayNumber: 2459000, secondsOfDay: 100 });
    assert.equal(viewer.clock.clockRange, 1);
    assert.equal(viewer.clock.multiplier, 60);

    // Verify getRenderStatus reports settled
    const status = sync.getRenderStatus();
    assert.deepEqual(status.pending, []);
    assert.deepEqual(status.errors, []);

    // Toggle visibility
    sync.sync([{ ...layer, visible: false }]);
    for (let i = 0; i < 4; i++) await flush();
    const ds = calls.dataSourcesAdded[0] as { show: boolean };
    assert.equal(ds.show, false);

    // Remove layer
    sync.sync([]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(calls.dataSourcesRemoved.length, 1);
    assert.equal(calls.dataSourcesRemoved[0], ds);
    sync.destroy();
  });

  it("parses a serialized inline document instead of handing Cesium a URL", async () => {
    const { calls, Cesium, viewer } = makeGlobe();
    const sync = new CesiumLayerSync(Cesium as never, viewer as never, () => 10);
    const packets = [
      { id: "document", name: "Serialized", version: "1.0" },
      { id: "p", point: { pixelSize: 4 } },
    ];

    sync.sync([createCzmlLayer({ id: "czml-str", name: "Text", data: JSON.stringify(packets) })]);
    for (let i = 0; i < 4; i++) await flush();

    assert.deepEqual(calls.czmlLoads, [packets]);
    assert.equal(calls.dataSourcesAdded.length, 1);

    sync.sync([createCzmlLayer({ id: "czml-bad", name: "Garbage", data: "not json" })]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(calls.czmlLoads.length, 1);
    assert.match(sync.getRenderStatus().errors[0], /Garbage: Invalid CZML document/);
    sync.destroy();
  });

  it("wraps a bare packet from the Python API into a document array", async () => {
    const packet = { id: "document", version: "1.0" };
    const layer = createCzmlLayer({ id: "czml-one", name: "One", data: [packet] });
    layer.source.czmlData = packet;
    assert.deepEqual(czmlSource(layer)?.data, [packet]);

    // The wrap is a fresh array per call, so an unrelated store update must
    // not read as a data change and reload the document.
    const { calls, Cesium, viewer } = makeGlobe();
    const sync = new CesiumLayerSync(Cesium as never, viewer as never, () => 10);
    sync.sync([layer]);
    for (let i = 0; i < 4; i++) await flush();
    sync.sync([{ ...layer, opacity: 0.5 }]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(calls.czmlLoads.length, 1);
    sync.destroy();
  });

  it("treats an empty packet array as no document", () => {
    const layer = createCzmlLayer({ id: "czml-empty", name: "Empty", data: [] });
    assert.equal(czmlSource(layer), null);
    assert.equal(isCesiumSupportedLayerType(layer), true);
  });

  it("elects the clock owner by layer order and re-elects when the owner leaves", async () => {
    const { calls, Cesium, viewer } = makeGlobe();
    const multipliers: Record<string, number> = {
      "https://example.com/a.czml": 10,
      "https://example.com/b.czml": 20,
      "https://example.com/c.czml": 30,
    };
    Cesium.CzmlDataSource.load = async (czml: unknown) => {
      calls.czmlLoads.push(czml);
      // `a` resolves after `b` even though it comes first in layer order.
      if (czml === "https://example.com/a.czml") await new Promise((r) => setTimeout(r, 20));
      return {
        kind: "czml-data-source",
        show: true,
        clock: { multiplier: multipliers[czml as string], currentTime: `t-${czml}` },
        isLoading: false,
        entities: { values: [] },
      };
    };
    const sync = new CesiumLayerSync(Cesium as never, viewer as never, () => 10);
    const a = createCzmlLayer({ id: "czml-a", name: "A", url: "https://example.com/a.czml" });
    const b = createCzmlLayer({ id: "czml-b", name: "B", url: "https://example.com/b.czml" });
    const c = createCzmlLayer({ id: "czml-c", name: "C", url: "https://example.com/c.czml" });

    sync.sync([a, b]);
    await new Promise((r) => setTimeout(r, 40));
    for (let i = 0; i < 4; i++) await flush();
    // Out-of-order loads still settle on the first layer.
    assert.equal(viewer.clock.multiplier, 10);
    assert.equal(viewer.clock.currentTime, "t-https://example.com/a.czml");

    // The user (or the Time Slider) moved the clock; a later document must not
    // stomp it while the owner is unchanged.
    viewer.clock.multiplier = 5;
    viewer.clock.currentTime = "scrubbed";
    sync.sync([a, b, c]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(viewer.clock.multiplier, 5);
    assert.equal(viewer.clock.currentTime, "scrubbed");

    // Removing the owner hands the clock to the next loaded document, without
    // reloading it.
    sync.sync([b, c]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(viewer.clock.multiplier, 20);
    assert.equal(viewer.clock.currentTime, "t-https://example.com/b.czml");
    assert.equal(calls.czmlLoads.length, 3);

    // Reordering already-loaded documents re-elects without a reload.
    sync.sync([c, b]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(viewer.clock.multiplier, 30);
    assert.equal(calls.czmlLoads.length, 3);

    sync.sync([c]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(viewer.clock.multiplier, 30);
    sync.destroy();
  });

  it("does not hand the clock to a document that never reached the scene", async () => {
    const { Cesium, viewer } = makeGlobe();
    viewer.dataSources.add = async () => {
      throw new Error("scene rejected the data source");
    };
    const sync = new CesiumLayerSync(Cesium as never, viewer as never, () => 10);
    sync.sync([createCzmlLayer({ id: "czml-x", name: "X", url: "https://example.com/x.czml" })]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(viewer.clock.multiplier, null);
    assert.match(sync.getRenderStatus().errors[0], /scene rejected/);
    sync.destroy();
  });

  it("handles load errors gracefully and reports in getRenderStatus", async () => {
    const { Cesium, viewer } = makeGlobe();
    Cesium.CzmlDataSource.load = async () => {
      throw new Error("Network timeout loading CZML");
    };

    const sync = new CesiumLayerSync(Cesium as never, viewer as never, () => 10);
    const layer = createCzmlLayer({
      id: "czml-fail",
      name: "Broken Orbit",
      url: "https://example.com/broken.czml",
    });

    sync.sync([layer]);
    for (let i = 0; i < 4; i++) await flush();

    const status = sync.getRenderStatus();
    assert.equal(status.errors.length, 1);
    assert.match(status.errors[0], /Broken Orbit: Network timeout loading CZML/);
    sync.destroy();
  });
});
