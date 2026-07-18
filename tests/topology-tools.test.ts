import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { DuckDbCapability, ProcessingContext } from "../packages/processing/src/types";
import {
  IDX_PROPERTY,
  TOPOLOGY_RULES,
  buildValiditySql,
  checkTopologyRulesTool,
  checkValidityTool,
  firstCoordinate,
  fixGeometriesTool,
  isUsableGeometry,
  selectedRuleIds,
  selectedFixableRuleIds,
  fixTopologyTool,
  setTopologyWasmRunner,
  tagFeatureIndexes,
} from "../packages/processing/src/topology-tools";

function layerOf(fc: FeatureCollection, id = "layer-1"): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: fc,
  };
}

const BOWTIE = {
  type: "Feature",
  properties: { name: "bowtie" },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [2, 2],
        [2, 0],
        [0, 2],
        [0, 0],
      ],
    ],
  },
} as const;

const SQUARE = {
  type: "Feature",
  properties: { name: "square" },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [10, 0],
        [14, 0],
        [14, 4],
        [10, 4],
        [10, 0],
      ],
    ],
  },
} as const;

function fcOf(...features: unknown[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features as FeatureCollection["features"],
  };
}

/** Fake DuckDB capability returning canned validity rows. */
function fakeDuckDb(rows: Record<string, unknown>[]): DuckDbCapability & {
  queries: string[];
  registered: FeatureCollection[];
  released: number;
} {
  const state = {
    queries: [] as string[],
    registered: [] as FeatureCollection[],
    released: 0,
  };
  return {
    ...state,
    ensureExtensions: async () => {},
    async registerGeoJson(geojson: FeatureCollection) {
      state.registered.push(geojson);
      return {
        sql: "ST_Read('fake.geojson')",
        release: async () => {
          state.released += 1;
        },
      };
    },
    async query(sql: string) {
      state.queries.push(sql);
      return rows;
    },
    get queries() {
      return state.queries;
    },
    get registered() {
      return state.registered;
    },
    get released() {
      return state.released;
    },
  };
}

function makeCtx(
  fc: FeatureCollection,
  parameters: Record<string, unknown>,
  duckdb?: DuckDbCapability,
): {
  ctx: ProcessingContext;
  logs: string[];
  added: { name: string; fc: FeatureCollection }[];
} {
  const logs: string[] = [];
  const added: { name: string; fc: FeatureCollection }[] = [];
  const ctx: ProcessingContext = {
    layers: [layerOf(fc)],
    parameters: { layer: "layer-1", ...parameters },
    log: (message) => logs.push(message),
    addResultLayer: (name, result) => added.push({ name, fc: result }),
    duckdb,
  };
  return { ctx, logs, added };
}

