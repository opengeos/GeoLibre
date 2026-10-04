import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDggsGridTool,
  dggsBinPointsTool,
  dggsCompactTool,
  extensionForDggs,
  getDggsTool,
  maxResolutionForDggs,
} from "../packages/processing/src/dggs-tools";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { DuckDbCapability, ProcessingContext } from "../packages/processing/src/types";

function polygonLayer(): GeoLibreLayer {
  return {
    id: "poly",
    name: "Poly",
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
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    },
  };
}

function pointLayer(): GeoLibreLayer {
  return {
    ...polygonLayer(),
    id: "pts",
    name: "Pts",
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [0.5, 0.5] },
        },
      ],
    },
  };
}

function pointCollection(coords: [number, number][]): GeoLibreLayer["geojson"] {
  return {
    type: "FeatureCollection",
    features: coords.map((position) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: position },
    })),
  };
}

/** A point layer straddling the antimeridian, as Fiji's extent does. */
function fijiLayer(): GeoLibreLayer {
  return {
    ...pointLayer(),
    id: "fiji",
    name: "Fiji",
    geojson: pointCollection([
      [177.5, -18],
      [-179.5, -16],
    ]),
  };
}

/** A polygon layer straddling the antimeridian with vertices between the edges. */
function fijiPolygonLayer(): GeoLibreLayer {
  return {
    ...pointLayer(),
    id: "fiji-polygon",
    name: "Fiji polygon",
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [177.2, -17.0],
                [178.5, -16.4],
                [179.9, -17.2],
                [180, -18.5],
                [-180, -18.9],
                [-179.4, -17.2],
                [-178.0, -16.8],
                [177.2, -17.0],
              ],
            ],
          },
        },
      ],
    },
  };
}

function mockDuckDb(): DuckDbCapability & {
  queries: string[];
  released: number[];
  extensions: string[][];
} {
  const queries: string[] = [];
  const released: number[] = [];
  const extensions: string[][] = [];
  return {
    queries,
    released,
    extensions,
    ensureExtensions: async (names) => {
      extensions.push([...names]);
    },
    registerGeoJson: async () => ({
      sql: "ST_Read('mock.geojson')",
      release: async () => {
        released.push(1);
      },
    }),
    query: async (sql: string) => {
      queries.push(sql);
      const geojson = '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}';
      if (sql.includes("a5_")) {
        return [{ a5: "1600000000000000", geojson, count: 1 }];
      }
      if (sql.includes("geo_to_seqnum") || sql.includes("seqnum_to_boundary")) {
        return [{ dggrid: "2380", geojson, count: 1 }];
      }
      return [{ h3: "8928308280fffff", geojson, count: 1 }];
    },
  };
}

function baseCtx(
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
): {
  ctx: ProcessingContext;
  logs: string[];
  added: string[];
  duckdb: ReturnType<typeof mockDuckDb>;
} {
  const logs: string[] = [];
  const added: string[] = [];
  const duckdb = mockDuckDb();
  const ctx: ProcessingContext = {
    layers,
    parameters,
    log: (m) => logs.push(m),
    addResultLayer: (name) => added.push(name),
    duckdb,
    viewportBounds: () => [0, 0, 1, 1],
  };
  return { ctx, logs, added, duckdb };
}

