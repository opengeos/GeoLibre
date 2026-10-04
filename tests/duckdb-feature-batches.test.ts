import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  featureCollectionFromBatches,
  rowToFeature,
  type FeatureRowBatch,
} from "../apps/geolibre-desktop/src/lib/duckdb-feature-batches";

const GEOJSON = "__geolibre_geometry_geojson";

/** A batch double: plain rows, optionally behind `toJSON` like Arrow StructRows. */
function batch(rows: Record<string, unknown>[], asStructRows = false): FeatureRowBatch {
  return {
    toArray: () => (asStructRows ? rows.map((row) => ({ toJSON: () => ({ ...row }) })) : rows),
    schema: { fields: [] },
  };
}

function makeRows(count: number, offset = 0): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + offset;
    return {
      id: BigInt(n),
      big: 2n ** 60n + BigInt(n),
      name: `row-${n}`,
      when: new Date(Date.UTC(2024, 0, 1 + (n % 28))),
      nested: { list: [BigInt(n), n] },
      geometry: new Uint8Array([1, 2, 3]),
      blob: new Uint8Array([4]),
      [GEOJSON]: n % 7 === 0 ? null : JSON.stringify({ type: "Point", coordinates: [n, -n] }),
    };
  });
}

/** The one-pass conversion the loader used before streaming (#2858). */
function onePass(rows: Record<string, unknown>[], geometryColumn?: string) {
  return {
    type: "FeatureCollection",
    features: rows.map((row) => rowToFeature(row, GEOJSON, geometryColumn)),
  };
}

describe("rowToFeature", () => {
  it("parses the GeoJSON column and normalizes the properties", () => {
    const [row] = makeRows(1, 3);
    assert.deepEqual(rowToFeature(row, GEOJSON, "geometry"), {
      type: "Feature",
      geometry: { type: "Point", coordinates: [3, -3] },
      properties: {
        id: 3,
        big: (2n ** 60n + 3n).toString(),
        name: "row-3",
        when: "2024-01-04T00:00:00.000Z",
        nested: { list: [3, 3] },
      },
    });
  });

  it("keeps a row whose geometry is NULL as a null-geometry feature", () => {
    const feature = rowToFeature({ a: 1, [GEOJSON]: null }, GEOJSON);
    assert.equal(feature.geometry, null);
    assert.deepEqual(feature.properties, { a: 1 });
  });
});

describe("featureCollectionFromBatches", () => {
  it("matches the one-pass conversion across many batches", async () => {
    const batches = [makeRows(2048), makeRows(2048, 2048), makeRows(5, 4096)];
    const streamed = await featureCollectionFromBatches(
      batches.map((rows) => batch(rows, true)),
      { geometryJsonColumn: GEOJSON, geometryColumn: "geometry" },
    );
    assert.deepEqual(streamed, onePass(batches.flat(), "geometry"));
  });

  it("reads an async stream of record batches", async () => {
    const rows = makeRows(10);
    async function* stream() {
      yield batch(rows.slice(0, 4));
      yield batch(rows.slice(4));
    }
    const streamed = await featureCollectionFromBatches(stream(), { geometryJsonColumn: GEOJSON });
    assert.deepEqual(streamed, onePass(rows));
  });

  it("returns an empty collection for an empty result", async () => {
    assert.deepEqual(await featureCollectionFromBatches([], { geometryJsonColumn: GEOJSON }), {
      type: "FeatureCollection",
      features: [],
    });
  });

  it("yields inside a batch that runs past the slice budget", async () => {
    // A fake clock that advances 20 ms per read: every 256-row check sees the
    // slice past a 10 ms budget, so a 2048-row batch yields at each one.
    let clock = 0;
    let yields = 0;
    const rows = makeRows(2048);
    const streamed = await featureCollectionFromBatches([batch(rows)], {
      geometryJsonColumn: GEOJSON,
      sliceBudgetMs: 10,
      now: () => (clock += 20),
      yieldFn: async () => {
        yields += 1;
        clock += 100;
      },
    });
    assert.equal(yields, 2048 / 256);
    assert.deepEqual(streamed, onePass(rows));
  });

  it("does not yield while a slice stays within budget", async () => {
    let yields = 0;
    await featureCollectionFromBatches([batch(makeRows(2048))], {
      geometryJsonColumn: GEOJSON,
      now: () => 0,
      yieldFn: async () => {
        yields += 1;
      },
    });
    assert.equal(yields, 0);
  });

  it("propagates an error the stream raises part-way", async () => {
    async function* failing() {
      yield batch(makeRows(3));
      throw new Error("WKB type 'TIN Z' is not supported");
    }
    await assert.rejects(
      featureCollectionFromBatches(failing(), { geometryJsonColumn: GEOJSON }),
      /TIN Z/,
    );
  });
});
