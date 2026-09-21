import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Layer } from "@deck.gl/core";
import type { MeasureControl } from "maplibre-gl-components";
import {
  MEASURE_FILL_COLOR,
  MEASURE_FILL_RGBA,
  MEASURE_LINE_COLOR,
  MEASURE_LINE_RGBA,
  measureMirrorLayer,
  syncLidarMeasureMirror,
  type MeasureMirrorMap,
  type MeasureMirrorOverlay,
} from "../packages/plugins/src/plugins/lidar-measure-mirror";

const SOURCE_ID = "measure-abc-source";

function lineFeature(): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  };
}

/** Records the overlay calls in order, so re-appending is assertable. */
function makeOverlay(): {
  overlay: MeasureMirrorOverlay;
  calls: string[];
  /** Append a layer the way a streaming point-cloud chunk would. */
  addForeign: (id: string) => void;
  order: () => string[];
} {
  const layers = new Map<string, Layer>();
  const calls: string[] = [];
  return {
    calls,
    addForeign: (id) => layers.set(id, { id } as Layer),
    order: () => [...layers.keys()],
    overlay: {
      hasLayer: (id) => layers.has(id),
      getLayers: () => [...layers.values()],
      addLayer: (id, layer) => {
        layers.set(id, layer);
        calls.push(`add:${id}`);
      },
      removeLayer: (id) => {
        layers.delete(id);
        calls.push(`remove:${id}`);
      },
    },
  };
}

function makeMap(data: GeoJSON.FeatureCollection | null): {
  map: MeasureMirrorMap;
  emit: (event: "sourcedata" | "render", payload?: { sourceId?: string }) => void;
  emitSourceData: (sourceId: string) => void;
  setData: (next: GeoJSON.FeatureCollection | null) => void;
  listenerCount: () => number;
} {
  let current = data;
  const listeners = new Map<string, Set<(event: { sourceId?: string }) => void>>();
  const emit = (event: "sourcedata" | "render", payload: { sourceId?: string } = {}) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
  };
  return {
    map: {
      // Mirrors a MapLibre/Mapbox geojson source: the data is only readable
      // through the internal `_data` field the mirror reads.
      getSource: (id) =>
        id === SOURCE_ID && current ? { _data: { geojson: current } } : undefined,
      on: (event, listener) => {
        const existing = listeners.get(event) ?? new Set();
        existing.add(listener);
        listeners.set(event, existing);
      },
      off: (event, listener) => listeners.get(event)?.delete(listener),
    },
    emit,
    emitSourceData: (sourceId) => emit("sourcedata", { sourceId }),
    setData: (next) => {
      current = next;
    },
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
}

function makeControl(sourceId: string | null = SOURCE_ID): {
  control: MeasureControl;
  emit: () => void;
  listenerCount: () => number;
} {
  const listeners = new Set<() => void>();
  const control = {
    _sourceId: sourceId ?? undefined,
    on: (_event: string, handler: () => void) => listeners.add(handler),
    off: (_event: string, handler: () => void) => listeners.delete(handler),
  };
  return {
    control: control as unknown as MeasureControl,
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

const collection = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features,
});

