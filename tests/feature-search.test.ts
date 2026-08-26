import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  isSearchableLayer,
  searchLayerFeatures,
  searchableText,
} from "../apps/geolibre-desktop/src/lib/feature-search";

/** Build a point feature carrying `properties`, optionally with a stable id. */
function point(properties: Record<string, unknown>, id?: string | number): Feature {
  return {
    type: "Feature",
    ...(id === undefined ? {} : { id }),
    properties,
    geometry: { type: "Point", coordinates: [0, 0] },
  };
}

/** Build a minimal geojson store layer around `features`. */
function layer(
  id: string,
  name: string,
  features: Feature[],
  overrides: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  const geojson: FeatureCollection = { type: "FeatureCollection", features };
  return {
    id,
    name,
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    geojson,
    ...overrides,
  } as GeoLibreLayer;
}

const CITIES = layer("cities", "US Cities", [
  point({ name: "Springfield", state: "IL", pop: 116250 }),
  point({ name: "Spring Valley", state: "NV", pop: 39000 }),
  point({ name: "Chicago", state: "IL", pop: 2746000 }),
]);

describe("searchableText", () => {
  it("keeps strings and stringifies finite numbers, booleans, and bigints", () => {
    assert.equal(searchableText("well A-12"), "well A-12");
    assert.equal(searchableText(42), "42");
    assert.equal(searchableText(-0.5), "-0.5");
    assert.equal(searchableText(true), "true");
    assert.equal(searchableText(10n), "10");
  });

  it("skips values with no useful text form", () => {
    for (const value of [null, undefined, NaN, Infinity, { a: 1 }, [1, 2]]) {
      assert.equal(searchableText(value), null, `expected ${String(value)} to be skipped`);
    }
  });
});

describe("isSearchableLayer", () => {
  it("accepts a visible layer carrying features", () => {
    assert.equal(isSearchableLayer(CITIES), true);
  });

  it("skips hidden layers and layers with no local features", () => {
    assert.equal(
      isSearchableLayer(
        layer("h", "Hidden", CITIES.geojson!.features, {
          visible: false,
        }),
      ),
      false,
    );
    // A tile-backed layer holds nothing in the store.
    assert.equal(isSearchableLayer(layer("tiles", "Basemap", [], { type: "vector-tiles" })), false);
    assert.equal(isSearchableLayer(layer("empty", "Empty", [])), false);
  });
});

describe("searchLayerFeatures — matching", () => {
  it("matches any string or numeric field, case-insensitively", () => {
    const byName = searchLayerFeatures([CITIES], "chicago");
    assert.equal(byName.length, 1);
    assert.equal(byName[0].matches.length, 1);
    assert.equal(byName[0].matches[0].field, "name");
    assert.equal(byName[0].matches[0].value, "Chicago");

    const byNumber = searchLayerFeatures([CITIES], "2746000");
    assert.equal(byNumber[0].matches[0].field, "pop");
  });

  it("labels the group with the layer and carries the selection id", () => {
    const [group] = searchLayerFeatures([CITIES], "springfield");
    assert.equal(group.layerId, "cities");
    assert.equal(group.layerName, "US Cities");
    // No feature id on the source feature, so the index is the selection id.
    assert.equal(group.matches[0].featureId, "0");
    assert.equal(group.matches[0].kind, "exact");
  });

  it("prefers an explicit feature id over the index", () => {
    const wells = layer("wells", "Wells", [point({ name: "Alpha" }, "well-7")]);
    const [group] = searchLayerFeatures([wells], "alpha");
    assert.equal(group.matches[0].featureId, "well-7");
  });

  it("ranks exact before prefix before contains", () => {
    const codes = layer("codes", "Codes", [
      point({ code: "unspring" }),
      point({ code: "springfield" }),
      point({ code: "spring" }),
    ]);
    const [group] = searchLayerFeatures([codes], "spring");
    assert.deepEqual(
      group.matches.map((match) => match.value),
      ["spring", "springfield", "unspring"],
    );
    assert.deepEqual(
      group.matches.map((match) => match.kind),
      ["exact", "prefix", "contains"],
    );
  });

  it("puts the shorter value first within a rank", () => {
    const countries = layer("countries", "Countries", [
      point({ name: "Indonesia" }),
      point({ name: "India" }),
      point({ name: "Indeterminate" }),
    ]);
    const [group] = searchLayerFeatures([countries], "ind");
    assert.deepEqual(
      group.matches.map((match) => match.value),
      ["India", "Indonesia", "Indeterminate"],
    );
  });

  it("reports a feature once, on its best-ranked field", () => {
    const dup = layer("dup", "Dup", [point({ code: "A12-extra", label: "A12" })]);
    const [group] = searchLayerFeatures([dup], "a12");
    assert.equal(group.matches.length, 1);
    assert.equal(group.matches[0].kind, "exact");
    assert.equal(group.matches[0].field, "label");
  });

  it("returns nothing for a query shorter than the minimum", () => {
    assert.deepEqual(searchLayerFeatures([CITIES], "c"), []);
    assert.deepEqual(searchLayerFeatures([CITIES], "  "), []);
  });

  it("returns nothing when no layer matches", () => {
    assert.deepEqual(searchLayerFeatures([CITIES], "reykjavik"), []);
  });
});

