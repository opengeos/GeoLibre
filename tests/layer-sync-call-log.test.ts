import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  LARGE_VECTOR_FEATURE_THRESHOLD,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// A golden call log for the vector render path of MapLibre's layer sync. The
// render-layer builders create, update and drop a dozen native layers per
// store layer, and both the order of those calls and each layer's `beforeId`
// decide how the map stacks. Each scenario below drives one store layer
// through a sequence of styles on a single stateful fake map and records every
// map call; the log must match the committed fixture exactly, so a refactor
// that reorders a call (or changes a spec) fails here even when the finished
// map would look the same.
//
// After an intentional change, regenerate the fixture with
//   UPDATE_CALL_LOGS=1 node --import tsx --test tests/layer-sync-call-log.test.ts
// then format it with
//   npx oxfmt --write tests/fixtures/layer-sync-call-log.json
// and review its diff.

const FIXTURE = new URL("./fixtures/layer-sync-call-log.json", import.meta.url);
const UPDATE = process.env.UPDATE_CALL_LOGS === "1";

/** The layer every scenario inserts below, so each add carries a `beforeId`. */
const ANCHOR = "anchor-layer";

type Call = [method: string, ...args: unknown[]];

/**
 * Builds a stateful fake MapLibre map that records every method call.
 *
 * @returns The map and its ordered call log.
 */
function makeRecordingMap(): { map: maplibregl.Map; calls: Call[] } {
  const calls: Call[] = [];
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const paint = new Map<string, Record<string, unknown>>();
  const layout = new Map<string, Record<string, unknown>>();

  const place = (id: string, beforeId?: string) => {
    const at = order.indexOf(id);
    if (at >= 0) order.splice(at, 1);
    const before = beforeId ? order.indexOf(beforeId) : -1;
    if (before >= 0) order.splice(before, 0, id);
    else order.push(id);
  };
  const addLayer = (spec: Record<string, unknown>, beforeId?: string) => {
    const id = spec.id as string;
    layers.set(id, spec);
    paint.set(id, { ...(spec.paint as Record<string, unknown> | undefined) });
    layout.set(id, { ...(spec.layout as Record<string, unknown> | undefined) });
    place(id, beforeId);
  };
  addLayer({ id: ANCHOR, type: "background" });

  const impl: Record<string, (...args: never[]) => unknown> = {
    getSource: (id: string) => {
      const spec = sources.get(id);
      if (!spec) return undefined;
      return {
        ...spec,
        setData: (data: unknown) => calls.push(["source.setData", id, data]),
      };
    },
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    getLayer: (id: string) => (layers.has(id) ? { id, ...layers.get(id) } : undefined),
    addLayer: addLayer as never,
    removeLayer: (id: string) => {
      layers.delete(id);
      order.splice(order.indexOf(id), 1);
    },
    moveLayer: (id: string, beforeId?: string) => place(id, beforeId),
    getFilter: (id: string) => layers.get(id)?.filter,
    setFilter: (id: string, filter: unknown) => {
      const spec = layers.get(id);
      if (spec) spec.filter = filter;
    },
    getPaintProperty: (id: string, key: string) => paint.get(id)?.[key],
    setPaintProperty: (id: string, key: string, value: unknown) => {
      paint.get(id)![key] = value;
    },
    getLayoutProperty: (id: string, key: string) => layout.get(id)?.[key],
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      layout.get(id)![key] = value;
    },
    setLayerZoomRange: (id: string, minzoom: number, maxzoom: number) => {
      const spec = layers.get(id);
      if (spec) Object.assign(spec, { minzoom, maxzoom });
    },
    getZoom: () => 4,
    getStyle: () => ({
      version: 8,
      layers: order.map((id) => ({ ...layers.get(id), id })),
      sources: Object.fromEntries(sources),
    }),
    getLayersOrder: () => [...order],
    hasImage: () => false,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
  };

  const map = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        const fn = impl[prop];
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
          return fn ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
        };
      },
    },
  ) as maplibregl.Map;
  return { map, calls };
}

/**
 * Makes a call log JSON-stable: functions become a marker and a large
 * FeatureCollection collapses to its feature count, so the fixture stays
 * readable.
 *
 * @param calls The recorded calls.
 * @returns A plain JSON value.
 */
function normalize(calls: Call[]): unknown {
  return JSON.parse(
    JSON.stringify(calls, (_key, value: unknown) => {
      if (typeof value === "function") return "[function]";
      if (value === undefined) return "[undefined]";
      if (
        value &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "FeatureCollection" &&
        Array.isArray((value as FeatureCollection).features) &&
        (value as FeatureCollection).features.length > 20
      ) {
        return `[FeatureCollection x${(value as FeatureCollection).features.length}]`;
      }
      return value;
    }),
  );
}