describe("topology helper functions", () => {
  it("finds the first coordinate of nested geometries", () => {
    assert.deepEqual(firstCoordinate({ type: "Point", coordinates: [1, 2] }), [1, 2]);
    assert.deepEqual(firstCoordinate(BOWTIE.geometry), [0, 0]);
    assert.deepEqual(
      firstCoordinate({
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [5, 6] }],
      }),
      [5, 6],
    );
    assert.equal(firstCoordinate(null), null);
    assert.equal(firstCoordinate({ type: "GeometryCollection", geometries: [] }), null);
  });

  it("tags each feature with its index without mutating the input", () => {
    const fc = fcOf(BOWTIE, SQUARE);
    const tagged = tagFeatureIndexes(fc);
    assert.equal(tagged.features[0].properties?.[IDX_PROPERTY], 0);
    assert.equal(tagged.features[1].properties?.[IDX_PROPERTY], 1);
    assert.equal(tagged.features[1].properties?.name, "square");
    assert.equal(fc.features[0].properties && IDX_PROPERTY in fc.features[0].properties, false);
  });

  it("builds the validity SQL with and without repair", () => {
    const check = buildValiditySql("ST_Read('x')", false);
    assert.match(check, /ST_IsValid\(geom\)/);
    assert.match(check, /NULL AS fixed/);
    assert.match(check, /WHERE geom IS NOT NULL/);
    const fix = buildValiditySql("ST_Read('x')", true);
    assert.match(fix, /ST_MakeValid\(geom\)/);
    assert.match(fix, /ST_AsGeoJSON/);
  });

  it("treats empty geometry as unusable", () => {
    assert.equal(isUsableGeometry(null), false);
    assert.equal(isUsableGeometry({ type: "Polygon", coordinates: [] }), false);
    assert.equal(isUsableGeometry({ type: "GeometryCollection", geometries: [] }), false);
    // Nested-empty shapes must count as empty, matching Shapely's is_empty.
    assert.equal(isUsableGeometry({ type: "Polygon", coordinates: [[]] }), false);
    assert.equal(isUsableGeometry({ type: "MultiPolygon", coordinates: [[[]]] }), false);
    assert.equal(isUsableGeometry(BOWTIE.geometry), true);
  });

  it("selects rules from boolean params, honoring defaults", () => {
    const defaults = selectedRuleIds({});
    assert.deepEqual(defaults, [
      "line_must_not_self_intersect",
      "polygon_must_not_overlap",
      "polygon_must_not_have_gaps",
    ]);
    const custom = selectedRuleIds({
      ruleSelfIntersect: false,
      ruleOverlap: false,
      ruleGaps: false,
      ruleDangles: true,
    });
    assert.deepEqual(custom, ["line_must_not_have_dangles"]);
    // Every rule id maps to a distinct param id.
    assert.equal(new Set(TOPOLOGY_RULES.map((rule) => rule.paramId)).size, TOPOLOGY_RULES.length);
  });
});

describe("check-validity (fake DuckDB)", () => {
  it("adds a marker layer anchored at the invalid feature", async () => {
    const duckdb = fakeDuckDb([
      { idx: 0, valid: false, fixed: null },
      { idx: 1, valid: true, fixed: null },
    ]);
    const { ctx, logs, added } = makeCtx(fcOf(BOWTIE, SQUARE), {}, duckdb);
    await checkValidityTool.run(ctx);
    assert.equal(added.length, 1);
    assert.equal(added[0].name, "Validity errors");
    const marker = added[0].fc.features[0];
    assert.equal(marker.properties?.feature_index, 0);
    assert.deepEqual(marker.geometry, { type: "Point", coordinates: [0, 0] });
    assert.match(logs.join("\n"), /Checked 2 feature\(s\): 1 invalid/);
    // Input features were index-tagged for the query, then released.
    assert.equal(duckdb.registered[0].features[0].properties?.[IDX_PROPERTY], 0);
    assert.equal(duckdb.released, 1);
  });

  it("adds no layer when everything is valid", async () => {
    const duckdb = fakeDuckDb([{ idx: 0, valid: true, fixed: null }]);
    const { ctx, logs, added } = makeCtx(fcOf(SQUARE), {}, duckdb);
    await checkValidityTool.run(ctx);
    assert.equal(added.length, 0);
    assert.match(logs.join("\n"), /No invalid geometries found/);
  });

  it("counts null and empty geometry as missing, like the sidecar", async () => {
    const noGeom = { type: "Feature", properties: {}, geometry: null };
    const emptyGeom = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [] },
    };
    const duckdb = fakeDuckDb([{ idx: 0, valid: true, fixed: null }]);
    const { ctx, logs } = makeCtx(fcOf(SQUARE, noGeom, emptyGeom), {}, duckdb);
    await checkValidityTool.run(ctx);
    assert.match(logs.join("\n"), /Checked 1 feature\(s\): 0 invalid, 2 without geometry/);
  });

  it("fails clearly without a DuckDB capability", async () => {
    const { ctx } = makeCtx(fcOf(SQUARE), {});
    await assert.rejects(async () => checkValidityTool.run(ctx), /DuckDB-WASM/);
  });
});