describe("dggs generator", () => {
  it("registers under getDggsTool with DGGS group", () => {
    assert.equal(getDggsTool("dggs-grid"), createDggsGridTool);
    assert.equal(getDggsTool("dggs-bin"), dggsBinPointsTool);
    assert.equal(getDggsTool("dggs-compact"), dggsCompactTool);
    assert.equal(getDggsTool("missing"), undefined);
    assert.equal(createDggsGridTool.group, "DGGS");
    assert.equal(createDggsGridTool.name, "DGGS Generator");
    assert.equal(dggsBinPointsTool.name, "DGGS Binning");
  });

  it("exposes Fix antimeridian for H3, S2, and DGGRID only, default checked", () => {
    for (const tool of [createDggsGridTool, dggsBinPointsTool]) {
      const param = tool.parameters.find((p) => p.id === "fixAntimeridian");
      assert.ok(param);
      assert.equal(param.type, "boolean");
      assert.equal(param.default, true);
      assert.deepEqual(param.visibleWhen, {
        param: "dggsType",
        in: ["h3", "s2", "dggrid"],
      });
      assert.ok(!param.visibleWhen!.in.includes("a5"));
      assert.ok(!param.visibleWhen!.in.includes("dggal"));
    }
    const typeParam = createDggsGridTool.parameters.find((p) => p.id === "dggsType");
    assert.ok(typeParam && typeParam.type === "select");
    assert.deepEqual(
      typeParam.options?.map((o) => o.value),
      ["h3", "s2", "a5", "dggrid", "dggal"],
    );
  });

  it("exposes H3 max 15, S2/A5 max 30, and per-DGGRID/DGGAL-type maxima", () => {
    assert.equal(maxResolutionForDggs("h3"), 15);
    assert.equal(maxResolutionForDggs("s2"), 30);
    assert.equal(maxResolutionForDggs("a5"), 30);
    assert.equal(maxResolutionForDggs("dggrid"), 29);
    assert.equal(maxResolutionForDggs("dggrid", "ISEA4H"), 29);
    assert.equal(maxResolutionForDggs("dggrid", "ISEA3H"), 35);
    assert.equal(maxResolutionForDggs("dggrid", "FULLER4H"), 30);
    assert.equal(maxResolutionForDggs("dggrid", "SUPERFUND"), 17);
    assert.equal(maxResolutionForDggs("dggrid", "PLANETRISK"), 22);
    assert.equal(maxResolutionForDggs("dggrid", "IGEO7"), 20);
    assert.equal(maxResolutionForDggs("dggal"), 33);
    assert.equal(maxResolutionForDggs("dggal", "isea3h"), 33);
    assert.equal(maxResolutionForDggs("dggal", "isea4r"), 25);
    assert.equal(maxResolutionForDggs("dggal", "healpix"), 26);
    assert.equal(maxResolutionForDggs("dggal", "gnosis"), 28);
    assert.equal(extensionForDggs("dggal"), null);

    const dggalParam = createDggsGridTool.parameters.find((p) => p.id === "dggalType");
    assert.ok(dggalParam);
    assert.deepEqual(dggalParam.visibleWhen, { param: "dggsType", in: ["dggal"] });
    assert.equal(dggalParam.default, "isea3h");
  });

  it("throws a clear error when duckdb is unavailable for H3", async () => {
    await assert.rejects(
      () =>
        Promise.resolve(
          createDggsGridTool.run({
            layers: [],
            parameters: { dggsType: "h3", source: "viewport", resolution: 5 },
            log: () => {},
            viewportBounds: () => [0, 0, 1, 1],
          }),
        ),
      /requires DuckDB/,
    );
  });

  it("creates an S2 grid from the map viewport without DuckDB", async () => {
    assert.equal(extensionForDggs("s2"), null);
    const { ctx, added, duckdb, logs } = baseCtx([], {
      dggsType: "s2",
      source: "viewport",
      resolution: 4,
    });
    // S2 must not require DuckDB — clear it to prove the client path.
    ctx.duckdb = undefined;
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /S2 grid \(res 4\)/);
    assert.equal(duckdb.queries.length, 0);
    assert.ok(logs.some((l) => /Created \d+ S2 cell/.test(l)));
  });

  it("compacts an S2 viewport grid when Compact cells is checked", async () => {
    let featureCount = 0;
    const { ctx, added, duckdb } = baseCtx([], {
      dggsType: "s2",
      source: "viewport",
      resolution: 6,
      compactCells: true,
    });
    ctx.duckdb = undefined;
    ctx.addResultLayer = (name, fc) => {
      added.push(name);
      featureCount = fc.features.length;
    };
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /S2 grid \(res 6, compact\)/);
    assert.equal(duckdb.queries.length, 0);
    assert.ok(featureCount > 0);
  });

  it("creates a DGGAL grid from the map viewport without DuckDB", async () => {
    const { ctx, added, duckdb } = baseCtx([], {
      dggsType: "dggal",
      dggalType: "isea3h",
      source: "viewport",
      resolution: 3,
    });
    ctx.duckdb = undefined;
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /ISEA3H grid \(res 3\)/);
    assert.equal(duckdb.queries.length, 0);
  });

  it("compacts a DGGAL viewport grid when Compact cells is checked", async () => {
    let featureCount = 0;
    const { ctx, added, duckdb } = baseCtx([], {
      dggsType: "dggal",
      dggalType: "isea4r",
      source: "viewport",
      resolution: 5,
      compactCells: true,
    });
    ctx.duckdb = undefined;
    ctx.addResultLayer = (name, fc) => {
      added.push(name);
      featureCount = fc.features.length;
    };
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /ISEA4R grid \(res 5, compact\)/);
    assert.equal(duckdb.queries.length, 0);
    assert.ok(featureCount > 0);
  });

  it("exposes Compact cells for H3, A5, S2, and DGGAL, default off", () => {
    const param = createDggsGridTool.parameters.find((p) => p.id === "compactCells");
    assert.ok(param);
    assert.equal(param.type, "boolean");
    assert.equal(param.default, false);
    assert.deepEqual(param.visibleWhen, { param: "dggsType", in: ["h3", "a5", "s2", "dggal"] });
  });

  it("creates an H3 grid from the map viewport", async () => {
    const { ctx, added, duckdb } = baseCtx([], {
      dggsType: "h3",
      source: "viewport",
      resolution: 5,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /H3 grid \(res 5\)/);
    assert.deepEqual(duckdb.extensions[0], ["spatial", "h3"]);
    assert.match(duckdb.queries[0], /h3_polygon_wkt_to_cells_experimental/);
    assert.doesNotMatch(duckdb.queries[0], /h3_compact_cells/);
  });

  it("compacts an H3 viewport grid when Compact cells is checked", async () => {
    const { ctx, added, duckdb } = baseCtx([], {
      dggsType: "h3",
      source: "viewport",
      resolution: 5,
      compactCells: true,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /H3 grid \(res 5, compact\)/);
    assert.match(duckdb.queries[0], /h3_compact_cells\(cells\)/);
  });
  it("creates an A5 grid from the map viewport", async () => {
    const { ctx, added, duckdb } = baseCtx([], {
      dggsType: "a5",
      source: "viewport",
      resolution: 5,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /A5 grid \(res 5\)/);
    assert.deepEqual(duckdb.extensions[0], ["spatial", "a5"]);
    assert.match(duckdb.queries[0], /a5_uncompact\(a5_geometry_to_cells/);
  });

  it("creates a DGGRID grid via duck_dggs sample cover", async () => {
    assert.equal(extensionForDggs("dggrid"), "duck_dggs");
    const { ctx, added, duckdb } = baseCtx([], {
      dggsType: "dggrid",
      source: "viewport",
      resolution: 5,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /ISEA4H grid \(res 5\)/);
    assert.deepEqual(duckdb.extensions[0], ["spatial", "duck_dggs"]);
    assert.match(duckdb.queries[0], /geo_to_seqnum/);
    assert.match(duckdb.queries[0], /seqnum_to_boundary/);
    assert.match(duckdb.queries[0], /dggs_params\('ISEA', 4, 'HEXAGON'/);
  });

  it("passes the selected DGGRID type into duck_dggs params", async () => {
    const dggridTypeParam = createDggsGridTool.parameters.find((p) => p.id === "dggridType");
    assert.ok(dggridTypeParam);
    assert.deepEqual(dggridTypeParam.visibleWhen, { param: "dggsType", in: ["dggrid"] });
    assert.equal(dggridTypeParam.default, "ISEA4H");

    const { ctx, added, duckdb } = baseCtx([], {
      dggsType: "dggrid",
      dggridType: "ISEA4T",
      source: "viewport",
      resolution: 4,
    });
    await createDggsGridTool.run(ctx);
    assert.match(added[0], /ISEA4T grid \(res 4\)/);
    assert.match(duckdb.queries[0], /dggs_params\('ISEA', 4, 'TRIANGLE'/);
  });

  it("rejects DGGRID resolutions above the selected type's max", async () => {
    const overIsea4 = baseCtx([], {
      dggsType: "dggrid",
      dggridType: "ISEA4H",
      source: "viewport",
      resolution: 30,
    });
    await createDggsGridTool.run(overIsea4.ctx);
    assert.equal(overIsea4.added.length, 0);
    assert.ok(overIsea4.logs.some((l) => /0 to 29 for ISEA4H/.test(l)));

    const okIsea3 = baseCtx([], {
      dggsType: "dggrid",
      dggridType: "ISEA3H",
      source: "viewport",
      resolution: 30,
    });
    // res 30 is valid for ISEA3H but always exceeds the hard cell-count cap on a 1° viewport.
    await createDggsGridTool.run(okIsea3.ctx);
    assert.equal(okIsea3.added.length, 0);
    assert.ok(okIsea3.logs.some((l) => /cap/i.test(l)));
  });

  it("defaults dggsType to h3", async () => {
    const { ctx, duckdb } = baseCtx([], { source: "viewport", resolution: 4 });
    await createDggsGridTool.run(ctx);
    assert.deepEqual(duckdb.extensions[0], ["spatial", "h3"]);
  });

  it("rejects an antimeridian-crossing viewport", async () => {
    const { ctx, added, logs } = baseCtx([], {
      dggsType: "h3",
      source: "viewport",
      resolution: 4,
    });
    ctx.viewportBounds = () => [170, 0, -170, 1];
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /antimeridian/i.test(l)));
  });

  it("fills only the dateline strip when a layer extent crosses ±180", async () => {
    // Fiji spans 177.5E to 179.5W. Read as a plain bbox its longitude span is
    // 357°, which used to collapse to the whole globe and hand back a grid
    // wrapping the entire 357°-wide latitude band.
    const { ctx, duckdb } = baseCtx([fijiLayer()], {
      dggsType: "h3",
      source: "extent",
      layer: "fiji",
      resolution: 4,
    });
    await createDggsGridTool.run(ctx);
    // One query, both halves unioned in.
    assert.equal(duckdb.queries.length, 1);
    const sql = duckdb.queries[0]!;
    assert.match(sql, /POLYGON\(\(177\.5 -18, 180 -18, 180 -16, 177\.5 -16/);
    assert.match(sql, /POLYGON\(\(-180 -18, -179\.5 -18, -179\.5 -16, -180 -16/);
    // The old behaviour unioned two whole hemispheres; no half-world ring
    // should remain.
    assert.doesNotMatch(sql, /-180 -18, 0 -18/);
    assert.doesNotMatch(sql, /0 -18, 180 -18/);
  });

  it("splits a polygon layer whose vertices outnumber its two extremes", async () => {
    // A real coastline or EEZ ring has far more vertices than the two that
    // bound its box, so the split has to come from the whole coordinate set.
    const { ctx, duckdb } = baseCtx([fijiPolygonLayer()], {
      dggsType: "h3",
      source: "extent",
      layer: "fiji-polygon",
      resolution: 4,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(duckdb.queries.length, 1);
    const sql = duckdb.queries[0]!;
    assert.match(sql, /POLYGON\(\(177\.2 -18\.9, 180 -18\.9, 180 -16\.4/);
    assert.match(sql, /POLYGON\(\(-180 -18\.9, -178(\.0)? -18\.9/);
  });

  it("compacts a dateline split as one set, not one per half", async () => {
    // A parent cell straddling ±180 has all its children in the union but in
    // only one half, so compacting each half separately leaves the siblings
    // unfolded. The two selects must reach h3_compact_cells together.
    const { ctx, duckdb } = baseCtx([fijiLayer()], {
      dggsType: "h3",
      source: "extent",
      layer: "fiji",
      resolution: 4,
      compactCells: true,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(duckdb.queries.length, 1);
    const sql = duckdb.queries[0]!;
    assert.match(sql, /SELECT DISTINCT cell FROM \(/);
    assert.match(sql, /UNION ALL/);
    assert.match(sql, /h3_compact_cells/);
  });

  it("keeps a globally spanning layer at full longitude", async () => {
    // Same >180° bbox shape, but the 0°E station means the layer really does
    // wrap the globe, so the whole-longitude path is the correct answer.
    const layer: GeoLibreLayer = {
      ...pointLayer(),
      id: "world",
      geojson: pointCollection([
        [0, 0],
        [100, 10],
        [-100, -10],
      ]),
    };
    const { ctx, duckdb } = baseCtx([layer], {
      dggsType: "h3",
      source: "extent",
      layer: "world",
      resolution: 2,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(duckdb.queries.length, 1);
    assert.match(duckdb.queries[0], /POLYGON\(\(-180 -10, 0 -10, 0 10, -180 10/);
    assert.match(duckdb.queries[0], /POLYGON\(\(0 -10, 180 -10, 180 10, 0 10/);
  });

  it("returns each cell once for a dateline split", async () => {
    // A cell straddling ±180 belongs to both halves. The DuckDB path now gets
    // its dedupe from `SELECT DISTINCT` over the union; the S2 path merges the
    // two halves itself, so check that one here.
    const results: GeoLibreLayer["geojson"][] = [];
    const { ctx } = baseCtx([fijiLayer()], {
      dggsType: "s2",
      source: "extent",
      layer: "fiji",
      resolution: 6,
    });
    ctx.duckdb = undefined;
    ctx.addResultLayer = (_name, fc) => results.push(fc);
    await createDggsGridTool.run(ctx);
    assert.equal(results.length, 1);
    const ids = results[0]!.features.map((f) =>
      String((f.properties as Record<string, unknown>).s2),
    );
    assert.ok(ids.length > 0);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("suggests the same bin resolution for a dateline layer as an equivalent one", async () => {
    // The same 3°-wide strip, written once across the dateline and once shifted
    // 160° west. Identical coverage, so the suggested resolution must match —
    // before the fix the wrapped layer measured 357° wide and got a much
    // coarser resolution.
    const wrapped = baseCtx([fijiLayer()], { dggsType: "h3", source: "polyfill", layer: "fiji" });
    const shiftedLayer: GeoLibreLayer = {
      ...pointLayer(),
      id: "shifted",
      geojson: pointCollection([
        [17.5, -18],
        [20.5, -16],
      ]),
    };
    const shifted = baseCtx([shiftedLayer], {
      dggsType: "h3",
      source: "polyfill",
      layer: "shifted",
    });
    await dggsBinPointsTool.run(wrapped.ctx);
    await dggsBinPointsTool.run(shifted.ctx);
    const suggested = (logs: string[]) => logs.find((l) => /Using suggested resolution/.test(l));
    assert.ok(suggested(wrapped.logs));
    assert.equal(suggested(wrapped.logs), suggested(shifted.logs));
  });

  it("creates a grid from a manual bounding box", async () => {
    const { ctx, added } = baseCtx([], {
      dggsType: "a5",
      source: "bbox",
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      resolution: 5,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
  });

  it("rejects a degenerate manual bounding box", async () => {
    const { ctx, added, logs } = baseCtx([], {
      dggsType: "h3",
      source: "bbox",
      west: 2,
      south: 0,
      east: 1,
      north: 1,
      resolution: 5,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /west < east/i.test(l)));
  });

  it("rejects H3 resolution above 15", async () => {
    const { ctx, added, logs } = baseCtx([], {
      dggsType: "h3",
      source: "viewport",
      resolution: 16,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /0 to 15/i.test(l)));
  });

  it("accepts A5 resolution up to 30", async () => {
    const { ctx, added, logs, duckdb } = baseCtx([], {
      dggsType: "a5",
      // Tiny viewport so the hard-cap estimate does not trip at high res.
      source: "bbox",
      west: 0,
      south: 0,
      east: 0.000001,
      north: 0.000001,
      resolution: 30,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.ok(!logs.some((l) => /resolution must be/i.test(l)));
    assert.match(duckdb.queries[0], /a5_geometry_to_cells\(.+, 30\), 30\)/);
  });

  it("auto-suggests a resolution when none is given", async () => {
    const { ctx, logs } = baseCtx([], { dggsType: "h3", source: "viewport" });
    await createDggsGridTool.run(ctx);
    assert.ok(logs.some((l) => /suggested resolution/i.test(l)));
  });

  it("aborts when the requested resolution exceeds the hard cap", async () => {
    const { ctx, added, logs } = baseCtx([polygonLayer()], {
      dggsType: "h3",
      source: "extent",
      layer: "poly",
      resolution: 15,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /cap/i.test(l)));
  });

  it("polyfills a selected polygon layer and releases the registered source", async () => {
    const { ctx, added, duckdb } = baseCtx([polygonLayer()], {
      dggsType: "a5",
      source: "polyfill",
      layer: "poly",
      resolution: 6,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.equal(duckdb.released.length, 1);
    assert.match(duckdb.queries[0], /ST_Union_Agg/);
  });

  it("rejects polyfill of a non-polygon layer", async () => {
    const { ctx, added, logs } = baseCtx([pointLayer()], {
      dggsType: "h3",
      source: "polyfill",
      layer: "pts",
      resolution: 6,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /polygon/i.test(l)));
  });

  it("fills the extent of a non-polygon layer", async () => {
    const { ctx, added } = baseCtx([pointLayer()], {
      dggsType: "h3",
      source: "extent",
      layer: "pts",
      resolution: 6,
    });
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 1);
  });

  it("logs a soft message and adds no layer when zero cells are produced", async () => {
    const logs: string[] = [];
    const added: string[] = [];
    const ctx: ProcessingContext = {
      layers: [],
      parameters: { dggsType: "h3", source: "viewport", resolution: 5 },
      log: (m) => logs.push(m),
      addResultLayer: (name) => added.push(name),
      viewportBounds: () => [0, 0, 1, 1],
      duckdb: {
        ensureExtensions: async () => {},
        registerGeoJson: async () => ({
          sql: "ST_Read('mock.geojson')",
          release: async () => {},
        }),
        query: async () => [],
      },
    };
    await createDggsGridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /no h3 cells/i.test(l)));
  });
});

describe("dggs binning", () => {
  it("bins points to H3 and requires a field for non-count aggregates", async () => {
    const missing = baseCtx([pointLayer()], {
      dggsType: "h3",
      layer: "pts",
      aggOp: "sum",
      resolution: 7,
    });
    await dggsBinPointsTool.run(missing.ctx);
    assert.equal(missing.added.length, 0);
    assert.ok(missing.logs.some((l) => /field/i.test(l)));

    const ok = baseCtx([pointLayer()], {
      dggsType: "h3",
      layer: "pts",
      aggOp: "count",
      resolution: 7,
    });
    await dggsBinPointsTool.run(ok.ctx);
    assert.equal(ok.added.length, 1);
    assert.match(ok.added[0], /H3 bins/);
    assert.deepEqual(ok.duckdb.extensions[0], ["spatial", "h3"]);
    assert.match(ok.duckdb.queries[0], /h3_latlng_to_cell/);
    assert.equal(ok.duckdb.released.length, 1);
  });

  it("bins points to A5", async () => {
    const { ctx, added, duckdb } = baseCtx([pointLayer()], {
      dggsType: "a5",
      layer: "pts",
      aggOp: "count",
      resolution: 7,
    });
    await dggsBinPointsTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /A5 bins/);
    assert.deepEqual(duckdb.extensions[0], ["spatial", "a5"]);
    assert.match(duckdb.queries[0], /a5_lonlat_to_cell/);
  });

  it("bins points to S2 without DuckDB", async () => {
    const { ctx, added, duckdb } = baseCtx([pointLayer()], {
      dggsType: "s2",
      layer: "pts",
      aggOp: "count",
      resolution: 7,
    });
    ctx.duckdb = undefined;
    await dggsBinPointsTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /S2 bins/);
    assert.equal(duckdb.queries.length, 0);
  });

  it("bins points to DGGAL without DuckDB", async () => {
    const { ctx, added, duckdb } = baseCtx([pointLayer()], {
      dggsType: "dggal",
      dggalType: "isea3h",
      layer: "pts",
      aggOp: "count",
      resolution: 5,
    });
    ctx.duckdb = undefined;
    await dggsBinPointsTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /ISEA3H bins/);
    assert.equal(duckdb.queries.length, 0);
  });

  it("bins points to DGGRID", async () => {
    const { ctx, added, duckdb } = baseCtx([pointLayer()], {
      dggsType: "dggrid",
      layer: "pts",
      aggOp: "count",
      resolution: 5,
    });
    await dggsBinPointsTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /ISEA4H bins/);
    assert.deepEqual(duckdb.extensions[0], ["spatial", "duck_dggs"]);
    assert.match(duckdb.queries[0], /geo_to_seqnum/);
    assert.match(duckdb.queries[0], /dggs_params\('ISEA', 4, 'HEXAGON'/);
  });

  it("rejects an unknown aggregate operation", async () => {
    const { ctx, added, logs } = baseCtx([pointLayer()], {
      dggsType: "h3",
      layer: "pts",
      aggOp: "median",
      resolution: 7,
    });
    await dggsBinPointsTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /unknown aggregate/i.test(l)));
  });
});
