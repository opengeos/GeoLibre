import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { s2 } from "s2js";
import {
  buildA5CompactSql,
  buildA5ExpandCountSql,
  buildA5ExpandSql,
} from "../packages/processing/src/a5-tools";
import {
  buildH3CompactSql,
  buildH3ExpandCountSql,
  buildH3ExpandSql,
} from "../packages/processing/src/h3-tools";
import { dggsCompactTool, getDggsTool } from "../packages/processing/src/dggs-tools";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { DuckDbCapability, ProcessingContext } from "../packages/processing/src/types";
import type { Feature, Polygon } from "geojson";

describe("dggs compact/expand SQL", () => {
  it("builds H3 compact and expand SQL from a cell ID field", () => {
    const compact = buildH3CompactSql("ST_Read('x.geojson')", 'h3"x');
    assert.match(compact, /h3_string_to_h3\(CAST\("h3""x" AS VARCHAR\)\)/);
    assert.match(compact, /h3_compact_cells\(cells\)/);
    assert.match(compact, /h3_h3_to_string\(cell\) AS h3/);

    const expand = buildH3ExpandSql("ST_Read('x.geojson')", 7);
    assert.match(expand, /h3_uncompact_cells\(cells, 7\)/);
    assert.match(buildH3ExpandCountSql("ST_Read('x.geojson')", 7), /len\(h3_uncompact_cells/);
  });

  it("builds A5 compact and expand SQL from a cell ID field", () => {
    const compact = buildA5CompactSql("ST_Read('x.geojson')");
    assert.match(compact, /a5_hex_to_u64\(CAST\("a5" AS VARCHAR\)\)/);
    assert.match(compact, /a5_compact\(cells\)/);
    assert.match(compact, /a5_u64_to_hex\(cell\) AS a5/);

    const expand = buildA5ExpandSql("ST_Read('x.geojson')", 8, "a5");
    assert.match(expand, /a5_uncompact\(cells, 8\)/);
    assert.match(buildA5ExpandCountSql("ST_Read('x.geojson')", 8), /len\(a5_uncompact/);
  });
});

function h3CellLayer(): GeoLibreLayer {
  return {
    id: "cells",
    name: "Cells",
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
          properties: { h3: "85283473fffffff" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    },
  };
}

function s2SiblingCellLayer(): GeoLibreLayer {
  const leaf = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(10, 10));
  const parent = s2.cellid.parent(leaf, 5);
  const features: Feature<Polygon>[] = [];
  let id = s2.cellid.childBegin(parent);
  for (let i = 0; i < 4; i += 1) {
    const token = s2.cellid.toToken(id);
    features.push({
      type: "Feature",
      properties: { s2: token },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    });
    id = s2.cellid.next(id);
  }
  return {
    id: "s2cells",
    name: "S2 Cells",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features },
  };
}

function mockDuckDb(): DuckDbCapability & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    ensureExtensions: async () => {},
    registerGeoJson: async () => ({
      sql: "ST_Read('mock.geojson')",
      release: async () => {},
    }),
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes(" AS n ")) return [{ n: 3 }];
      const geojson = '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}';
      if (sql.includes("a5_")) return [{ a5: "1600000000000000", geojson }];
      return [{ h3: "8428347ffffffff", geojson }];
    },
  };
}