describe("searchLayerFeatures — field visibility", () => {
  it("skips fields marked hidden or excluded", () => {
    const secret = layer("secret", "Secret", [point({ owner: "Ada", ssn: "Ada-123" })], {
      fieldVisibility: { owner: "hidden" },
    });
    assert.deepEqual(searchLayerFeatures([secret], "ada")[0].matches[0].field, "ssn");

    const gone = layer("gone", "Gone", [point({ owner: "Ada" })], {
      fieldVisibility: { owner: "excluded" },
    });
    assert.deepEqual(searchLayerFeatures([gone], "ada"), []);
  });
});

describe("searchLayerFeatures — group visibility", () => {
  it("skips a visible layer whose parent group is hidden", () => {
    const grouped = layer("grouped", "Grouped", [point({ name: "Site A" })], {
      groupId: "g1",
    });
    const groups = [
      { id: "g1", name: "Group", visible: false, opacity: 1 },
    ] as unknown as Parameters<typeof searchLayerFeatures>[2]["groups"];
    assert.equal(searchLayerFeatures([grouped], "site").length, 1);
    assert.deepEqual(searchLayerFeatures([grouped], "site", { groups }), []);
  });

  it("keeps a layer whose parent group is visible", () => {
    const grouped = layer("grouped", "Grouped", [point({ name: "Site A" })], {
      groupId: "g1",
    });
    const groups = [
      { id: "g1", name: "Group", visible: true, opacity: 1 },
    ] as unknown as Parameters<typeof searchLayerFeatures>[2]["groups"];
    assert.equal(searchLayerFeatures([grouped], "site", { groups }).length, 1);
  });
});

describe("searchLayerFeatures — caps", () => {
  it("caps rows per layer and flags the group as partial", () => {
    const many = layer(
      "many",
      "Many",
      Array.from({ length: 20 }, (_, i) => point({ name: `Site ${i}` })),
    );
    const [group] = searchLayerFeatures([many], "site", { maxPerLayer: 3 });
    assert.equal(group.matches.length, 3);
  });

  it("stops at the feature ceiling and marks the group truncated", () => {
    const many = layer(
      "many",
      "Many",
      Array.from({ length: 100 }, (_, i) => point({ name: `Site ${i}` })),
    );
    const [group] = searchLayerFeatures([many], "site", {
      maxPerLayer: 50,
      maxFeaturesPerLayer: 10,
    });
    assert.equal(group.truncated, true);
    assert.equal(group.matches.length, 10);
  });

  it("stops when the per-layer time budget is spent", () => {
    const many = layer(
      "many",
      "Many",
      Array.from({ length: 5000 }, (_, i) => point({ name: `Site ${i}` })),
    );
    // A clock that jumps a second per read blows the budget at the first check.
    // The call-wide budget is left generous so this exercises the per-layer one.
    let ticks = 0;
    const [group] = searchLayerFeatures([many], "site", {
      maxPerLayer: 5000,
      layerBudgetMs: 10,
      totalBudgetMs: 100_000,
      now: () => (ticks += 1000),
    });
    assert.equal(group.truncated, true);
    assert.ok(group.matches.length < 5000);
  });

  it("stops scanning further layers once the whole call's budget is spent", () => {
    const layers = Array.from({ length: 6 }, (_, i) =>
      layer(`l${i}`, `Layer ${i}`, [point({ name: "Site A" })]),
    );
    // A clock that jumps 50ms per read exhausts a 120ms total budget quickly,
    // whatever the per-layer budget allows.
    let ticks = 0;
    const groups = searchLayerFeatures(layers, "site", {
      maxLayers: 6,
      totalBudgetMs: 120,
      now: () => (ticks += 50),
    });
    assert.ok(groups.length > 0);
    assert.ok(groups.length < 6, `expected fewer than 6 groups, got ${groups.length}`);
  });

  it("caps the number of layers reported", () => {
    const layers = Array.from({ length: 6 }, (_, i) =>
      layer(`l${i}`, `Layer ${i}`, [point({ name: "Site A" })]),
    );
    assert.equal(searchLayerFeatures(layers, "site", { maxLayers: 2 }).length, 2);
  });

  it("scans each layer independently, so one big layer cannot starve the rest", () => {
    const big = layer(
      "big",
      "Big",
      Array.from({ length: 5000 }, (_, i) => point({ name: `Site ${i}` })),
    );
    const small = layer("small", "Small", [point({ name: "Site zzz" })]);
    const groups = searchLayerFeatures([big, small], "site", {
      maxFeaturesPerLayer: 10,
      maxPerLayer: 3,
      totalBudgetMs: 100_000,
    });
    assert.deepEqual(
      groups.map((group) => group.layerId),
      ["big", "small"],
    );
    assert.equal(groups[1].truncated, false);
  });
});