describe("fix-geometries (fake DuckDB)", () => {
  const FIXED = JSON.stringify({
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [0, 2],
          [1, 1],
          [0, 0],
          [0, 2],
        ],
      ],
      [
        [
          [2, 0],
          [1, 1],
          [2, 2],
          [2, 0],
        ],
      ],
    ],
  });

  it("replaces only invalid geometries and keeps properties", async () => {
    const duckdb = fakeDuckDb([
      { idx: 0, valid: false, fixed: FIXED },
      { idx: 1, valid: true, fixed: null },
    ]);
    const { ctx, logs, added } = makeCtx(fcOf(BOWTIE, SQUARE), {}, duckdb);
    await fixGeometriesTool.run(ctx);
    assert.equal(added.length, 1);
    assert.equal(added[0].name, "Fixed geometries");
    const [fixed, untouched] = added[0].fc.features;
    assert.equal(fixed.geometry?.type, "MultiPolygon");
    assert.equal(fixed.properties?.name, "bowtie");
    assert.deepEqual(untouched.geometry, SQUARE.geometry);
    assert.match(logs.join("\n"), /Fixed 1 invalid geometry/);
  });

  it("adds no layer when everything is already valid", async () => {
    const duckdb = fakeDuckDb([{ idx: 0, valid: true, fixed: null }]);
    const { ctx, logs, added } = makeCtx(fcOf(SQUARE), {}, duckdb);
    await fixGeometriesTool.run(ctx);
    assert.equal(added.length, 0);
    assert.match(logs.join("\n"), /already valid/);
  });

  it("keeps the original geometry when the repair is empty", async () => {
    const duckdb = fakeDuckDb([
      {
        idx: 0,
        valid: false,
        fixed: JSON.stringify({ type: "Polygon", coordinates: [] }),
      },
    ]);
    const { ctx, logs, added } = makeCtx(fcOf(BOWTIE), {}, duckdb);
    await fixGeometriesTool.run(ctx);
    assert.equal(added.length, 1);
    assert.deepEqual(added[0].fc.features[0].geometry, BOWTIE.geometry);
    assert.match(logs.join("\n"), /could not be repaired/);
  });
});

