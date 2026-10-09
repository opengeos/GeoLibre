import "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ObiaImportError,
  parseClassSchema,
  parseFeatureTable,
  parseLevelMapping,
  samplePoints,
  withClasses,
} from "../apps/geolibre-desktop/src/lib/obia/obia-import";

describe("OBIA import", () => {
  it("reads a class list as JSON or CSV", () => {
    assert.deepEqual(
      parseClassSchema('[{"name":"water","color":"#0000ff"},{"name":"veg"},{"name":"water"}]'),
      [
        { name: "water", color: "#0000ff" },
        { name: "veg", color: "#2563eb" },
      ],
    );
    assert.deepEqual(parseClassSchema('{"classes":[{"name":"a","color":"#123456"}]}'), [
      { name: "a", color: "#123456" },
    ]);
    assert.deepEqual(parseClassSchema("class,colour\nroof,#ff0000\nroad,bad"), [
      { name: "roof", color: "#ff0000" },
      { name: "road", color: "#2563eb" },
    ]);
    assert.throws(() => parseClassSchema("[]"), ObiaImportError);
    assert.throws(() => parseClassSchema("{oops"), ObiaImportError);
  });

  it("adds missing classes with distinct colors", () => {
    const next = withClasses([{ name: "veg", color: "#00ff00" }], ["veg", "water"]);
    assert.deepEqual(
      next.map((item) => item.name),
      ["veg", "water"],
    );
    assert.notEqual(next[1].color, next[0].color);
  });

  it("reads a feature table keyed by segment_id", () => {
    const table = parseFeatureTable("segment_id,Mean Layer 1,ratio\n10,5.5,0.2\n20,,0.4\n");
    assert.deepEqual(table.fields, ["Mean Layer 1", "ratio"]);
    assert.equal(table.rows.get(10)?.["Mean Layer 1"], 5.5);
    assert.equal(table.rows.get(20)?.["Mean Layer 1"], null);
    assert.throws(() => parseFeatureTable("id,x\n1,2\n"), ObiaImportError);
  });

  it("reads a level mapping by header, or by its first two columns", () => {
    assert.deepEqual(
      [...parseLevelMapping("parent_id,child_id\n1,10\n1,20\n2,30\n")],
      [
        [10, 1],
        [20, 1],
        [30, 2],
      ],
    );
    assert.deepEqual([...parseLevelMapping("a,b\n5,1\n6,0\n")], [[5, 1]]);
    assert.throws(() => parseLevelMapping("a,b\n"), ObiaImportError);
  });

  it("keeps a headerless mapping's first row and never reads one column twice", () => {
    assert.deepEqual(
      [...parseLevelMapping("1,5\n2,5\n")],
      [
        [1, 5],
        [2, 5],
      ],
    );
    // Only a parent column is named: the child is the other one.
    assert.deepEqual([...parseLevelMapping("parent_id,id\n7,3\n")], [[3, 7]]);
    assert.throws(
      () => parseLevelMapping(`child,parent\n${2 ** 24 + 1},1\n`),
      (err: unknown) => err instanceof ObiaImportError && err.code === "big-ids",
    );
  });

  it("puts a sample point inside a concave or holed polygon", () => {
    const inside = ([x, y]: number[], rings: number[][][]) => {
      let hit = false;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
        }
      }
      return hit;
    };
    // A square ring: its centroid is in the hole.
    const ring = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [2, 2],
        [2, 8],
        [8, 8],
        [8, 2],
        [2, 2],
      ],
    ];
    const [point] = samplePoints({ type: "Polygon", coordinates: ring });
    assert.ok(inside(point, ring), `point ${point} is not inside the ring`);
    // A thin "L": its centroid falls outside the shape.
    const ell = [
      [
        [0, 0],
        [10, 0],
        [10, 1],
        [1, 1],
        [1, 10],
        [0, 10],
        [0, 0],
      ],
    ];
    const [corner] = samplePoints({ type: "Polygon", coordinates: ell });
    assert.ok(inside(corner, ell), `point ${corner} is not inside the L`);
    // Opposite windings in a multipolygon do not cancel out.
    const square = (x: number) => [
      [x, 0],
      [x + 1, 0],
      [x + 1, 1],
      [x, 1],
      [x, 0],
    ];
    const [mid] = samplePoints({
      type: "MultiPolygon",
      coordinates: [[square(0)], [square(5).reverse()]],
    });
    assert.ok(mid, "a multipolygon with mixed windings still has a point");
    // A zero-area polygon has none.
    assert.deepEqual(
      samplePoints({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }),
      [],
    );
  });

  it("finds a small polygon's centroid precisely in degrees", () => {
    // A 1 x 1 m square near Spokane: raw-degree shoelace sums cancel here.
    const [x0, y0, d] = [-117.5943709, 47.6541957, 0.00001];
    const [[lng, lat]] = samplePoints({
      type: "Polygon",
      coordinates: [
        [
          [x0, y0],
          [x0 + d, y0],
          [x0 + d, y0 + d],
          [x0, y0 + d],
          [x0, y0],
        ],
      ],
    });
    assert.ok(Math.abs(lng - (x0 + d / 2)) < 1e-9);
    assert.ok(Math.abs(lat - (y0 + d / 2)) < 1e-9);
  });
});
