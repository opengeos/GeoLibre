import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Feature, FeatureCollection } from "geojson";
import {
  atlasEntryName,
  buildAtlasPages,
  expandBounds,
  geometryBounds,
  listAtlasFields,
  parseAtlasFilter,
  stripAtlasTokens,
  substituteAtlasTokens,
  type AtlasTokenContext,
} from "../apps/geolibre-desktop/src/lib/print-atlas";

function ctx(overrides: Partial<AtlasTokenContext> = {}): AtlasTokenContext {
  return {
    name: "Springfield",
    pageNumber: 3,
    total: 28,
    properties: { STATE: "IL", POP: 116250 },
    ...overrides,
  };
}

function feature(
  properties: Record<string, unknown>,
  coords: [number, number] = [0, 0],
): Feature {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Point", coordinates: coords },
  };
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

describe("substituteAtlasTokens", () => {
  it("replaces the built-in tokens", () => {
    assert.equal(
      substituteAtlasTokens(
        "{atlas.name} - page {atlas.pagenumber} of {atlas.total}",
        ctx(),
      ),
      "Springfield - page 3 of 28",
    );
  });

  it("replaces attribute tokens and blanks unknown or null fields", () => {
    assert.equal(
      substituteAtlasTokens("{atlas.attr:STATE}/{atlas.attr:MISSING}", ctx()),
      "IL/",
    );
    assert.equal(
      substituteAtlasTokens(
        "[{atlas.attr:NIL}]",
        ctx({ properties: { NIL: null } }),
      ),
      "[]",
    );
  });

  it("passes token-free text through unchanged", () => {
    assert.equal(substituteAtlasTokens("Plain title", ctx()), "Plain title");
    assert.equal(substituteAtlasTokens("", ctx()), "");
  });

  it("repeats a token every time it appears", () => {
    assert.equal(
      substituteAtlasTokens("{atlas.name} {atlas.name}", ctx()),
      "Springfield Springfield",
    );
  });
});

describe("stripAtlasTokens", () => {
  it("removes tokens and collapses leftover whitespace", () => {
    assert.equal(
      stripAtlasTokens("River atlas {atlas.name} {atlas.attr:SEG}"),
      "River atlas",
    );
    assert.equal(stripAtlasTokens("{atlas.pagenumber}"), "");
  });
});

describe("geometryBounds", () => {
  it("computes bounds for points, lines, and polygons", () => {
    assert.deepEqual(
      geometryBounds({ type: "Point", coordinates: [10, 20] }),
      [10, 20, 10, 20],
    );
    assert.deepEqual(
      geometryBounds({
        type: "LineString",
        coordinates: [
          [-3, 5],
          [7, -2],
        ],
      }),
      [-3, -2, 7, 5],
    );
    assert.deepEqual(
      geometryBounds({
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [0, 0],
              [4, 0],
              [4, 3],
              [0, 0],
            ],
          ],
          [
            [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, -1],
            ],
          ],
        ],
      }),
      [-1, -1, 4, 3],
    );
  });

  it("unwraps antimeridian-crossing features to a narrow box", () => {
    // Fiji-like: vertices on both sides of 180°. The raw min/max box would
    // span the far side of the globe; the unwrapped box is ~2° wide with an
    // east longitude past 180 (which MapLibre's fitBounds understands).
    assert.deepEqual(
      geometryBounds({
        type: "LineString",
        coordinates: [
          [179, -17],
          [-179, -16],
        ],
      }),
      [179, -17, 181, -16],
    );
    // A hemisphere-wide feature that does not cross ±180° keeps the raw box.
    assert.deepEqual(
      geometryBounds({
        type: "LineString",
        coordinates: [
          [-90, 0],
          [90, 10],
        ],
      }),
      [-90, 0, 90, 10],
    );
  });

  it("handles GeometryCollections and rejects empty geometries", () => {
    assert.deepEqual(
      geometryBounds({
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [1, 1] },
          { type: "Point", coordinates: [5, -5] },
        ],
      }),
      [1, -5, 5, 1],
    );
    assert.equal(geometryBounds(null), null);
    assert.equal(
      geometryBounds({ type: "MultiPoint", coordinates: [] }),
      null,
    );
  });
});