describe("check-topology-rules (real geolibre-wasm)", () => {
  before(async () => {
    // The default lazy import resolves the .wasm by URL, which requires a
    // bundler; in Node we initialize the module from bytes and inject it.
    const require = createRequire(import.meta.url);
    const toolsPath = require.resolve("geolibre-wasm/tools");
    const wasmPath = path.join(path.dirname(toolsPath), "geolibre-cli.wasm");
    const wasm = (await import("geolibre-wasm/tools")) as unknown as {
      initTools: (source: unknown) => Promise<unknown>;
      runTool: Parameters<typeof setTopologyWasmRunner>[0];
    };
    await wasm.initTools(readFileSync(wasmPath));
    setTopologyWasmRunner(wasm.runTool);
  });

  after(() => setTopologyWasmRunner(null));

  it("finds overlapping polygons and adds a violations layer", async () => {
    const overlapping = {
      type: "Feature",
      properties: { name: "overlaps-square" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [12, 2],
            [16, 2],
            [16, 6],
            [12, 6],
            [12, 2],
          ],
        ],
      },
    };
    const { ctx, logs, added } = makeCtx(fcOf(SQUARE, overlapping), {});
    await checkTopologyRulesTool.run(ctx);
    assert.equal(added.length, 1);
    assert.equal(added[0].name, "Topology violations");
    // One violation per overlapping feature, anchored as points.
    assert.equal(added[0].fc.features.length, 2);
    for (const violation of added[0].fc.features) {
      assert.equal(violation.geometry?.type, "Point");
      assert.equal(violation.properties?.RULE_TYPE, "polygon_must_not_overlap");
      assert.equal(typeof violation.properties?.DETAIL, "string");
    }
    assert.match(logs.join("\n"), /2 violation\(s\)/);
    assert.match(logs.join("\n"), /polygon_must_not_overlap: 2/);
  });

  it("finds dangles and self-intersections in line layers", async () => {
    const selfCrossing = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [4, 4],
          [4, 0],
          [0, 4],
        ],
      },
    };
    const { ctx, added } = makeCtx(fcOf(selfCrossing), {
      ruleOverlap: false,
      ruleGaps: false,
      ruleDangles: true,
    });
    await checkTopologyRulesTool.run(ctx);
    assert.equal(added.length, 1);
    const rules = new Set(added[0].fc.features.map((f) => f.properties?.RULE_TYPE));
    assert.ok(rules.has("line_must_not_self_intersect"));
    assert.ok(rules.has("line_must_not_have_dangles"));
  });

  it("reports no violations for a clean layer without adding one", async () => {
    const { ctx, logs, added } = makeCtx(fcOf(SQUARE), {});
    await checkTopologyRulesTool.run(ctx);
    assert.equal(added.length, 0);
    assert.match(logs.join("\n"), /No topology violations found/);
  });

  it("requires at least one rule", async () => {
    const { ctx, logs, added } = makeCtx(fcOf(SQUARE), {
      ruleSelfIntersect: false,
      ruleOverlap: false,
      ruleGaps: false,
    });
    await checkTopologyRulesTool.run(ctx);
    assert.equal(added.length, 0);
    assert.match(logs.join("\n"), /enable at least one topology rule/);
  });

  it("surfaces a tool failure as an error log", async () => {
    setTopologyWasmRunner(async () => ({
      exitCode: 1,
      stdout: ["boom"],
      files: {},
    }));
    try {
      const { ctx, logs, added } = makeCtx(fcOf(SQUARE), {});
      await checkTopologyRulesTool.run(ctx);
      assert.equal(added.length, 0);
      assert.match(logs.join("\n"), /topology check failed — boom/);
    } finally {
      // Restore the real runner for any later test in this describe block.
      const wasm = (await import("geolibre-wasm/tools")) as unknown as {
        runTool: Parameters<typeof setTopologyWasmRunner>[0];
      };
      setTopologyWasmRunner(wasm.runTool);
    }
  });
});

