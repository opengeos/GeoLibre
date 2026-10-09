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
