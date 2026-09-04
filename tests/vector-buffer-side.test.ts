import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { getVectorTool, runAlgorithmCapture } from "@geolibre/processing";
import { hasPositions } from "../packages/processing/src/vector-tools";
import type { Feature, FeatureCollection } from "geojson";

/**
 * Client-engine coverage for the Buffer tool's `side` parameter and its input
 * guards. The shared golden fixtures in `tests/fixtures/vector/cases` already
 * assert what BOTH engines agree on (an inward buffer shrinks, a `both` buffer
 * keeps the band, a point emptied by `inside` is dropped, an unknown side is
 * rejected). What they cannot assert is the client engine's log lines and the
 * parameter shapes that never survive a JSON fixture — a `NaN` distance, a
 * whitespace-only string, a feature with a null geometry. Those live here.
 */

const SQUARE: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "block", region: "east" },
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

const POINT: Feature = {
  type: "Feature",
  properties: { name: "Raleigh" },
  geometry: { type: "Point", coordinates: [-78.0, 35.0] },
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

describe("buffer tool (client engine)", () => {
  it("reports the side it buffered on", async () => {
    const { output, logs } = await runBuffer(SQUARE, {
      distance: 10,
      units: "kilometers",
      side: "inside",
    });
    assert.equal(output?.features.length, 1);
    assert.ok(
      logs.some((m) => m === "Buffered 1 feature(s) by 10 kilometers (inside)"),
      `expected an inside log line, got ${JSON.stringify(logs)}`,
    );
  });

  it("cuts a hole in the band when side is both", async () => {
    const { output } = await runBuffer(SQUARE, {
      distance: 10,
      units: "kilometers",
      side: "both",
    });
    const geometry = output?.features[0]?.geometry;
    assert.equal(geometry?.type, "Polygon");
    assert.equal(
      (geometry as { coordinates: unknown[] }).coordinates.length,
      2,
      "the band keeps an outer ring plus the hole where the interior used to be",
    );
    // turf's difference carries the first input's properties through, and that
    // input is our own intermediate buffer — the source attributes must survive.
    assert.deepEqual(output?.features[0]?.properties, { name: "block", region: "east" });
  });

  it("returns the grown shape whole for both on a feature with no interior", async () => {
    // A point and a line have nothing to erode, so the eroded shape is empty and
    // the band across the boundary IS the grown shape. Keep it rather than
    // treating the empty inner ring as a failure — the same fallback a polygon
    // thinner than twice the radius takes. `buffer-point-line-both.json` pins
    // the counts and attributes across both engines; what it cannot assert is
    // that the result is solid, so that is checked here.
    const points: FeatureCollection = {
      type: "FeatureCollection",
      features: [POINT],
    };
    const { output, logs } = await runBuffer(points, {
      distance: 5,
      units: "kilometers",
      side: "both",
    });
    assert.equal(output?.features.length, 1);
    const geometry = output?.features[0]?.geometry;
    assert.equal(geometry?.type, "Polygon");
    assert.equal(
      (geometry as { coordinates: unknown[] }).coordinates.length,
      1,
      "no interior was eroded, so the grown disc comes back solid rather than as a ring",
    );
    assert.ok(
      logs.every((m) => !m.startsWith("Dropped ")),
      `expected nothing dropped, got ${JSON.stringify(logs)}`,
    );
  });

  it("counts features the inward buffer empties, without failing the run", async () => {
    const mixed: FeatureCollection = {
      type: "FeatureCollection",
      features: [...SQUARE.features, POINT],
    };
    const { output, logs } = await runBuffer(mixed, {
      distance: 10,
      units: "kilometers",
      side: "inside",
    });
    assert.equal(output?.features.length, 1, "the polygon survives, the point does not");
    assert.ok(
      logs.some((m) => m === "Dropped 1 feature(s) the buffer left empty"),
      `expected a dropped log line, got ${JSON.stringify(logs)}`,
    );
  });

  it("counts a null-geometry feature as dropped, matching the Python engine", async () => {
    // The GeoPandas engine loads a null geometry into the GeoDataFrame and its
    // `isna()` filter reports it, so skipping it in silence here would make the
    // two engines disagree on the totals for the same input.
    const withNull = {
      type: "FeatureCollection",
      features: [...SQUARE.features, { type: "Feature", properties: {}, geometry: null }],
    } as unknown as FeatureCollection;
    const { output, logs } = await runBuffer(withNull, { distance: 1, units: "kilometers" });
    assert.equal(output?.features.length, 1);
    assert.ok(
      logs.some((m) => m === "Dropped 1 feature(s) the buffer left empty"),
      `expected a dropped log line, got ${JSON.stringify(logs)}`,
    );
  });

  it("rejects a negative distance rather than eroding", async () => {
    const { output, logs } = await runBuffer(SQUARE, { distance: -5, units: "kilometers" });
    assert.equal(output, null);
    assert.ok(
      logs.some((m) => m.startsWith("Error: buffer distance must be >= 0")),
      `expected a negative-distance error, got ${JSON.stringify(logs)}`,
    );
  });

  for (const [label, distance] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a whitespace-only string", "   "],
    ["an unparseable string", "ten"],
    // `Number()` reads these as 16/2/8; Python's `float()` raises on all three,
    // so the sidecar would reject a distance the client quietly buffered by.
    ["a hex string", "0x10"],
    ["a binary string", "0b10"],
    ["an octal string", "0o10"],
    // Python accepts digit separators, JavaScript does not — both engines
    // refuse this one, from opposite directions.
    ["a digit-separated string", "1_000"],
  ] as const) {
    it(`rejects ${label} as a distance instead of silently buffering by 1`, async () => {
      const { output, logs } = await runBuffer(SQUARE, { distance, units: "kilometers" });
      assert.equal(output, null);
      assert.ok(
        logs.some((m) => m === "Error: buffer distance must be a finite number"),
        `expected a finite-distance error, got ${JSON.stringify(logs)}`,
      );
    });
  }

  for (const [label, distance] of [
    ["a boolean", true],
    ["false", false],
    ["an array", [5]],
    ["an empty array", []],
    ["an object", {}],
  ] as [string, unknown][]) {
    it(`rejects ${label} as a distance`, async () => {
      // The two languages coerce these differently — `Number(false)` is 0 and
      // `Number([5])` is 5 (both discarded by `numberParam` for the fallback
      // 1), while Python's `raw or 0` reads false/[]/{} as 0 and raises on [5].
      // Rejecting the type is the only reading both engines share.
      const { output, logs } = await runBuffer(SQUARE, { distance, units: "kilometers" });
      assert.equal(output, null);
      assert.ok(
        logs.some((m) => m === "Error: buffer distance must be a finite number"),
        `expected a finite-distance error, got ${JSON.stringify(logs)}`,
      );
    });
  }

  for (const field of ["units", "side", "distance"] as const) {
    it(`reads an explicit null ${field} as the default, matching the Python engine`, async () => {
      const { logs } = await runBuffer(SQUARE, { distance: 1, [field]: null });
      assert.ok(
        logs.some((m) => m === "Buffered 1 feature(s) by 1 kilometers (outside)"),
        `expected the default buffer, got ${JSON.stringify(logs)}`,
      );
    });
  }

  it("reads an empty-string distance as zero, matching the Python engine", async () => {
    // The one non-number both engines agree on: Python's `"" or 0` is 0.
    const { output, logs } = await runBuffer(SQUARE, { distance: "", units: "kilometers" });
    assert.ok(output);
    assert.ok(
      logs.some((m) => m === "Buffered 1 feature(s) by 0 kilometers (outside)"),
      `expected a zero-distance buffer, got ${JSON.stringify(logs)}`,
    );
  });

  it("rejects an explicitly empty side rather than falling back to outside", async () => {
    // The Python engine treats an empty `side` the same way it treats an empty
    // `units` — it reaches the lookup and is rejected there.
    const { output, logs } = await runBuffer(SQUARE, { distance: 1, side: "" });
    assert.equal(output, null);
    assert.ok(
      logs.some((m) => m.startsWith("Error: unknown buffer side ''")),
      `expected an unknown-side error, got ${JSON.stringify(logs)}`,
    );
  });

  it("defaults to outside when side is absent", async () => {
    const { logs } = await runBuffer(SQUARE, { distance: 1, units: "kilometers" });
    assert.ok(
      logs.some((m) => m === "Buffered 1 feature(s) by 1 kilometers (outside)"),
      `expected an outside log line, got ${JSON.stringify(logs)}`,
    );
  });
});

