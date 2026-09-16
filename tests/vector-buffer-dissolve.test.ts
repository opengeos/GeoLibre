import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { getVectorTool, runAlgorithmCapture } from "@geolibre/processing";
import { booleanParam } from "../packages/processing/src/vector-tools";
import type { Feature, FeatureCollection } from "geojson";

/**
 * Client-engine coverage for the Buffer tool's `dissolve` parameter.
 *
 * The shared golden fixtures in `tests/fixtures/vector/cases` already assert
 * what BOTH engines agree on (overlapping buffers merge into one attribute-less
 * polygon, disjoint ones into one multipolygon, a non-boolean flag is
 * rejected). What they cannot assert is the client engine's log lines, the
 * single-feature path around turf's two-geometry minimum, and the parameter
 * shapes that never survive a JSON fixture. Those live here.
 */

/** Two points close enough that 5 km buffers overlap. */
const NEIGHBORS: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Raleigh", pop: 480 },
      geometry: { type: "Point", coordinates: [-78.0, 35.0] },
    },
    {
      type: "Feature",
      properties: { name: "Cary", pop: 180 },
      geometry: { type: "Point", coordinates: [-77.97, 35.0] },
    },
  ],
};

/** Two points far enough apart that 5 km buffers never touch. */
const DISTANT: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    NEIGHBORS.features[0],
    {
      type: "Feature",
      properties: { name: "Charlotte" },
      geometry: { type: "Point", coordinates: [-80.8, 35.2] },
    },
  ],
};

const SINGLE: FeatureCollection = {
  type: "FeatureCollection",
  features: [NEIGHBORS.features[0]],
};

function makeLayer(geojson: FeatureCollection): GeoLibreLayer {
  return {
    id: "input",
    name: "input",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson,
  };
}

async function runBuffer(
  geojson: FeatureCollection,
  parameters: Record<string, unknown>,
): Promise<{ output: FeatureCollection | null; logs: string[] }> {
  const tool = getVectorTool("buffer");
  assert.ok(tool, "buffer tool is registered");
  const logs: string[] = [];
  const output = await runAlgorithmCapture(
    tool,
    { layer: "input", ...parameters },
    { layers: [makeLayer(geojson)], log: (m) => logs.push(m) },
  );
  return { output, logs };
}