describe("fix-topology (real geolibre-wasm)", () => {
  before(async () => {
    const require = createRequire(import.meta.url);
    const toolsPath = require.resolve("geolibre-wasm/tools");
    const wasmPath = path.join(path.dirname(toolsPath), "geolibre-cli.wasm");
    const wasm = (await import("geolibre-wasm/tools")) as unknown as {
      initTools: (source: unknown) => Promise<unknown>;
      runTool: Parameters<typeof setTopologyWasmRunner>[0];
    };
    await wasm.initTools(readFileSync(wasmPath));
    setTopologyWasmRunner(wasm.runTool);
  });

  after(() => setTopologyWasmRunner(null));

  const NEAR_MISS = fcOf(
    {
      type: "Feature",
      properties: { name: "main" },
      geometry: {
        type: "LineString",
        coordinates: [
          [12, 10],
          [15, 10],
          [15, 14],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "nearmiss" },
      geometry: {
        type: "LineString",
        coordinates: [
          [10, 10],
          [12, 10.0001],
        ],
      },
    },
  );

  it("snaps a cross-feature endpoint near-miss and adds the fixed layer", async () => {
    const { ctx, logs, added } = makeCtx(NEAR_MISS, {
      snapTolerance: 0.001,
      ruleDangles: false,
    });
    await fixTopologyTool.run(ctx);
    assert.equal(added.length, 1);
    assert.equal(added[0].name, "Fixed topology");
    const fixedEnd = (added[0].fc.features[1].geometry as { coordinates: number[][] })
      .coordinates[1];
    assert.deepEqual(fixedEnd, [12, 10]);
    assert.match(logs.join("\n"), /Applied 1 fix/);
  });

  it("previews without adding a layer when dry run is on", async () => {
    const { ctx, logs, added } = makeCtx(NEAR_MISS, {
      snapTolerance: 0.001,
      ruleDangles: false,
      dryRun: true,
    });
    await fixTopologyTool.run(ctx);
    assert.equal(added.length, 0);
    assert.match(logs.join("\n"), /Would apply 1 fix/);
  });

  it("projects a dangling spur end onto its line", async () => {
    const spur = fcOf(
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [5, 0],
          ],
        },
      },
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [5, 0],
            [5, 5],
          ],
        },
      },
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [2, 0],
            [2.003, 0.003],
          ],
        },
      },
    );
    const { ctx, added } = makeCtx(spur, {
      snapTolerance: 0.01,
      ruleEndpointSnap: false,
    });
    await fixTopologyTool.run(ctx);
    assert.equal(added.length, 1);
    const spurEnd = (added[0].fc.features[2].geometry as { coordinates: number[][] })
      .coordinates[1];
    assert.ok(Math.abs(spurEnd[1]) < 1e-9, `spur end not projected: ${spurEnd}`);
  });

  it("reports zero fixes without adding a layer on clean data", async () => {
    const clean = fcOf(
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [5, 0],
          ],
        },
      },
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [5, 0],
            [5, 5],
          ],
        },
      },
    );
    const { ctx, logs, added } = makeCtx(clean, { snapTolerance: 0.001 });
    await fixTopologyTool.run(ctx);
    assert.equal(added.length, 0);
    assert.match(logs.join("\n"), /Applied 0 fix|No fixable violations/);
  });

  it("surfaces a tool failure as an error log", async () => {
    setTopologyWasmRunner(async () => ({
      exitCode: 1,
      stdout: ["boom"],
      files: {},
    }));
    try {
      const { ctx, logs, added } = makeCtx(NEAR_MISS, { snapTolerance: 0.001 });
      await fixTopologyTool.run(ctx);
      assert.equal(added.length, 0);
      assert.match(logs.join("\n"), /topology fix failed — boom/);
    } finally {
      const wasm = (await import("geolibre-wasm/tools")) as unknown as {
        runTool: Parameters<typeof setTopologyWasmRunner>[0];
      };
      setTopologyWasmRunner(wasm.runTool);
    }
  });

  it("still adds the fixed layer when the change report is unreadable", async () => {
    // exitCode 0 with a repaired output but no changes.json must not be
    // mistaken for "no fixable violations".
    const fixed = JSON.stringify(
      fcOf({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      }),
    );
    setTopologyWasmRunner(async () => ({
      exitCode: 0,
      stdout: [],
      files: { "fixed.geojson": new TextEncoder().encode(fixed) },
    }));
    try {
      const { ctx, logs, added } = makeCtx(NEAR_MISS, { snapTolerance: 0.001 });
      await fixTopologyTool.run(ctx);
      assert.equal(added.length, 1);
      assert.equal(added[0].name, "Fixed topology");
      assert.match(logs.join("\n"), /change report could not be read/);
    } finally {
      const wasm = (await import("geolibre-wasm/tools")) as unknown as {
        runTool: Parameters<typeof setTopologyWasmRunner>[0];
      };
      setTopologyWasmRunner(wasm.runTool);
    }
  });

  it("requires at least one fixable rule", async () => {
    const { ctx, logs, added } = makeCtx(NEAR_MISS, {
      ruleEndpointSnap: false,
      ruleDangles: false,
      rulePointCovered: false,
    });
    await fixTopologyTool.run(ctx);
    assert.equal(added.length, 0);
    assert.match(logs.join("\n"), /enable at least one fixable topology rule/);
  });

  it("selects fixable rules from params with sane defaults", () => {
    assert.deepEqual(selectedFixableRuleIds({}), [
      "line_endpoints_must_snap_within_tolerance",
      "line_must_not_have_dangles",
    ]);
    assert.deepEqual(
      selectedFixableRuleIds({
        ruleEndpointSnap: false,
        ruleDangles: false,
        rulePointCovered: true,
      }),
      ["point_must_be_covered_by_line"],
    );
  });
});