function feature(geometry: Feature["geometry"], properties: Record<string, unknown>): Feature {
  return { type: "Feature", properties, geometry };
}

function square(x: number, y: number, z?: number): number[][] {
  const at = (px: number, py: number) => (z === undefined ? [px, py] : [px, py, z]);
  return [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x, y)];
}

const polygons: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    feature({ type: "Polygon", coordinates: [square(0, 0)] }, { name: "A", kind: "a", pop: 10 }),
    feature({ type: "Polygon", coordinates: [square(2, 0)] }, { name: "B", kind: "b", pop: 20 }),
    feature(
      { type: "MultiPolygon", coordinates: [[square(4, 0)], [square(6, 0)]] },
      { name: "C", kind: "a", pop: 30 },
    ),
  ],
};

const lines: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    feature(
      {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      },
      { name: "L1", speed: 30 },
    ),
    feature(
      {
        type: "LineString",
        coordinates: [
          [0, 2],
          [2, 2],
        ],
      },
      { name: "L2", speed: 60 },
    ),
  ],
};

const points: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    feature({ type: "Point", coordinates: [0, 0] }, { name: "P1", kind: "a", pop: 1 }),
    feature({ type: "Point", coordinates: [0, 0] }, { name: "P1", kind: "b", pop: 2 }),
    feature({ type: "Point", coordinates: [1, 1] }, { name: "P2", kind: "a", pop: 3 }),
    // A geoman text marker renders through the text symbol layer.
    feature(
      { type: "Point", coordinates: [2, 2] },
      { shape: "text_marker", text: "Note", "text-color": "#ff0000" },
    ),
  ],
};

const kmlPoints: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    feature(
      { type: "Point", coordinates: [0, 0] },
      { name: "K1", __geolibre_kml_icon_url: "https://example.com/icon.png" },
    ),
    feature({ type: "Point", coordinates: [1, 1] }, { name: "K2" }),
  ],
};

const mixed: FeatureCollection = {
  type: "FeatureCollection",
  features: [...polygons.features, ...lines.features, ...points.features.slice(0, 3)],
};

function vectorLayer(
  id: string,
  geojson: FeatureCollection,
  style: Partial<LayerStyle> = {},
  patch: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 0.8,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: {},
    geojson,
    ...patch,
  };
}

const labels = (patch: Partial<LayerStyle["labels"]>): Partial<LayerStyle> => ({
  labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name", ...patch },
});

const categorized: Partial<LayerStyle> = {
  vectorStyleMode: "categorized",
  vectorStyleProperty: "kind",
  vectorStyleStops: [
    { value: "a", color: "#ff0000", label: "A" },
    { value: "b", color: "#00ff00", label: "B" },
  ],
};

const graduated: Partial<LayerStyle> = {
  vectorStyleMode: "graduated",
  vectorStyleProperty: "pop",
  vectorStyleStops: [
    { value: 0, color: "#ffffcc", label: "low" },
    { value: 15, color: "#800026", label: "high" },
  ],
};