describe("expandBounds", () => {
  it("expands each side by the margin percentage of its span", () => {
    assert.deepEqual(expandBounds([0, 0, 10, 20], 10), [-1, -2, 11, 22]);
  });

  it("pads degenerate (point) bounds to a minimum span", () => {
    const [w, s, e, n] = expandBounds([5, 5, 5, 5], 10, 0.01);
    assert.ok(e - w >= 0.01 - 1e-12);
    assert.ok(n - s >= 0.01 - 1e-12);
    assert.ok(Math.abs((w + e) / 2 - 5) < 1e-12);
  });

  it("clamps latitudes to the Web Mercator range", () => {
    const [, s, , n] = expandBounds([-180, -84, 180, 84], 50);
    assert.equal(s, -85);
    assert.equal(n, 85);
  });

  it("keeps polar point bounds valid (no inverted box)", () => {
    const [w, s, e, n] = expandBounds([0, 90, 0, 90], 10);
    assert.ok(n > s);
    assert.ok(e > w);
    assert.ok(s >= -85 && n <= 85);
    assert.ok(n - s >= 0.005 - 1e-12);
  });
});

describe("listAtlasFields", () => {
  it("unions property keys in first-seen order", () => {
    const fields = listAtlasFields([
      feature({ b: 1, a: 2 }),
      feature({ c: 3, a: 4 }),
    ]);
    assert.deepEqual(fields, ["b", "a", "c"]);
  });
});

describe("parseAtlasFilter", () => {
  it("matches everything for a blank expression", () => {
    const p = parseAtlasFilter("   ");
    assert.ok(p);
    assert.equal(p?.({}), true);
  });

  it("compares numerically when both sides are numbers", () => {
    const p = parseAtlasFilter("POP > 100000");
    assert.ok(p);
    assert.equal(p?.({ POP: 116250 }), true);
    assert.equal(p?.({ POP: "99999" }), false);
    assert.equal(p?.({ POP: null }), false);
  });

  it("supports equality on strings, quoted or bare", () => {
    const eq = parseAtlasFilter('ST = "CA"');
    assert.equal(eq?.({ ST: "CA" }), true);
    assert.equal(eq?.({ ST: "OR" }), false);
    const bare = parseAtlasFilter("ST != CA");
    assert.equal(bare?.({ ST: "OR" }), true);
  });

  it("lets != match features missing the field entirely", () => {
    const ne = parseAtlasFilter('STATUS != "archived"');
    assert.equal(ne?.({}), true);
    assert.equal(ne?.({ STATUS: null }), true);
    assert.equal(ne?.({ STATUS: "active" }), true);
    assert.equal(ne?.({ STATUS: "archived" }), false);
    // Every other operator still cannot be satisfied by a missing field.
    assert.equal(parseAtlasFilter('STATUS = "x"')?.({}), false);
    assert.equal(parseAtlasFilter("STATUS contains x")?.({}), false);
  });

  it("treats == as an alias for =", () => {
    const p = parseAtlasFilter('ST == "CA"');
    assert.equal(p?.({ ST: "CA" }), true);
    assert.equal(p?.({ ST: "OR" }), false);
  });

  it("does not split on 'and' inside quoted values", () => {
    const eq = parseAtlasFilter('NAME = "Sam and Max"');
    assert.equal(eq?.({ NAME: "Sam and Max" }), true);
    assert.equal(eq?.({ NAME: "Sam" }), false);
    const combined = parseAtlasFilter(
      "NAME contains 'rock and roll' and POP > 5",
    );
    assert.equal(combined?.({ NAME: "Rock and Roll Hall", POP: 10 }), true);
    assert.equal(combined?.({ NAME: "Rock and Roll Hall", POP: 1 }), false);
  });

  it("supports case-insensitive contains", () => {
    const p = parseAtlasFilter("NAME contains york");
    assert.equal(p?.({ NAME: "New York" }), true);
    assert.equal(p?.({ NAME: "Boston" }), false);
  });

  it("joins conditions with and", () => {
    const p = parseAtlasFilter('POP >= 1000 and ST = "CA"');
    assert.equal(p?.({ POP: 2000, ST: "CA" }), true);
    assert.equal(p?.({ POP: 2000, ST: "OR" }), false);
    assert.equal(p?.({ POP: 500, ST: "CA" }), false);
  });

  it("returns null for malformed expressions", () => {
    assert.equal(parseAtlasFilter("POP >"), null);
    assert.equal(parseAtlasFilter("just words"), null);
  });

  it("rejects ordering comparisons on non-numeric values", () => {
    const p = parseAtlasFilter("POP > 10");
    assert.equal(p?.({ POP: "many" }), false);
  });
});

