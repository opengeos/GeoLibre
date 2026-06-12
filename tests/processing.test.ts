import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  calculateBoundsAlgorithm,
  countFeaturesAlgorithm,
  getAlgorithm,
  getVectorTool,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";

const layer: GeoLibreLayer = {
  id: "layer-a",
  name: "Layer A",
  type: "geojson",
  source: { type: "geojson" },
  visible: true,
  opacity: 1,
  style: { ...DEFAULT_LAYER_STYLE },
  metadata: {},
  geojson: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "A" },
        geometry: { type: "Point", coordinates: [-78, 35] },
      },
      {
        type: "Feature",
        properties: { name: "B" },
        geometry: { type: "Point", coordinates: [-77, 36] },
      },
    ],
  },
};

describe("processing registry", () => {
  it("finds registered algorithms by id", () => {
    assert.equal(getAlgorithm("count-features"), countFeaturesAlgorithm);
    assert.equal(getAlgorithm("missing"), undefined);
  });

  it("counts GeoJSON features", () => {
    const messages: string[] = [];
    countFeaturesAlgorithm.run({
      layers: [layer],
      parameters: { layer: "layer-a" },
      log: (message) => messages.push(message),
    });

    assert.deepEqual(messages, ["Feature count: 2"]);
  });

  it("spatially joins zone attributes onto points", () => {
    const zone: GeoLibreLayer = {
      ...layer,
      id: "zone",
      name: "Zone",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { region: "north" },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [0, 10],
                  [10, 10],
                  [10, 0],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      },
    };
    const points: GeoLibreLayer = {
      ...layer,
      id: "points",
      name: "Points",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "inside" },
            geometry: { type: "Point", coordinates: [5, 5] },
          },
          {
            type: "Feature",
            properties: { name: "outside" },
            geometry: { type: "Point", coordinates: [20, 20] },
          },
        ],
      },
    };

    const tool = getVectorTool("spatial-join");
    assert.ok(tool);

    // Inner join keeps only the point that falls inside the zone.
    let inner: FeatureCollection | null = null;
    tool.run({
      layers: [zone, points],
      parameters: { layer: "points", overlay: "zone", how: "inner" },
      log: () => {},
      addResultLayer: (_name, geojson) => {
        inner = geojson;
      },
    });
    assert.equal(inner!.features.length, 1);
    assert.equal(inner!.features[0].properties?.name, "inside");
    assert.equal(inner!.features[0].properties?.region, "north");

    // Left join keeps both points; the outside one gets no zone attribute.
    let left: FeatureCollection | null = null;
    tool.run({
      layers: [zone, points],
      parameters: { layer: "points", overlay: "zone", how: "left" },
      log: () => {},
      addResultLayer: (_name, geojson) => {
        left = geojson;
      },
    });
    assert.equal(left!.features.length, 2);
    const outside = left!.features.find(
      (f) => f.properties?.name === "outside",
    );
    // Unmatched left-join rows null-fill the join columns (consistent schema,
    // mirrors the sidecar), so `region` is present and null rather than absent.
    assert.equal(outside?.properties?.region, null);
  });

  it("spatial join drops feature ids, validates inputs, and handles empty join layers", () => {
    const tool = getVectorTool("spatial-join");
    assert.ok(tool);

    // Two overlapping zones so a single input point matches both (one-to-many).
    const zoneFeature = (region: string) => ({
      type: "Feature" as const,
      properties: { region },
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [0, 0],
            [0, 10],
            [10, 10],
            [10, 0],
            [0, 0],
          ],
        ],
      },
    });
    const zones: GeoLibreLayer = {
      ...layer,
      id: "zones",
      name: "Zones",
      geojson: {
        type: "FeatureCollection",
        features: [zoneFeature("north"), zoneFeature("south")],
      },
    };
    // Input point carries an `id`; a one-to-many join must not duplicate it.
    const pts: GeoLibreLayer = {
      ...layer,
      id: "pts",
      name: "Pts",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "p1",
            properties: { name: "pt" },
            geometry: { type: "Point", coordinates: [5, 5] },
          },
        ],
      },
    };

    let res: FeatureCollection | null = null;
    tool.run({
      layers: [zones, pts],
      parameters: { layer: "pts", overlay: "zones", how: "inner" },
      log: () => {},
      addResultLayer: (_n, g) => {
        res = g;
      },
    });
    assert.equal(res!.features.length, 2);
    assert.ok(res!.features.every((f) => f.id === undefined));
    // The one input feature matching two zones yields one output per match,
    // each carrying that join feature's distinct attribute.
    const regions = res!.features.map((f) => f.properties?.region).sort();
    assert.deepEqual(regions, ["north", "south"]);

    // Empty join layer: left keeps the input, inner returns nothing.
    const emptyJoin: GeoLibreLayer = {
      ...layer,
      id: "empty",
      name: "Empty",
      geojson: { type: "FeatureCollection", features: [] },
    };
    let leftEmpty: FeatureCollection | null = null;
    tool.run({
      layers: [pts, emptyJoin],
      parameters: { layer: "pts", overlay: "empty", how: "left" },
      log: () => {},
      addResultLayer: (_n, g) => {
        leftEmpty = g;
      },
    });
    assert.equal(leftEmpty!.features.length, 1);

    let innerEmpty: FeatureCollection | null = null;
    tool.run({
      layers: [pts, emptyJoin],
      parameters: { layer: "pts", overlay: "empty", how: "inner" },
      log: () => {},
      addResultLayer: (_n, g) => {
        innerEmpty = g;
      },
    });
    assert.equal(innerEmpty!.features.length, 0);

    // Unknown predicate is rejected (no result layer), mirroring the backend.
    let produced = false;
    const logs: string[] = [];
    tool.run({
      layers: [zones, pts],
      parameters: { layer: "pts", overlay: "zones", predicate: "bogus" },
      log: (m) => logs.push(m),
      addResultLayer: () => {
        produced = true;
      },
    });
    assert.equal(produced, false);
    assert.ok(logs.some((m) => m.includes("unknown predicate")));
  });

  it("selects features by attribute value", () => {
    const tool = getVectorTool("select-by-value");
    assert.ok(tool);
    const attr: GeoLibreLayer = {
      ...layer,
      id: "attr",
      name: "Attr",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "alpha", pop: 10 },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
          {
            type: "Feature",
            properties: { name: "beta", pop: 20 },
            geometry: { type: "Point", coordinates: [1, 0] },
          },
          {
            type: "Feature",
            properties: { name: "gamma", pop: null },
            geometry: { type: "Point", coordinates: [2, 0] },
          },
          {
            type: "Feature",
            properties: { name: "delta" }, // no "pop" key at all
            geometry: { type: "Point", coordinates: [3, 0] },
          },
        ],
      },
    };
    const run = (parameters: Record<string, unknown>): FeatureCollection => {
      let out: FeatureCollection = { type: "FeatureCollection", features: [] };
      tool.run({
        layers: [attr],
        parameters: { layer: "attr", ...parameters },
        log: () => {},
        addResultLayer: (_n, g) => {
          out = g;
        },
      });
      return out;
    };
    const names = (fc: FeatureCollection): (string | undefined)[] =>
      fc.features.map((f) => f.properties?.name as string | undefined).sort();

    // Numeric comparison: pop > 15 → only beta.
    assert.deepEqual(names(run({ field: "pop", operator: "gt", value: "15" })), [
      "beta",
    ]);
    // String equals.
    assert.deepEqual(
      names(run({ field: "name", operator: "eq", value: "alpha" })),
      ["alpha"],
    );
    // Case-insensitive contains.
    assert.deepEqual(
      names(run({ field: "name", operator: "contains", value: "ET" })),
      ["beta"],
    );
    // is-null matches both an explicit null (gamma) and a missing key (delta).
    assert.deepEqual(names(run({ field: "pop", operator: "is-null" })), [
      "delta",
      "gamma",
    ]);
    // is-not-null is the inverse: only the features with a real pop value.
    assert.deepEqual(names(run({ field: "pop", operator: "is-not-null" })), [
      "alpha",
      "beta",
    ]);
    // starts-with is case-insensitive.
    assert.deepEqual(
      names(run({ field: "name", operator: "starts-with", value: "AL" })),
      ["alpha"],
    );
    // neq excludes the matched value (nulls/missing never compare equal).
    assert.deepEqual(
      names(run({ field: "name", operator: "neq", value: "alpha" })),
      ["beta", "delta", "gamma"],
    );
    // gte / lte boundary checks.
    assert.deepEqual(names(run({ field: "pop", operator: "gte", value: "20" })), [
      "beta",
    ]);
    assert.deepEqual(names(run({ field: "pop", operator: "lte", value: "10" })), [
      "alpha",
    ]);
    // A field absent from every feature is schemaless all-empty, not an error:
    // eq matches nothing, is-null matches every feature.
    assert.equal(
      run({ field: "missing", operator: "eq", value: "x" }).features.length,
      0,
    );
    assert.equal(
      run({ field: "missing", operator: "is-null" }).features.length,
      4,
    );

    // A hex-looking string compares as text, not coerced to a number — matching
    // Python's float(), which rejects "0x10" (so the engines stay in sync).
    const hexLayer: GeoLibreLayer = {
      ...layer,
      id: "hex",
      name: "Hex",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { code: "0x10" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      },
    };
    const runHex = (parameters: Record<string, unknown>): number => {
      let n = 0;
      tool.run({
        layers: [hexLayer],
        parameters: { layer: "hex", field: "code", ...parameters },
        log: () => {},
        addResultLayer: (_n, g) => {
          n = g.features.length;
        },
      });
      return n;
    };
    assert.equal(runHex({ operator: "eq", value: "16" }), 0);
    assert.equal(runHex({ operator: "eq", value: "0x10" }), 1);
  });

  it("selects features by location, including disjoint", () => {
    const tool = getVectorTool("select-by-location");
    assert.ok(tool);
    const square = (id: string, x: number): GeoLibreLayer => ({
      ...layer,
      id,
      name: id,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [x, 0],
                  [x, 1],
                  [x + 1, 1],
                  [x + 1, 0],
                  [x, 0],
                ],
              ],
            },
          },
        ],
      },
    });
    const a = square("a", 0); // covers x in [0,1]
    const overlap = square("overlap", 0.5); // intersects a
    const far = square("far", 10); // disjoint from a

    const run = (
      filter: GeoLibreLayer,
      predicate: string,
    ): FeatureCollection => {
      let out: FeatureCollection = { type: "FeatureCollection", features: [] };
      tool.run({
        layers: [a, filter],
        parameters: { layer: "a", overlay: filter.id, predicate },
        log: () => {},
        addResultLayer: (_n, g) => {
          out = g;
        },
      });
      return out;
    };

    assert.equal(run(overlap, "intersects").features.length, 1);
    assert.equal(run(far, "intersects").features.length, 0);
    assert.equal(run(far, "disjoint").features.length, 1);
    assert.equal(run(overlap, "disjoint").features.length, 0);
  });

  it("calculates and fits layer bounds", () => {
    const messages: string[] = [];
    let fittedBounds: [number, number, number, number] | null = null;

    calculateBoundsAlgorithm.run({
      layers: [layer],
      parameters: { layer: "layer-a" },
      log: (message) => messages.push(message),
      fitBounds: (bounds) => {
        fittedBounds = bounds;
      },
    });

    assert.deepEqual(messages, ["Bounds: [-78.000000, 35.000000, -77.000000, 36.000000]"]);
    assert.deepEqual(fittedBounds, [-78, 35, -77, 36]);
  });
});
