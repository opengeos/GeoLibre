import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeArrayBuffer } from "geotiff";
import {
  childrenOf,
  classFieldSlug,
  contextFeatures,
  isContextField,
  decodeLabelGrid,
  encodeLabelGrid,
  levelFeatures,
  mergeObjects,
  objectAdjacency,
  rasterizePolygons,
  relabelGrid,
  type ObiaFeatureTable,
} from "@geolibre/processing";

/** A 4 x 2 label raster: objects 1, 2, 3, 4 as 1 x 2 columns, left to right. */
function labels(): Uint8Array {
  return new Uint8Array(
    writeArrayBuffer(new Float32Array([1, 2, 3, 4, 1, 2, 3, 4]), {
      width: 4,
      height: 2,
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 500000, 4000000, 0],
      ProjectedCSTypeGeoKey: 32617,
      GTModelTypeGeoKey: 1,
    } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer,
  );
}

/** Children: 1 and 2 dark and alike, 3 and 4 bright and alike. */
function children(): ObiaFeatureTable {
  const row = (mean: number, std: number, min: number, max: number) => ({
    mean_b1: mean,
    std_b1: std,
    min_b1: min,
    max_b1: max,
    area_px: 2,
  });
  return {
    fields: ["mean_b1", "std_b1", "min_b1", "max_b1", "area_px"],
    rows: new Map([
      [1, row(10, 0, 10, 10)],
      [2, row(12, 0, 12, 12)],
      [3, row(90, 0, 90, 90)],
      [4, row(92, 0, 92, 92)],
    ]),
  };
}

