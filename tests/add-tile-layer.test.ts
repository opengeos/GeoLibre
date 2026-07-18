import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// Records the maplibre operations a sync performs so a test can assert the
// native raster path actually builds a source with the requested options.
interface MapCall {
  method: string;
  args: unknown[];
}

function makeEmptyMapStub() {
  const calls: MapCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getStyle: () => ({ layers: [] }),
    getLayer: () => undefined,
    getSource: () => undefined,
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    removeLayer: record("removeLayer"),
    removeSource: record("removeSource"),
    addLayer: record("addLayer"),
    addSource: record("addSource"),
  };
  return { map, calls };
}

describe("store.addTileLayer", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Tiles" });
    useAppStore.temporal.getState().clear();
  });

  it("creates a native XYZ raster layer that carries every source option", () => {
    const id = useAppStore.getState().addTileLayer("Imagery", {
      tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
      url: "https://tiles.example.com/{z}/{x}/{y}.png",
      tileSize: 512,
      attribution: "© Example",
      bounds: [166, -47, 178, -34],
      minzoom: 2,
      maxzoom: 22,
      scheme: "tms",
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer, "expected the layer to be added to the store");
    assert.equal(layer.type, "xyz");
    assert.equal(layer.source.type, "raster");
    assert.deepEqual(layer.source.tiles, ["https://tiles.example.com/{z}/{x}/{y}.png"]);
    assert.equal(layer.source.tileSize, 512);
    assert.equal(layer.source.attribution, "© Example");
    assert.deepEqual(layer.source.bounds, [166, -47, 178, -34]);
    assert.equal(layer.source.minzoom, 2);
    assert.equal(layer.source.maxzoom, 22);
    assert.equal(layer.source.scheme, "tms");
    assert.equal(layer.visible, true);
    assert.equal(layer.opacity, 1);
  });

  it("defaults type to xyz and tileSize to 256, dropping empty tiles", () => {
    const id = useAppStore.getState().addTileLayer("Topo", {
      tiles: ["", "https://tiles.example.com/topo/{z}/{x}/{y}.png", "  "],
      visible: false,
      opacity: 0.5,
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    assert.equal(layer.type, "xyz");
    assert.equal(layer.source.tileSize, 256);
    assert.deepEqual(layer.source.tiles, ["https://tiles.example.com/topo/{z}/{x}/{y}.png"]);
    assert.equal(layer.visible, false);
    assert.equal(layer.opacity, 0.5);
    // Omitted options must not leave undefined keys on the source.
    assert.ok(!("attribution" in layer.source));
    assert.ok(!("bounds" in layer.source));
  });

  it("trims surrounding whitespace on tile templates", () => {
    const id = useAppStore.getState().addTileLayer("Spaced", {
      tiles: ["  https://tiles.example.com/{z}/{x}/{y}.png  "],
    });
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    assert.deepEqual(layer.source.tiles, ["https://tiles.example.com/{z}/{x}/{y}.png"]);
  });

  it("rejects a registration that sanitizes down to no tiles", () => {
    assert.throws(
      () => useAppStore.getState().addTileLayer("Empty", { tiles: ["", "  "] }),
      /at least one non-empty tile URL template/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("rejects an inverted minzoom/maxzoom range", () => {
    assert.throws(
      () =>
        useAppStore.getState().addTileLayer("Inverted", {
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
          minzoom: 12,
          maxzoom: 4,
        }),
      /minzoom \(12\) must be <= maxzoom \(4\)/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("merges extra source fields under the required raster descriptor", () => {
    const id = useAppStore.getState().addTileLayer("Coverage", {
      type: "wms",
      tiles: ["https://wms.example.com/wms?...&BBOX={bbox-epsg-3857}"],
      source: { layers: "coverage", transparent: true },
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    assert.equal(layer.type, "wms");
    assert.equal(layer.source.type, "raster");
    assert.equal(layer.source.layers, "coverage");
    assert.equal(layer.source.transparent, true);
  });
});

describe("native raster tile sync", () => {
  // A native XYZ layer (no externalNativeLayer metadata) takes the
  // syncRasterTileLayer path, which must now forward bounds/attribution/zoom.
  function nativeTileLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
    const id = useAppStore.getState().addTileLayer("Imagery", {
      tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
      tileSize: 512,
      attribution: "© Example",
      bounds: [166, -47, 178, -34],
      minzoom: 2,
      maxzoom: 22,
      scheme: "tms",
    });
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    return { ...layer, ...patch };
  }

  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Tiles" });
    useAppStore.temporal.getState().clear();
  });

  it("builds a raster source honoring bounds, attribution, zoom, and scheme", () => {
    const layer = nativeTileLayer();
    const { map, calls } = makeEmptyMapStub();

    syncLayer(map as never, layer);

    const addSource = calls.find((c) => c.method === "addSource");
    assert.ok(addSource, "expected a raster source to be created");
    assert.equal(addSource.args[0], `source-${layer.id}`);
    const sourceSpec = addSource.args[1] as Record<string, unknown>;
    assert.equal(sourceSpec.type, "raster");
    assert.deepEqual(sourceSpec.tiles, ["https://tiles.example.com/{z}/{x}/{y}.png"]);
    assert.equal(sourceSpec.tileSize, 512);
    assert.equal(sourceSpec.attribution, "© Example");
    assert.deepEqual(sourceSpec.bounds, [166, -47, 178, -34]);
    assert.equal(sourceSpec.minzoom, 2);
    assert.equal(sourceSpec.maxzoom, 22);
    assert.equal(sourceSpec.scheme, "tms");

    const addLayer = calls.find((c) => c.method === "addLayer");
    assert.ok(addLayer, "expected a raster layer to be created");
    const layerSpec = addLayer.args[0] as Record<string, unknown>;
    assert.equal(layerSpec.id, `layer-${layer.id}-raster`);
    assert.equal(layerSpec.type, "raster");
  });

  it("skips addSource on a re-sync when the source already exists", () => {
    const layer = nativeTileLayer();
    const { map, calls } = makeEmptyMapStub();
    // Pre-seed the stub so getSource returns a truthy value: the source was
    // built on a prior sync, so a second pass must not rebuild it.
    (map as unknown as { getSource: () => object }).getSource = () => ({});

    syncLayer(map as never, layer);

    assert.equal(
      calls.find((c) => c.method === "addSource"),
      undefined,
      "addSource must not run when the source already exists",
    );
    assert.ok(
      calls.find((c) => c.method === "addLayer"),
      "ensureLayer should still create the raster layer spec",
    );
  });
});