describe("buildAtlasPages", () => {
  const features = [
    feature({ NAME: "B-ville", POP: 200 }, [1, 1]),
    feature({ NAME: "A-town", POP: 300 }, [2, 2]),
    feature({ NAME: "C-city", POP: 100 }, [3, 3]),
  ];

  it("creates one page per feature in source order by default", () => {
    const pages = buildAtlasPages(collection(features));
    assert.equal(pages.length, 3);
    assert.deepEqual(
      pages.map((p) => p.name),
      ["Feature 1", "Feature 2", "Feature 3"],
    );
    assert.deepEqual(pages.map((p) => p.index), [0, 1, 2]);
    assert.deepEqual(pages.map((p) => p.sourceIndex), [0, 1, 2]);
    assert.deepEqual(pages[0].bounds, [1, 1, 1, 1]);
  });

  it("names pages from the name field, falling back per feature", () => {
    const pages = buildAtlasPages(
      collection([...features, feature({ NAME: "" }, [4, 4])]),
      { nameField: "NAME" },
    );
    assert.deepEqual(
      pages.map((p) => p.name),
      ["B-ville", "A-town", "C-city", "Feature 4"],
    );
  });

  it("sorts by field ascending and descending", () => {
    const asc = buildAtlasPages(collection(features), {
      nameField: "NAME",
      sortField: "POP",
    });
    assert.deepEqual(
      asc.map((p) => p.name),
      ["C-city", "B-ville", "A-town"],
    );
    const desc = buildAtlasPages(collection(features), {
      nameField: "NAME",
      sortField: "POP",
      sortDescending: true,
    });
    assert.deepEqual(
      desc.map((p) => p.name),
      ["A-town", "B-ville", "C-city"],
    );
    assert.deepEqual(desc.map((p) => p.index), [0, 1, 2]);
    // Source identity survives the reorder.
    assert.deepEqual(desc.map((p) => p.sourceIndex), [1, 0, 2]);
  });

  it("sorts missing values last in both directions", () => {
    const withMissing = collection([
      feature({ NAME: "x" }, [0, 0]),
      feature({ NAME: "y", POP: 1 }, [0, 0]),
    ]);
    for (const sortDescending of [false, true]) {
      const pages = buildAtlasPages(withMissing, {
        nameField: "NAME",
        sortField: "POP",
        sortDescending,
      });
      assert.equal(pages[pages.length - 1].name, "x");
    }
  });

  it("applies the filter and skips features without geometry", () => {
    const mixed = collection([
      ...features,
      {
        type: "Feature",
        properties: { NAME: "no-geom", POP: 9999 },
        geometry: null,
      } as unknown as Feature,
    ]);
    const pages = buildAtlasPages(mixed, {
      nameField: "NAME",
      filter: parseAtlasFilter("POP >= 200"),
    });
    assert.deepEqual(
      pages.map((p) => p.name),
      ["B-ville", "A-town"],
    );
  });
});

describe("atlasEntryName", () => {
  it("substitutes tokens and sanitizes the result", () => {
    assert.equal(
      atlasEntryName("{atlas.pagenumber}-{atlas.name}", ctx()),
      "3-Springfield",
    );
    assert.equal(
      atlasEntryName("{atlas.attr:STATE} / {atlas.name}", ctx()),
      "IL-Springfield",
    );
  });

  it("falls back to the page number when the pattern collapses", () => {
    assert.equal(atlasEntryName("{atlas.attr:MISSING}", ctx()), "3");
    assert.equal(atlasEntryName("", ctx()), "3-Springfield");
  });
});