describe("LiDAR measure mirror", () => {
  // The module holds the single attachment, so every test must hand it back.
  afterEach(() => syncLidarMeasureMirror({ map: null, overlay: null, control: null }));

  it("draws the measured geometry with the depth test off", () => {
    const layer = measureMirrorLayer(collection([lineFeature()]));
    assert.equal(
      (layer.props as { parameters?: { depthTest?: boolean } }).parameters?.depthTest,
      false,
      "the whole point is to ignore the point cloud's depth buffer",
    );
  });

  it("paints the mirror in the same colours as the MapLibre layers", () => {
    // The control gets the CSS strings, deck.gl the RGBA arrays; they have to
    // describe the same colour or the mirror would show as a second line.
    const hex = MEASURE_LINE_COLOR.replace("#", "");
    const fromHex = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
    assert.deepEqual(MEASURE_LINE_RGBA.slice(0, 3), fromHex);
    assert.equal(MEASURE_LINE_RGBA[3], 255);

    const rgba = MEASURE_FILL_COLOR.match(/[\d.]+/g)?.map(Number) ?? [];
    assert.deepEqual(MEASURE_FILL_RGBA.slice(0, 3), rgba.slice(0, 3));
    assert.equal(MEASURE_FILL_RGBA[3], Math.round((rgba[3] ?? 0) * 255));
  });

  it("mirrors the geometry into the overlay and follows later edits", () => {
    const { overlay, calls } = makeOverlay();
    const { map, emitSourceData } = makeMap(collection([lineFeature()]));
    const { control, emit } = makeControl();

    syncLidarMeasureMirror({ map, overlay, control });
    assert.deepEqual(calls, ["add:geolibre-measure-above-points"]);

    // A control event (a click that adds a vertex) redraws...
    emit();
    // ...and so does the source's own data event, which is all the rubber-band
    // preview fires as the cursor moves.
    emitSourceData(SOURCE_ID);
    assert.equal(calls.filter((call) => call.startsWith("add:")).length, 3);
    // Every redraw re-appends, so a point cloud loaded after the line was
    // drawn cannot end up painting over it.
    assert.deepEqual(calls.slice(1), [
      "remove:geolibre-measure-above-points",
      "add:geolibre-measure-above-points",
      "remove:geolibre-measure-above-points",
      "add:geolibre-measure-above-points",
    ]);
  });

  it("puts itself back on top when a streamed chunk lands above it", () => {
    const { overlay, calls, addForeign, order } = makeOverlay();
    const { map, emit } = makeMap(collection([lineFeature()]));
    const { control } = makeControl();

    syncLidarMeasureMirror({ map, overlay, control });
    // A frame with the mirror already last must not touch the overlay.
    calls.length = 0;
    emit("render");
    assert.deepEqual(calls, []);

    // Streaming appends a chunk layer, which would paint over the line.
    addForeign("pointcloud-chunk1");
    emit("render");
    assert.deepEqual(order(), ["pointcloud-chunk1", "geolibre-measure-above-points"]);
    assert.deepEqual(calls, [
      "remove:geolibre-measure-above-points",
      "add:geolibre-measure-above-points",
    ]);
  });

  it("ignores data events from other sources", () => {
    const { overlay, calls } = makeOverlay();
    const { map, emitSourceData } = makeMap(collection([lineFeature()]));
    const { control } = makeControl();

    syncLidarMeasureMirror({ map, overlay, control });
    calls.length = 0;
    emitSourceData("openmaptiles");
    assert.deepEqual(calls, []);
  });

  it("drops the mirror when the measurement is cleared", () => {
    const { overlay, calls } = makeOverlay();
    const { map, setData, emitSourceData } = makeMap(collection([lineFeature()]));
    const { control } = makeControl();

    syncLidarMeasureMirror({ map, overlay, control });
    setData(collection([]));
    calls.length = 0;
    emitSourceData(SOURCE_ID);
    assert.deepEqual(calls, ["remove:geolibre-measure-above-points"]);
  });

  it("detaches and clears up when either control goes away", () => {
    const { overlay, calls } = makeOverlay();
    const { map, listenerCount: mapListeners } = makeMap(collection([lineFeature()]));
    const { control, listenerCount: controlListeners } = makeControl();

    syncLidarMeasureMirror({ map, overlay, control });
    assert.equal(mapListeners(), 2, "sourcedata for edits, render for ordering");
    assert.ok(controlListeners() > 0);

    // The LiDAR panel closes: its overlay is gone, so the mirror must let go.
    syncLidarMeasureMirror({ map, overlay: null, control });
    assert.equal(mapListeners(), 0);
    assert.equal(controlListeners(), 0);
    assert.equal(calls.at(-1), "remove:geolibre-measure-above-points");
  });

  it("re-attaches to a new overlay after a renderer swap", () => {
    const first = makeOverlay();
    const second = makeOverlay();
    const { map } = makeMap(collection([lineFeature()]));
    const { control } = makeControl();

    syncLidarMeasureMirror({ map, overlay: first.overlay, control });
    syncLidarMeasureMirror({ map, overlay: second.overlay, control });
    assert.deepEqual(second.calls, ["add:geolibre-measure-above-points"]);
    assert.equal(first.calls.at(-1), "remove:geolibre-measure-above-points");
  });

  it("stays out of the way when the control exposes no source id", () => {
    const { overlay, calls } = makeOverlay();
    const { map, listenerCount } = makeMap(collection([lineFeature()]));
    const { control } = makeControl(null);

    syncLidarMeasureMirror({ map, overlay, control });
    assert.deepEqual(calls, []);
    assert.equal(listenerCount(), 0);
  });
});