describe("buffer dissolve (client engine)", () => {
  it("merges overlapping buffers into a single polygon", async () => {
    const { output, logs } = await runBuffer(NEIGHBORS, {
      distance: 5,
      units: "kilometers",
      dissolve: true,
    });
    assert.equal(output?.features.length, 1);
    assert.equal(output?.features[0]?.geometry.type, "Polygon");
    assert.ok(
      logs.some((m) => m === "Dissolved 2 buffer(s) into 1 feature"),
      `expected a dissolved log line, got ${JSON.stringify(logs)}`,
    );
  });

  it("reports the pre-dissolve count on the Buffered line", async () => {
    // The two counts answer different questions — how many features were
    // buffered, and what the dissolve left — so the first must not collapse to
    // 1. The Python engine builds the same pair of messages.
    const { logs } = await runBuffer(NEIGHBORS, {
      distance: 5,
      units: "kilometers",
      dissolve: true,
    });
    assert.deepEqual(logs, [
      "Buffered 2 feature(s) by 5 kilometers (outside)",
      "Dissolved 2 buffer(s) into 1 feature",
    ]);
  });

  it("drops the attributes of the merged feature", async () => {
    // The merged ring belongs to no single input feature, so carrying the first
    // one's attributes through would label the whole union "Raleigh".
    // GeoPandas' `union_all` drops them the same way.
    const { output } = await runBuffer(NEIGHBORS, {
      distance: 5,
      units: "kilometers",
      dissolve: true,
    });
    assert.deepEqual(output?.features[0]?.properties, {});
  });

  it("keeps disjoint buffers as one multipolygon", async () => {
    const { output } = await runBuffer(DISTANT, {
      distance: 5,
      units: "kilometers",
      dissolve: true,
    });
    assert.equal(output?.features.length, 1);
    const geometry = output?.features[0]?.geometry;
    assert.equal(geometry?.type, "MultiPolygon");
    assert.equal(
      (geometry as { coordinates: unknown[] }).coordinates.length,
      2,
      "both buffers survive as parts of the single dissolved feature",
    );
  });

  it("dissolves a lone buffer without asking turf to union one geometry", async () => {
    // `union` throws "Must have at least 2 geometries", so a one-feature layer
    // would fail the whole run if it took the union path. One buffer is already
    // its own dissolve.
    const { output, logs } = await runBuffer(SINGLE, {
      distance: 5,
      units: "kilometers",
      dissolve: true,
    });
    assert.equal(output?.features.length, 1);
    assert.equal(output?.features[0]?.geometry.type, "Polygon");
    assert.deepEqual(output?.features[0]?.properties, {});
    assert.ok(
      logs.some((m) => m === "Dissolved 1 buffer(s) into 1 feature"),
      `expected a dissolved log line, got ${JSON.stringify(logs)}`,
    );
  });

  it("dissolves the band a both-sides buffer produces", async () => {
    const squares: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "block" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-78.5, 34.5],
                [-77.5, 34.5],
                [-77.5, 35.5],
                [-78.5, 35.5],
                [-78.5, 34.5],
              ],
            ],
          },
        },
      ],
    };
    const { output } = await runBuffer(squares, {
      distance: 10,
      units: "kilometers",
      side: "both",
      dissolve: true,
    });
    assert.equal(output?.features.length, 1);
    assert.equal(
      (output?.features[0]?.geometry as { coordinates: unknown[] }).coordinates.length,
      2,
      "the dissolve keeps the hole the band was cut around",
    );
  });

  it("leaves the buffers alone when dissolve is off", async () => {
    for (const dissolve of [false, null, undefined, ""] as const) {
      const parameters: Record<string, unknown> = { distance: 5, units: "kilometers" };
      if (dissolve !== undefined) parameters.dissolve = dissolve;
      const { output, logs } = await runBuffer(NEIGHBORS, parameters);
      assert.equal(output?.features.length, 2, `dissolve: ${JSON.stringify(dissolve)}`);
      assert.deepEqual(output?.features[0]?.properties, { name: "Raleigh", pop: 480 });
      assert.ok(
        logs.every((m) => !m.startsWith("Dissolved ")),
        `expected no dissolve line, got ${JSON.stringify(logs)}`,
      );
    }
  });

  it("says nothing about dissolving when the buffer left no features", async () => {
    // Nothing to merge, so the run produces the same empty layer it would
    // without the flag rather than an "Unable to dissolve" error.
    const { output, logs } = await runBuffer(SINGLE, {
      distance: 5,
      units: "kilometers",
      side: "inside",
      dissolve: true,
    });
    assert.deepEqual(output?.features, []);
    assert.ok(
      logs.every((m) => !m.startsWith("Dissolved ")),
      `expected no dissolve line, got ${JSON.stringify(logs)}`,
    );
  });

  for (const [label, dissolve] of [
    ["an unknown word", "maybe"],
    ["an array", [true]],
    ["an object", {}],
    ["NaN", Number.NaN],
  ] as [string, unknown][]) {
    it(`rejects ${label} as a dissolve flag`, async () => {
      // Each language's own truthiness reads these differently (`Boolean([])`
      // is true where `bool([])` is False), so rejecting the value is the only
      // reading both engines share.
      const { output, logs } = await runBuffer(NEIGHBORS, {
        distance: 5,
        units: "kilometers",
        dissolve,
      });
      assert.equal(output, null);
      assert.ok(
        logs.some((m) => m === "Error: buffer dissolve must be true or false"),
        `expected a dissolve error, got ${JSON.stringify(logs)}`,
      );
    });
  }

  it("reports the bad dissolve flag before the bad distance", async () => {
    // `vector_ops._buffer` validates units, then side, then dissolve, then the
    // distance, so a call with several bad parameters at once gets the same
    // *first* error from both engines.
    const { output, logs } = await runBuffer(NEIGHBORS, { distance: -5, dissolve: "maybe" });
    assert.equal(output, null);
    assert.ok(
      logs.some((m) => m === "Error: buffer dissolve must be true or false"),
      `expected the dissolve error to win, got ${JSON.stringify(logs)}`,
    );
  });

  it("reports the unknown side before the bad dissolve flag", async () => {
    const { output, logs } = await runBuffer(NEIGHBORS, {
      distance: 5,
      side: "bogus",
      dissolve: "maybe",
    });
    assert.equal(output, null);
    assert.ok(
      logs.some((m) => m.startsWith("Error: unknown buffer side 'bogus'")),
      `expected the side error to win, got ${JSON.stringify(logs)}`,
    );
  });

  it("dissolves when the flag arrives as a word rather than a boolean", async () => {
    // A checkbox that round-tripped through a query string, a CSV batch row, or
    // a replayed history entry reaches the tool as a string.
    const { output } = await runBuffer(NEIGHBORS, {
      distance: 5,
      units: "kilometers",
      dissolve: " TRUE ",
    });
    assert.equal(output?.features.length, 1);
  });
});

describe("booleanParam (shared with vector_ops._boolean_param)", () => {
  for (const [label, raw, expected] of [
    ["an absent value", undefined, false],
    ["an explicit null", null, false],
    ["true", true, true],
    ["false", false, false],
    ["a non-zero number", 1, true],
    ["zero", 0, false],
    ["a negative number", -2, true],
    ["the word true", "true", true],
    ["the word false", "false", false],
    ["a padded, upper-case word", "  On  ", true],
    ["the digit 1", "1", true],
    ["the digit 0", "0", false],
    ["yes", "yes", true],
    ["no", "no", false],
    ["an empty string", "", false],
    ["a whitespace-only string", "   ", false],
  ] as [string, unknown, boolean][]) {
    it(`reads ${label} as ${expected}`, () => {
      assert.equal(booleanParam(raw), expected);
    });
  }

  for (const [label, raw] of [
    ["an unknown word", "maybe"],
    ["a typo", "flase"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an array", []],
    ["an object", {}],
  ] as [string, unknown][]) {
    it(`refuses to guess at ${label}`, () => {
      assert.equal(booleanParam(raw), null);
    });
  }
});
