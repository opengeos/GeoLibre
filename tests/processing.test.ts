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
    const outside = left!.features.find((f) => f.properties?.name === "outside");
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

  it("attribute-joins a table's fields onto features by a key", () => {
    const tool = getVectorTool("attribute-join");
    assert.ok(tool);

    // Counties keyed by GEOID (a string with a leading zero) plus one county
    // whose key is stored as a number, to exercise the string/number coercion.
    const counties: GeoLibreLayer = {
      ...layer,
      id: "counties",
      name: "Counties",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { GEOID: "01001" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
          {
            type: "Feature",
            properties: { GEOID: 1003 },
            geometry: { type: "Point", coordinates: [1, 1] },
          },
          {
            type: "Feature",
            properties: { GEOID: "09999" },
            geometry: { type: "Point", coordinates: [2, 2] },
          },
        ],
      },
    };
    // Stats table (geometry ignored). Two rows share key "1003"; the first wins.
    const stats: GeoLibreLayer = {
      ...layer,
      id: "stats",
      name: "Stats",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { code: "01001", pop: 100, label: "Autauga" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
          {
            // Numeric county key matched against the string "1003" via valueToString.
            type: "Feature",
            properties: { code: "1003", pop: 200, label: "Barbour" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
          {
            type: "Feature",
            properties: { code: "1003", pop: 999, label: "DUPLICATE" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      },
    };

    // Left join keeps every county; "09999" has no stats row so its brought-over
    // columns are null-filled.
    let left: FeatureCollection | null = null;
    tool.run({
      layers: [counties, stats],
      parameters: {
        layer: "counties",
        overlay: "stats",
        target_field: "GEOID",
        join_field: "code",
        how: "left",
      },
      log: () => {},
      addResultLayer: (_name, geojson) => {
        left = geojson;
      },
    });
    assert.equal(left!.features.length, 3);
    const autauga = left!.features.find((f) => f.properties?.GEOID === "01001");
    assert.equal(autauga?.properties?.pop, 100);
    assert.equal(autauga?.properties?.label, "Autauga");
    // Numeric key 1003 matches the string "1003"; the first duplicate row wins.
    const barbour = left!.features.find((f) => f.properties?.GEOID === 1003);
    assert.equal(barbour?.properties?.pop, 200);
    assert.equal(barbour?.properties?.label, "Barbour");
    // The default field set excludes the join key ("code"), so it is not copied.
    assert.equal("code" in (barbour?.properties ?? {}), false);
    // Unmatched row null-fills the brought-over columns (consistent schema).
    const unmatched = left!.features.find((f) => f.properties?.GEOID === "09999");
    assert.equal(unmatched?.properties?.pop, null);
    assert.equal(unmatched?.properties?.label, null);

    // Inner join drops the unmatched county and honours an explicit field list.
    let inner: FeatureCollection | null = null;
    tool.run({
      layers: [counties, stats],
      parameters: {
        layer: "counties",
        overlay: "stats",
        target_field: "GEOID",
        join_field: "code",
        how: "inner",
        fields: "pop",
      },
      log: () => {},
      addResultLayer: (_name, geojson) => {
        inner = geojson;
      },
    });
    assert.equal(inner!.features.length, 2);
    const innerBarbour = inner!.features.find((f) => f.properties?.GEOID === 1003);
    assert.equal(innerBarbour?.properties?.pop, 200);
    // Only "pop" was requested, so "label" is not brought over.
    assert.equal("label" in (innerBarbour?.properties ?? {}), false);

    // A fields string that is only separators (e.g. ",") is treated as blank,
    // falling back to the default (all join fields except the key) rather than
    // erroring.
    let blankFields: FeatureCollection | null = null;
    tool.run({
      layers: [counties, stats],
      parameters: {
        layer: "counties",
        overlay: "stats",
        target_field: "GEOID",
        join_field: "code",
        how: "left",
        fields: " , ",
      },
      log: () => {},
      addResultLayer: (_name, geojson) => {
        blankFields = geojson;
      },
    });
    const blankAutauga = blankFields!.features.find((f) => f.properties?.GEOID === "01001");
    assert.equal(blankAutauga?.properties?.pop, 100);
    assert.equal(blankAutauga?.properties?.label, "Autauga");
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
    assert.deepEqual(names(run({ field: "pop", operator: "gt", value: "15" })), ["beta"]);
    // String equals.
    assert.deepEqual(names(run({ field: "name", operator: "eq", value: "alpha" })), ["alpha"]);
    // Case-insensitive contains.
    assert.deepEqual(names(run({ field: "name", operator: "contains", value: "ET" })), ["beta"]);
    // is-null matches both an explicit null (gamma) and a missing key (delta).
    assert.deepEqual(names(run({ field: "pop", operator: "is-null" })), ["delta", "gamma"]);
    // is-not-null is the inverse: only the features with a real pop value.
    assert.deepEqual(names(run({ field: "pop", operator: "is-not-null" })), ["alpha", "beta"]);
    // starts-with is case-insensitive.
    assert.deepEqual(names(run({ field: "name", operator: "starts-with", value: "AL" })), [
      "alpha",
    ]);
    // neq excludes the matched value (nulls/missing never compare equal).
    assert.deepEqual(names(run({ field: "name", operator: "neq", value: "alpha" })), [
      "beta",
      "delta",
      "gamma",
    ]);
    // SQL-like: neq on a numeric field excludes the null (gamma) and missing
    // (delta) rows, not just the equal one.
    assert.deepEqual(names(run({ field: "pop", operator: "neq", value: "10" })), ["beta"]);
    // gte / lte boundary checks.
    assert.deepEqual(names(run({ field: "pop", operator: "gte", value: "20" })), ["beta"]);
    assert.deepEqual(names(run({ field: "pop", operator: "lte", value: "10" })), ["alpha"]);
    // A field absent from every feature is schemaless all-empty, not an error:
    // eq matches nothing, is-null matches every feature.
    assert.equal(run({ field: "missing", operator: "eq", value: "x" }).features.length, 0);
    assert.equal(run({ field: "missing", operator: "is-null" }).features.length, 4);

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
    // A large square that fully contains `a`, and a tiny one fully inside it.
    const bigPoly = (id: string, coords: number[][]): GeoLibreLayer => ({
      ...layer,
      id,
      name: id,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id },
            geometry: { type: "Polygon", coordinates: [coords] },
          },
        ],
      },
    });
    const big = bigPoly("big", [
      [-5, -5],
      [-5, 5],
      [5, 5],
      [5, -5],
      [-5, -5],
    ]);
    const tiny = bigPoly("tiny", [
      [0.2, 0.2],
      [0.2, 0.4],
      [0.4, 0.4],
      [0.4, 0.2],
      [0.2, 0.2],
    ]);

    const run = (filter: GeoLibreLayer, predicate: string): FeatureCollection => {
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
    // within: `a` is within `big`; contains: `a` contains `tiny`.
    assert.equal(run(big, "within").features.length, 1);
    assert.equal(run(tiny, "within").features.length, 0);
    assert.equal(run(tiny, "contains").features.length, 1);
    assert.equal(run(big, "contains").features.length, 0);
    // Empty filter layer: disjoint keeps everything, the rest keep nothing.
    const empty: GeoLibreLayer = {
      ...layer,
      id: "emptyfilter",
      name: "emptyfilter",
      geojson: { type: "FeatureCollection", features: [] },
    };
    assert.equal(run(empty, "disjoint").features.length, 1);
    assert.equal(run(empty, "intersects").features.length, 0);
  });

  it("explodes multipart geometries into single-part features", () => {
    const tool = getVectorTool("explode");
    assert.ok(tool);
    const multi: GeoLibreLayer = {
      ...layer,
      id: "multi",
      name: "Multi",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "mp" },
            geometry: {
              type: "MultiPolygon",
              coordinates: [
                [
                  [
                    [0, 0],
                    [0, 1],
                    [1, 1],
                    [1, 0],
                    [0, 0],
                  ],
                ],
                [
                  [
                    [2, 2],
                    [2, 3],
                    [3, 3],
                    [3, 2],
                    [2, 2],
                  ],
                ],
              ],
            },
          },
          {
            type: "Feature",
            properties: { name: "single" },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [5, 5],
                  [5, 6],
                  [6, 6],
                  [6, 5],
                  [5, 5],
                ],
              ],
            },
          },
        ],
      },
    };
    let out: FeatureCollection | null = null;
    tool.run({
      layers: [multi],
      parameters: { layer: "multi" },
      log: () => {},
      addResultLayer: (_n, g) => {
        out = g;
      },
    });
    // The 2-part MultiPolygon splits into 2 Polygons; the single Polygon stays.
    assert.equal(out!.features.length, 3);
    assert.ok(out!.features.every((f) => f.geometry.type === "Polygon"));
    // Each part keeps its parent's attributes.
    const names = out!.features.map((f) => f.properties?.name).sort();
    assert.deepEqual(names, ["mp", "mp", "single"]);
  });

  it("aggregates features by attribute with a summary statistic", () => {
    const tool = getVectorTool("aggregate");
    assert.ok(tool);
    const cell = (region: string, pop: number, x: number) => ({
      type: "Feature" as const,
      properties: { region, pop },
      geometry: {
        type: "Polygon" as const,
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
    });
    const parcels: GeoLibreLayer = {
      ...layer,
      id: "parcels",
      name: "Parcels",
      geojson: {
        type: "FeatureCollection",
        features: [cell("north", 10, 0), cell("north", 30, 1), cell("south", 5, 5)],
      },
    };
    const run = (parameters: Record<string, unknown>): FeatureCollection => {
      let out: FeatureCollection = { type: "FeatureCollection", features: [] };
      tool.run({
        layers: [parcels],
        parameters: { layer: "parcels", group_field: "region", ...parameters },
        log: () => {},
        addResultLayer: (_n, g) => {
          out = g;
        },
      });
      return out;
    };
    const byRegion = (fc: FeatureCollection) =>
      new Map(fc.features.map((f) => [f.properties?.region, f.properties]));

    // Count: 2 north parcels, 1 south.
    const counts = byRegion(run({ statistic: "count" }));
    assert.equal(counts.size, 2);
    assert.equal(counts.get("north")?.count, 2);
    assert.equal(counts.get("south")?.count, 1);

    // Sum of pop per region, output column named "<field>_<stat>".
    const sums = byRegion(run({ statistic: "sum", stat_field: "pop" }));
    assert.equal(sums.get("north")?.pop_sum, 40);
    assert.equal(sums.get("south")?.pop_sum, 5);

    // Mean reduces the same numeric field.
    const means = byRegion(run({ statistic: "mean", stat_field: "pop" }));
    assert.equal(means.get("north")?.pop_mean, 20);

    // min/max exercise the reduce path (no Math.min/max spread).
    const mins = byRegion(run({ statistic: "min", stat_field: "pop" }));
    assert.equal(mins.get("north")?.pop_min, 10);
    const maxes = byRegion(run({ statistic: "max", stat_field: "pop" }));
    assert.equal(maxes.get("north")?.pop_max, 30);

    // Boolean stat values coerce to 1/0 like pandas to_numeric (sum of two
    // north parcels, one true + one false → 1), not dropped as non-numeric.
    const boolLayer: GeoLibreLayer = {
      ...parcels,
      id: "boolLayer",
      geojson: {
        type: "FeatureCollection",
        features: [
          { ...cell("north", 1, 0), properties: { region: "north", flag: true } },
          { ...cell("north", 1, 1), properties: { region: "north", flag: false } },
        ],
      },
    };
    let boolOut: FeatureCollection = { type: "FeatureCollection", features: [] };
    tool.run({
      layers: [boolLayer],
      parameters: {
        layer: "boolLayer",
        group_field: "region",
        statistic: "sum",
        stat_field: "flag",
      },
      log: () => {},
      addResultLayer: (_n, g) => {
        boolOut = g;
      },
    });
    assert.equal(boolOut.features[0]?.properties?.flag_sum, 1);

    // A feature whose group value is null is skipped (no "null" bucket), matching
    // pandas groupby(dropna=True) on the sidecar.
    const withNull: GeoLibreLayer = {
      ...parcels,
      id: "withNull",
      geojson: {
        type: "FeatureCollection",
        features: [
          cell("north", 10, 0),
          { ...cell("x", 1, 5), properties: { region: null, pop: 1 } },
        ],
      },
    };
    let nullOut: FeatureCollection = { type: "FeatureCollection", features: [] };
    tool.run({
      layers: [withNull],
      parameters: { layer: "withNull", group_field: "region", statistic: "count" },
      log: () => {},
      addResultLayer: (_n, g) => {
        nullOut = g;
      },
    });
    assert.equal(nullOut.features.length, 1);
    assert.equal(nullOut.features[0].properties?.region, "north");

    // A group field absent from every feature errors (parity with the backend's
    // "not found" guard) rather than producing one empty bucket.
    let missingProduced = false;
    const missingLogs: string[] = [];
    tool.run({
      layers: [parcels],
      parameters: { layer: "parcels", group_field: "nope", statistic: "count" },
      log: (m) => missingLogs.push(m),
      addResultLayer: () => {
        missingProduced = true;
      },
    });
    assert.equal(missingProduced, false);
    assert.ok(missingLogs.some((m) => m.includes("not found")));

    // The field exists but every value is null: not an error (polygons exist),
    // an empty grouped result matching the sidecar's pandas dropna behaviour.
    const allNull: GeoLibreLayer = {
      ...parcels,
      id: "allNull",
      geojson: {
        type: "FeatureCollection",
        features: [
          { ...cell("x", 1, 0), properties: { region: null, pop: 1 } },
          { ...cell("y", 2, 5), properties: { region: null, pop: 2 } },
        ],
      },
    };
    let allNullOut: FeatureCollection | null = null;
    const allNullLogs: string[] = [];
    tool.run({
      layers: [allNull],
      parameters: { layer: "allNull", group_field: "region", statistic: "count" },
      log: (m) => allNullLogs.push(m),
      addResultLayer: (_n, g) => {
        allNullOut = g;
      },
    });
    assert.ok(allNullOut);
    assert.equal(allNullOut!.features.length, 0);
    assert.ok(allNullLogs.some((m) => m.includes("0 group(s)")));
    assert.ok(!allNullLogs.some((m) => m.includes("requires polygon")));
  });

  it("reproject defers to the Python engine on the client", () => {
    const tool = getVectorTool("reproject");
    assert.ok(tool);
    const messages: string[] = [];
    let produced = false;
    tool.run({
      layers: [layer],
      parameters: { layer: "layer-a", source_crs: "EPSG:3857" },
      log: (m) => messages.push(m),
      addResultLayer: () => {
        produced = true;
      },
    });
    // The client engine cannot reproject; it points the user at Sidecar/Pyodide
    // and produces no layer.
    assert.equal(produced, false);
    assert.ok(messages.some((m) => m.includes("Python engine")));
  });

  it("smooths polygon corners with Chaikin's algorithm", () => {
    const tool = getVectorTool("smooth");
    assert.ok(tool);
    const square: GeoLibreLayer = {
      ...layer,
      id: "square",
      name: "Square",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "s" },
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
    let out: FeatureCollection | null = null;
    tool.run({
      layers: [square],
      parameters: { layer: "square", iterations: 1 },
      log: () => {},
      addResultLayer: (_n, g) => {
        out = g;
      },
    });
    assert.ok(out);
    const ring = (out!.features[0].geometry as { coordinates: number[][][] }).coordinates[0];
    // One Chaikin pass on a 4-vertex closed ring yields 8 cut points + the
    // closing vertex, and stays a closed ring (more vertices than the input).
    assert.equal(ring.length, 9);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.ok(out!.features[0].geometry.type === "Polygon");
    // Properties are preserved.
    assert.equal(out!.features[0].properties?.name, "s");

    // Out-of-range iterations error rather than running.
    let produced = false;
    const logs: string[] = [];
    tool.run({
      layers: [square],
      parameters: { layer: "square", iterations: 99 },
      log: (m) => logs.push(m),
      addResultLayer: () => {
        produced = true;
      },
    });
    assert.equal(produced, false);
    assert.ok(logs.some((m) => m.includes("between 1 and 10")));

    // A malformed polygon with an empty ring must not throw; the ring stays empty.
    const malformed: GeoLibreLayer = {
      ...square,
      id: "malformed",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Polygon", coordinates: [[]] },
          },
        ],
      },
    };
    let malformedOut: FeatureCollection | null = null;
    assert.doesNotThrow(() =>
      tool.run({
        layers: [malformed],
        parameters: { layer: "malformed", iterations: 2 },
        log: () => {},
        addResultLayer: (_n, g) => {
          malformedOut = g;
        },
      }),
    );
    assert.ok(malformedOut);
    assert.deepEqual(
      (malformedOut!.features[0].geometry as { coordinates: number[][][] }).coordinates,
      [[]],
    );

    // Z/elevation is interpolated through smoothing, not dropped.
    const line3d: GeoLibreLayer = {
      ...square,
      id: "line3d",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [0, 0, 100],
                [0, 10, 200],
              ],
            },
          },
        ],
      },
    };
    let line3dOut: FeatureCollection | null = null;
    tool.run({
      layers: [line3d],
      parameters: { layer: "line3d", iterations: 1 },
      log: () => {},
      addResultLayer: (_n, g) => {
        line3dOut = g;
      },
    });
    const coords3d = (line3dOut!.features[0].geometry as { coordinates: number[][] }).coordinates;
    // Endpoints kept; the 1/4 cut point interpolates Z: 100*0.75 + 200*0.25 = 125.
    assert.ok(coords3d.every((c) => c.length === 3));
    assert.deepEqual(coords3d[1], [0, 2.5, 125]);

    // The feature id is preserved through smoothing.
    const withId: GeoLibreLayer = {
      ...square,
      id: "withId",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "abc",
            properties: {},
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
    let idOut: FeatureCollection | null = null;
    tool.run({
      layers: [withId],
      parameters: { layer: "withId", iterations: 1 },
      log: () => {},
      addResultLayer: (_n, g) => {
        idOut = g;
      },
    });
    assert.equal(idOut!.features[0].id, "abc");
  });

  it("generates a regular grid from a bounding box", () => {
    const tool = getVectorTool("grid");
    assert.ok(tool);
    const run = (parameters: Record<string, unknown>): FeatureCollection => {
      let out: FeatureCollection = { type: "FeatureCollection", features: [] };
      tool.run({
        layers: [],
        parameters: { source: "bbox", ...parameters },
        log: () => {},
        addResultLayer: (_n, g) => {
          out = g;
        },
      });
      return out;
    };
    // A 10x10 box with 5-degree cells is a 2x2 grid of rectangles.
    const grid = run({
      west: 0,
      south: 0,
      east: 10,
      north: 10,
      cell_width: 5,
    });
    assert.equal(grid.features.length, 4);
    assert.ok(grid.features.every((f) => f.geometry.type === "Polygon"));

    // Point cells emit one centroid per cell.
    const points = run({
      west: 0,
      south: 0,
      east: 10,
      north: 10,
      cell_width: 5,
      cell_type: "point",
    });
    assert.equal(points.features.length, 4);
    assert.ok(points.features.every((f) => f.geometry.type === "Point"));

    // A degenerate box (west >= east) errors rather than producing cells.
    let produced = false;
    const logs: string[] = [];
    tool.run({
      layers: [],
      parameters: {
        source: "bbox",
        west: 10,
        south: 0,
        east: 0,
        north: 10,
        cell_width: 5,
      },
      log: (m) => logs.push(m),
      addResultLayer: () => {
        produced = true;
      },
    });
    assert.equal(produced, false);
    assert.ok(logs.some((m) => m.includes("west < east")));

    // A zero-area layer extent (single point) errors rather than logging a
    // 0-cell grid.
    const pointLayer: GeoLibreLayer = {
      ...layer,
      id: "onept",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [5, 5] },
          },
        ],
      },
    };
    let layerProduced = false;
    const layerLogs: string[] = [];
    tool.run({
      layers: [pointLayer],
      parameters: { source: "layer", layer: "onept", cell_width: 1 },
      log: (m) => layerLogs.push(m),
      addResultLayer: () => {
        layerProduced = true;
      },
    });
    assert.equal(layerProduced, false);
    assert.ok(layerLogs.some((m) => m.includes("extent is empty")));
  });

  it("builds Voronoi cells and Delaunay triangles from points", () => {
    const tool = getVectorTool("voronoi");
    assert.ok(tool);
    const pt = (x: number, y: number) => ({
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Point" as const, coordinates: [x, y] },
    });
    const points: GeoLibreLayer = {
      ...layer,
      id: "pts",
      name: "Points",
      geojson: {
        type: "FeatureCollection",
        features: [pt(0, 0), pt(10, 0), pt(0, 10), pt(10, 10), pt(5, 5)],
      },
    };
    const run = (type: string): FeatureCollection => {
      let out: FeatureCollection = { type: "FeatureCollection", features: [] };
      tool.run({
        layers: [points],
        parameters: { layer: "pts", type },
        log: () => {},
        addResultLayer: (_n, g) => {
          out = g;
        },
      });
      return out;
    };
    const cells = run("voronoi");
    assert.ok(cells.features.length > 0);
    assert.ok(
      cells.features.every(
        (f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon",
      ),
    );
    const triangles = run("delaunay");
    assert.ok(triangles.features.length > 0);
    assert.ok(triangles.features.every((f) => f.geometry.type === "Polygon"));

    // Fewer than 3 points errors on both engines.
    let produced = false;
    const logs: string[] = [];
    tool.run({
      layers: [
        {
          ...points,
          id: "two",
          geojson: {
            type: "FeatureCollection",
            features: [pt(0, 0), pt(1, 1)],
          },
        },
      ],
      parameters: { layer: "two", type: "voronoi" },
      log: (m) => logs.push(m),
      addResultLayer: () => {
        produced = true;
      },
    });
    assert.equal(produced, false);
    assert.ok(logs.some((m) => m.includes("at least 3 points")));

    // Collinear points (zero-area bbox) error rather than producing a degenerate
    // or empty result.
    let collinearProduced = false;
    const collinearLogs: string[] = [];
    tool.run({
      layers: [
        {
          ...points,
          id: "collinear",
          geojson: {
            type: "FeatureCollection",
            features: [pt(0, 0), pt(0, 5), pt(0, 10)],
          },
        },
      ],
      parameters: { layer: "collinear", type: "voronoi" },
      log: (m) => collinearLogs.push(m),
      addResultLayer: () => {
        collinearProduced = true;
      },
    });
    assert.equal(collinearProduced, false);
    assert.ok(collinearLogs.some((m) => m.includes("collinear")));

    // The guard runs before the diagram-type branch, so Delaunay rejects the
    // same axis-aligned input...
    const runCollinear = (type: string, feats: typeof points.geojson.features): string[] => {
      const out: string[] = [];
      let made = false;
      tool.run({
        layers: [
          {
            ...points,
            id: "col",
            geojson: { type: "FeatureCollection", features: feats },
          },
        ],
        parameters: { layer: "col", type },
        log: (m) => out.push(m),
        addResultLayer: () => {
          made = true;
        },
      });
      assert.equal(made, false);
      return out;
    };
    assert.ok(
      runCollinear("delaunay", [pt(0, 0), pt(0, 5), pt(0, 10)]).some((m) =>
        m.includes("collinear"),
      ),
    );
    // ...and diagonally collinear points (non-zero-area bbox) are caught by the
    // empty-result guard rather than silently producing nothing.
    assert.ok(
      runCollinear("delaunay", [pt(0, 0), pt(1, 1), pt(2, 2)]).some((m) => m.includes("collinear")),
    );
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