describe("OBIA object hierarchy", () => {
  it("finds which objects share edges, and how many", async () => {
    const grid = await decodeLabelGrid(labels());
    assert.deepEqual([...grid.ids], [1, 2, 3, 4, 1, 2, 3, 4]);
    const graph = objectAdjacency(grid);
    assert.deepEqual(
      [...graph.get(2)!],
      [
        [1, 2],
        [3, 2],
      ],
    );
    assert.deepEqual([...graph.get(1)!], [[2, 2]]);
  });

  it("merges alike neighbors first and stops at the scale", async () => {
    const grid = await decodeLabelGrid(labels());
    const graph = objectAdjacency(grid);
    // A small scale merges the two alike pairs, not the dark and bright ones.
    const parentOf = mergeObjects(children(), graph, { scale: 1.2, bands: [1] });
    assert.deepEqual(
      [...parentOf],
      [
        [1, 1],
        [2, 1],
        [3, 2],
        [4, 2],
      ],
    );
    assert.deepEqual(
      [...childrenOf(parentOf)],
      [
        [1, [1, 2]],
        [2, [3, 4]],
      ],
    );
    // A large one merges everything; zero merges nothing.
    assert.equal(
      new Set(mergeObjects(children(), graph, { scale: 100, bands: [1] }).values()).size,
      1,
    );
    assert.equal(
      new Set(mergeObjects(children(), graph, { scale: 0, bands: [1] }).values()).size,
      4,
    );
  });

  it("refuses to merge without spectral statistics", async () => {
    const graph = objectAdjacency(await decodeLabelGrid(labels()));
    assert.throws(
      () => mergeObjects({ fields: ["area_px"], rows: new Map() }, graph, { scale: 1, bands: [1] }),
      /measure spectral statistics first/,
    );
  });

  it("computes parent features exactly, with the tools' names", async () => {
    const grid = await decodeLabelGrid(labels());
    const parentOf = new Map([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
    ]);
    const parentIds = relabelGrid(grid, parentOf);
    assert.deepEqual([...parentIds], [1, 1, 2, 2, 1, 1, 2, 2]);
    const table = levelFeatures(children(), parentOf, parentIds, grid, [1], {
      spectral: true,
      shape: true,
      context: true,
    });
    const left = table.rows.get(1)!;
    assert.equal(left.mean_b1, 11);
    assert.equal(left.std_b1, 1); // values 10, 10, 12, 12
    assert.equal(left.min_b1, 10);
    assert.equal(left.max_b1, 12);
    assert.equal(left.area_px, 4);
    // A 2 x 2 block at the image edge: 8 edges, 2 of them shared.
    assert.equal(left.perimeter_px, 8);
    assert.equal(left.bbox_width_px, 2);
    assert.equal(left.neighbor_count, 1);
    assert.equal(left.shared_boundary_total, 2);
    assert.ok(Math.abs((left.compactness ?? 0) - (4 * Math.PI * 4) / 64) < 1e-12);
    // The parent grid round-trips through a label raster.
    const decoded = await decodeLabelGrid(encodeLabelGrid(grid, parentIds));
    assert.deepEqual([...decoded.ids], [...parentIds]);
    assert.equal(decoded.raster.originX, 500000);
  });

  it("names per-class fields safely and uniquely", () => {
    const taken = new Set<string>();
    assert.equal(classFieldSlug("Trees, shrubs", taken), "trees_shrubs");
    assert.equal(classFieldSlug("trees shrubs", taken), "trees_shrubs_2");
    assert.equal(classFieldSlug("!!!", taken), "class");
    assert.equal(classFieldSlug("Forêt", taken), "foret");
    assert.equal(classFieldSlug("水体", taken), "水体");
  });

  it("computes neighbor contrast, parent features and class shares", async () => {
    const grid = await decodeLabelGrid(labels());
    const adjacency = objectAdjacency(grid);
    const table = children();
    const parentOf = new Map([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
    ]);
    const parentTable = {
      fields: ["mean_b1", "area_px", "compactness"],
      rows: new Map([
        [1, { mean_b1: 11, area_px: 4, compactness: 0.8 }],
        [2, { mean_b1: 91, area_px: 4, compactness: 0.8 }],
      ]),
    };
    const out = contextFeatures({
      table,
      adjacency,
      bands: [1],
      classes: ["veg", "roof"],
      parent: {
        parentOf,
        table: parentTable,
        predictions: new Map([
          [1, "veg"],
          [2, "roof"],
        ]),
      },
    });
    assert.deepEqual(out.fields, [
      "nb_contrast_b1",
      "parent_mean_b1",
      "parent_area_px",
      "parent_is_veg",
      "parent_is_roof",
    ]);
    // Object 2 borders 1 (mean 10) and 3 (mean 90) equally: contrast 12 - 50.
    assert.equal(out.rows.get(2)?.nb_contrast_b1, -38);
    assert.equal(out.rows.get(1)?.nb_contrast_b1, -2);
    assert.equal(out.rows.get(3)?.parent_mean_b1, 91);
    assert.equal(out.rows.get(3)?.parent_is_roof, 1);
    assert.equal(out.rows.get(3)?.parent_is_veg, 0);
    assert.ok(out.fields.every(isContextField));

    // From the parents' side: the share of each class among their children.
    const parents = contextFeatures({
      table: parentTable,
      adjacency: new Map(),
      bands: [],
      classes: ["veg", "roof"],
      children: {
        parentOf,
        areas: new Map([
          [1, 2],
          [2, 2],
          [3, 3],
          [4, 1],
        ]),
        predictions: new Map([
          [1, "veg"],
          [2, "roof"],
          [3, "roof"],
          [4, "roof"],
        ]),
      },
    });
    assert.equal(parents.rows.get(1)?.child_frac_veg, 0.5);
    assert.equal(parents.rows.get(2)?.child_frac_roof, 1);
  });

  it("burns polygons by pixel center, with holes, and later ones on top", () => {
    // A 6 x 4 grid; a 4 x 4 square with a 2 x 2 hole, and a later 2 x 2 square.
    const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ];
    const ids = rasterizePolygons(
      [
        { id: 1, rings: [square(0, 0, 4, 4), square(1, 1, 3, 3)] },
        { id: 2, rings: [square(4, 2, 6, 4)] },
        { id: 3, rings: [square(3.6, 3.6, 3.9, 3.9)] }, // covers no pixel center
      ],
      6,
      4,
    );
    assert.deepEqual(
      [...ids],
      [1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 2, 2, 1, 1, 1, 1, 2, 2],
    );
  });
});
