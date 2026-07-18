import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

// shpjs's bundle reads the browser `self` global at module-eval time.
(globalThis as { self?: unknown }).self ??= globalThis;

type ShpModule = {
  parseShp: (shp: ArrayBuffer, prj?: unknown) => Geometry[];
  parseDbf: (dbf: ArrayBuffer) => Record<string, unknown>[];
  combine: (input: [Geometry[], Record<string, unknown>[]]) => FeatureCollection;
};

let shp: ShpModule;
let writeShapefile: (geojson: FeatureCollection) => {
  shp: Uint8Array;
  shx: Uint8Array;
  dbf: Uint8Array;
  prj: Uint8Array;
  cpg: Uint8Array;
};

before(async () => {
  // parseShp / parseDbf / combine are named exports in shpjs.
  shp = (await import("shpjs")) as unknown as ShpModule;
  ({ writeShapefile } = await import("../apps/geolibre-desktop/src/lib/shapefile-writer"));
});

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Round-trip a FeatureCollection through the writer and shpjs reader. */
function roundTrip(geojson: FeatureCollection): FeatureCollection {
  const parts = writeShapefile(geojson);
  const geometries = shp.parseShp(toArrayBuffer(parts.shp));
  const properties = shp.parseDbf(toArrayBuffer(parts.dbf));
  return shp.combine([geometries, properties]);
}

/** Collect every coordinate pair, rounded, sorted — for order-insensitive compare. */
function coordKey(geometry: Geometry): string {
  const out: string[] = [];
  const visit = (p: Position) => out.push(`${Number(p[0]).toFixed(5)},${Number(p[1]).toFixed(5)}`);
  const walk = (g: Geometry) => {
    if (g.type === "Point") visit(g.coordinates);
    else if (g.type === "LineString" || g.type === "MultiPoint") g.coordinates.forEach(visit);
    else if (g.type === "Polygon" || g.type === "MultiLineString")
      g.coordinates.forEach((part) => part.forEach(visit));
    else if (g.type === "MultiPolygon")
      g.coordinates.forEach((poly) => poly.forEach((r) => r.forEach(visit)));
  };
  walk(geometry);
  return out.sort().join("|");
}

describe("writeShapefile", () => {
  it("round-trips points with attributes", () => {
    const input: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [10.5, 20.25] },
          properties: { name: "Alpha", value: 12 },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-30, 40] },
          properties: { name: "Bravo", value: 34 },
        },
      ],
    };
    const out = roundTrip(input);
    assert.equal(out.features.length, 2);
    assert.equal(out.features[0].geometry?.type, "Point");
    assert.deepEqual(
      (out.features[0].geometry as { coordinates: Position }).coordinates,
      [10.5, 20.25],
    );
    assert.equal(out.features[0].properties?.name, "Alpha");
    assert.equal(out.features[0].properties?.value, 12);
    assert.equal(out.features[1].properties?.value, 34);
  });

  it("round-trips a polygon with a hole (coordinates preserved)", () => {
    const polygon: Feature = {
      type: "Feature",
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
          [
            [3, 3],
            [3, 6],
            [6, 6],
            [6, 3],
            [3, 3],
          ],
        ],
      },
      properties: { id: 1 },
    };
    const out = roundTrip({ type: "FeatureCollection", features: [polygon] });
    assert.equal(out.features.length, 1);
    const geometry = out.features[0].geometry as Geometry;
    assert.ok(
      geometry.type === "Polygon" || geometry.type === "MultiPolygon",
      `unexpected type ${geometry.type}`,
    );
    assert.equal(coordKey(geometry), coordKey(polygon.geometry as Geometry));
  });

  it("round-trips a linestring", () => {
    const line: Feature = {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [5, 5],
          [10, 0],
        ],
      },
      properties: { road: "Main" },
    };
    const out = roundTrip({ type: "FeatureCollection", features: [line] });
    const geometry = out.features[0].geometry as Geometry;
    assert.ok(geometry.type === "LineString" || geometry.type === "MultiLineString");
    assert.equal(coordKey(geometry), coordKey(line.geometry as Geometry));
    assert.equal(out.features[0].properties?.road, "Main");
  });

  it("truncates long field names to 10 characters and de-duplicates", () => {
    const out = roundTrip({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { population_total: 100, population_density: 5 },
        },
      ],
    });
    const keys = Object.keys(out.features[0].properties ?? {});
    // Both source names collapse to the same 10-char prefix, so one is suffixed.
    assert.equal(keys.length, 2);
    for (const key of keys) assert.ok(key.length <= 10, `${key} too long`);
    assert.notEqual(keys[0], keys[1]);
    const values = (Object.values(out.features[0].properties ?? {}) as number[]).sort(
      (a, b) => a - b,
    );
    assert.deepEqual(values, [5, 100]);
  });
});