/** Each scenario is one store layer driven through a sequence of states. */
const scenarios: Record<string, GeoLibreLayer[]> = {
  polygons: [
    vectorLayer("poly", polygons),
    vectorLayer("poly", polygons, categorized),
    vectorLayer("poly", polygons, graduated),
    vectorLayer("poly", polygons, { fillPattern: "hatch" } as Partial<LayerStyle>),
    vectorLayer("poly", polygons, labels({})),
    vectorLayer("poly", polygons, labels({ expression: '["upcase", ["get", "name"]]' })),
    vectorLayer("poly", polygons, labels({ expression: "not json", placement: "line" })),
    // An unparseable expression and no field leave nothing to label.
    vectorLayer("poly", polygons, labels({ expression: "not json", field: "" })),
    vectorLayer("poly", polygons, labels({})),
    vectorLayer("poly", polygons, {
      ...labels({
        sizeExpression: '["get", "pop"]',
        colorExpression: '"#123456"',
        visibilityExpression: '[">", ["get", "pop"], 5]',
        priorityExpression: '["get", "pop"]',
      }),
    }),
    vectorLayer("poly", polygons, { invertedFillEnabled: true } as Partial<LayerStyle>),
    vectorLayer("poly", polygons, {
      lineDecoration: "arrow",
      lineDecorationSpacing: 80,
    } as Partial<LayerStyle>),
    vectorLayer("poly", polygons, { geometryGenerator: "centroid" } as Partial<LayerStyle>),
    vectorLayer("poly", polygons, { geometryGenerator: "bounding-box" } as Partial<LayerStyle>),
    vectorLayer("poly", polygons, {
      extrusionEnabled: true,
      extrusionHeightProperty: "pop",
      ...labels({}),
    } as Partial<LayerStyle>),
    vectorLayer("poly", polygons, {
      extrusionEnabled: true,
      extrusionAdvancedStyleEnabled: true,
      extrusionHeightExpression: '["step", ["zoom"], 0, 10, ["get", "pop"]]',
      minZoom: 2,
    } as Partial<LayerStyle>),
    vectorLayer("poly", polygons, { minZoom: 3, maxZoom: 12 } as Partial<LayerStyle>),
    vectorLayer("poly", polygons, {}, { visible: false, opacity: 0.3 }),
    vectorLayer(
      "poly",
      polygons,
      { invertedFillEnabled: true } as Partial<LayerStyle>,
      {
        timeFilter: ["==", ["get", "kind"], "a"],
      } as Partial<GeoLibreLayer>,
    ),
    vectorLayer("poly", polygons),
  ],
  lines: [
    vectorLayer("line", lines),
    vectorLayer("line", lines, graduated),
    vectorLayer("line", lines, {
      lineDecoration: "arrow",
      ...labels({ placement: "line" }),
    } as Partial<LayerStyle>),
    vectorLayer("line", lines, { geometryGenerator: "buffer" } as Partial<LayerStyle>),
    vectorLayer("line", lines),
  ],
  points: [
    vectorLayer("pts", points),
    vectorLayer("pts", points, categorized),
    vectorLayer("pts", points, { markerEnabled: true, markerShape: "star" } as Partial<LayerStyle>),
    vectorLayer("pts", points, { pointRenderer: "heatmap" } as Partial<LayerStyle>),
    vectorLayer("pts", points, {
      pointRenderer: "cluster",
      clusterRadius: 40,
      clusterMaxZoom: 12,
    } as Partial<LayerStyle>),
    vectorLayer("pts", points, labels({ dedupe: "unique" })),
    vectorLayer("pts", points, labels({ dedupe: "concatenate" })),
    vectorLayer("pts", points, labels({ dedupe: "off" })),
    vectorLayer("pts", points, { geometryGenerator: "buffer" } as Partial<LayerStyle>),
    vectorLayer("pts", points),
  ],
  kml: [
    vectorLayer("kml", kmlPoints),
    vectorLayer("kml", kmlPoints, { markerEnabled: true, markerShape: "pin" }),
  ],
  mixed: [
    vectorLayer("mix", mixed),
    vectorLayer("mix", mixed, { ...categorized, ...labels({ dedupe: "unique" }) }),
    vectorLayer("mix", mixed, { extrusionEnabled: true } as Partial<LayerStyle>),
    vectorLayer("mix", mixed, { pointRenderer: "heatmap" } as Partial<LayerStyle>),
    vectorLayer("mix", mixed),
  ],
};

/**
 * A point layer above the tiling threshold, so it takes the geojson-vt path
 * (a vector source and a `source-layer` on every render layer).
 */
function tiledPoints(): FeatureCollection {
  const features: Feature[] = [];
  for (let i = 0; i <= LARGE_VECTOR_FEATURE_THRESHOLD; i++) {
    features.push(
      feature(
        { type: "Point", coordinates: [(i % 360) - 180, ((i / 360) % 170) - 85] },
        { name: `P${i % 7}` },
      ),
    );
  }
  return { type: "FeatureCollection", features };
}

function runScenario(states: GeoLibreLayer[]): unknown {
  const { map, calls } = makeRecordingMap();
  const log: unknown[] = [];
  for (const [step, layer] of states.entries()) {
    calls.length = 0;
    syncLayer(map, layer, ANCHOR);
    log.push({ step, calls: normalize(calls) });
  }
  return log;
}

describe("layer-sync vector render call log", () => {
  const actual: Record<string, unknown> = {};
  for (const [name, states] of Object.entries(scenarios)) {
    actual[name] = runScenario(states);
  }
  const tiled = tiledPoints();
  actual.tiled = runScenario([
    vectorLayer("vt", tiled),
    vectorLayer("vt", tiled, labels({ dedupe: "unique" })),
    vectorLayer("vt", tiled, {
      pointRenderer: "cluster",
      clusterRadius: 40,
      clusterMaxZoom: 12,
    } as Partial<LayerStyle>),
  ]);

  if (UPDATE) writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

  for (const name of Object.keys(actual)) {
    it(`replays the ${name} scenario call for call`, () => {
      assert.deepEqual(actual[name], expected[name]);
    });
  }
});