describe("dggs compact tool", () => {
  it("registers under getDggsTool", () => {
    assert.equal(getDggsTool("dggs-compact"), dggsCompactTool);
    assert.equal(dggsCompactTool.group, "DGGS");
  });

  it("compacts an H3 cell layer", async () => {
    const duckdb = mockDuckDb();
    const logs: string[] = [];
    const added: string[] = [];
    const ctx: ProcessingContext = {
      layers: [h3CellLayer()],
      parameters: { dggsType: "h3", mode: "compact", layer: "cells" },
      log: (m) => logs.push(m),
      addResultLayer: (name) => added.push(name),
      duckdb,
    };
    await dggsCompactTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /H3 compact/);
    assert.ok(duckdb.queries.some((q) => /h3_compact_cells/.test(q)));
    assert.ok(logs.some((l) => /Compacted to \d+ H3 cell/.test(l)));
  });

  it("expands an H3 cell layer after a count guard", async () => {
    const duckdb = mockDuckDb();
    const added: string[] = [];
    const ctx: ProcessingContext = {
      layers: [h3CellLayer()],
      parameters: { dggsType: "h3", mode: "expand", layer: "cells", resolution: 6 },
      log: () => {},
      addResultLayer: (name) => added.push(name),
      duckdb,
    };
    await dggsCompactTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /H3 expand \(res 6\)/);
    assert.ok(duckdb.queries.some((q) => /len\(h3_uncompact_cells/.test(q)));
    assert.ok(duckdb.queries.some((q) => /h3_uncompact_cells\(cells, 6\)/.test(q)));
  });

  it("rejects expand when the count exceeds the hard cap", async () => {
    const duckdb = mockDuckDb();
    duckdb.query = async (sql: string) => {
      duckdb.queries.push(sql);
      if (sql.includes(" AS n ")) return [{ n: 500_000 }];
      return [];
    };
    const logs: string[] = [];
    const added: string[] = [];
    const ctx: ProcessingContext = {
      layers: [h3CellLayer()],
      parameters: { dggsType: "h3", mode: "expand", layer: "cells", resolution: 10 },
      log: (m) => logs.push(m),
      addResultLayer: (name) => added.push(name),
      duckdb,
    };
    await dggsCompactTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /cap/.test(l)));
  });

  it("exposes S2 and DGGAL in the type picker; Fix antimeridian is H3/S2 only", () => {
    const typeParam = dggsCompactTool.parameters.find((p) => p.id === "dggsType");
    assert.deepEqual(
      typeParam?.options?.map((o) => o.value),
      ["h3", "s2", "a5", "dggal"],
    );
    assert.ok(typeParam?.options?.some((o) => o.value === "s2"));
    assert.ok(typeParam?.options?.some((o) => o.value === "dggal"));
    const fix = dggsCompactTool.parameters.find((p) => p.id === "fixAntimeridian");
    assert.deepEqual(fix?.visibleWhen, { param: "dggsType", in: ["h3", "s2"] });
    assert.ok(!fix?.visibleWhen?.in.includes("a5"));
    assert.ok(!fix?.visibleWhen?.in.includes("dggal"));
    const dggalType = dggsCompactTool.parameters.find((p) => p.id === "dggalType");
    assert.deepEqual(dggalType?.visibleWhen, { param: "dggsType", in: ["dggal"] });
  });

  it("compacts an S2 cell layer without DuckDB", async () => {
    const logs: string[] = [];
    const added: string[] = [];
    let featureCount = 0;
    const ctx: ProcessingContext = {
      layers: [s2SiblingCellLayer()],
      parameters: { dggsType: "s2", mode: "compact", layer: "s2cells" },
      log: (m) => logs.push(m),
      addResultLayer: (name, fc) => {
        added.push(name);
        featureCount = fc.features.length;
      },
    };
    await dggsCompactTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0]!, /S2 compact/);
    assert.equal(featureCount, 1);
    assert.ok(logs.some((l) => /Compacted to 1 S2 cell/.test(l)));
  });

  it("expands an S2 cell layer without DuckDB", async () => {
    const compactLayer = s2SiblingCellLayer();
    // Pre-compact to one parent so expand has work to do.
    const parentToken = (() => {
      const leaf = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(10, 10));
      return s2.cellid.toToken(s2.cellid.parent(leaf, 5));
    })();
    compactLayer.geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { s2: parentToken },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };
    const added: string[] = [];
    let featureCount = 0;
    const ctx: ProcessingContext = {
      layers: [compactLayer],
      parameters: { dggsType: "s2", mode: "expand", layer: "s2cells", resolution: 6 },
      log: () => {},
      addResultLayer: (name, fc) => {
        added.push(name);
        featureCount = fc.features.length;
      },
    };
    await dggsCompactTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0]!, /S2 expand \(res 6\)/);
    assert.equal(featureCount, 4);
  });

  it("compacts a DGGAL ISEA4R cell layer without DuckDB", async () => {
    const { withDggalDggrs } = await import("../packages/processing/src/dggal-tools");
    const layer = await withDggalDggrs("isea4r", (engine) => {
      const parent = engine.getZoneFromWGS84Centroid(3, {
        lat: (10 * Math.PI) / 180,
        lon: (10 * Math.PI) / 180,
      });
      const features = [...engine.getSubZones(parent, 1)].map((z) => {
        const token = engine.getZoneTextID(z);
        return {
          type: "Feature" as const,
          properties: { dggal: token },
          geometry: {
            type: "Polygon" as const,
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        };
      });
      return {
        id: "dggalcells",
        name: "DGGAL Cells",
        type: "geojson" as const,
        source: { type: "geojson" as const },
        visible: true,
        opacity: 1,
        style: { ...DEFAULT_LAYER_STYLE },
        metadata: {},
        geojson: { type: "FeatureCollection" as const, features },
      };
    });
    const added: string[] = [];
    let featureCount = 0;
    const ctx: ProcessingContext = {
      layers: [layer],
      parameters: {
        dggsType: "dggal",
        dggalType: "isea4r",
        mode: "compact",
        layer: "dggalcells",
      },
      log: () => {},
      addResultLayer: (name, fc) => {
        added.push(name);
        featureCount = fc.features.length;
      },
    };
    await dggsCompactTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0]!, /ISEA4R compact/);
    assert.equal(featureCount, 1);
  });
});