describe("buffer tool validation order (client engine)", () => {
  // `vector_ops._buffer` validates units, then side, then distance finiteness,
  // then distance sign. The client mirrors that order so a call with several
  // bad parameters at once gets the same *first* error from both engines, not
  // merely the same accept/reject verdict.
  it("reports the unknown side before the negative distance", async () => {
    const { output, logs } = await runBuffer(SQUARE, { distance: -5, side: "bogus" });
    assert.equal(output, null);
    assert.ok(
      logs.some((m) => m.startsWith("Error: unknown buffer side 'bogus'")),
      `expected the side error to win, got ${JSON.stringify(logs)}`,
    );
  });

  it("reports the unknown unit before the unknown side", async () => {
    const { output, logs } = await runBuffer(SQUARE, {
      distance: 1,
      units: "furlongs",
      side: "bogus",
    });
    assert.equal(output, null);
    assert.ok(
      logs.some((m) => m.startsWith("Error: unknown unit 'furlongs'")),
      `expected the unit error to win, got ${JSON.stringify(logs)}`,
    );
  });

  it("rejects an unknown unit rather than letting the catch report an empty run", async () => {
    // turf throws on a unit it does not know. Without an up-front check the
    // per-feature try/catch turns that into "Buffered 0 feature(s) … / Skipped
    // 1 feature(s)" — a successful-looking empty layer where the Python engine
    // raises "Unknown unit".
    const { output, logs } = await runBuffer(SQUARE, { distance: 1, units: "furlongs" });
    assert.equal(output, null);
    assert.ok(
      logs.every((m) => !m.startsWith("Buffered ")),
      `expected no success line, got ${JSON.stringify(logs)}`,
    );
  });

  it("rejects an explicitly empty unit, matching the Python engine", async () => {
    const { output, logs } = await runBuffer(SQUARE, { distance: 1, units: "" });
    assert.equal(output, null);
    assert.ok(
      logs.some((m) => m.startsWith("Error: unknown unit ''")),
      `expected an unknown-unit error, got ${JSON.stringify(logs)}`,
    );
  });
});

describe("buffer empty-geometry detection (client engine)", () => {
  // `nonEmptyBuffer` drops a geometry jsts emptied. Zero rings is the usual
  // shape, but a single empty ring and a MultiPolygon of individually
  // degenerate parts both have a non-zero `coordinates.length` while still
  // being undrawable, so a plain length check would let them through.
  for (const [label, coordinates] of [
    ["zero rings", []],
    ["one empty ring", [[]]],
    ["several empty rings", [[], []]],
    ["a multipolygon of empty parts", [[[]], [[]]]],
  ] as const) {
    it(`treats ${label} as empty`, () => {
      assert.equal(hasPositions(coordinates), false);
    });
  }

  for (const [label, coordinates] of [
    [
      "a polygon ring",
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    ],
    [
      "a multipolygon part",
      [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      ],
    ],
    [
      "a ring alongside an empty one",
      [
        [],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    ],
  ] as const) {
    it(`keeps ${label}`, () => {
      assert.equal(hasPositions(coordinates), true);
    });
  }
});
