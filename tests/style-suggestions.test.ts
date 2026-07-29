import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  buildStyleSuggestions,
  HEATMAP_SUGGESTION_MIN_FEATURES,
} from "../apps/geolibre-desktop/src/lib/style-suggestions";

/** A minimal layer shape: the suggestion builder only reads type + geojson. */
function layerWith(
  properties: Record<string, unknown>[],
  geometryType: "Point" | "Polygon" = "Polygon",
) {
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: properties.map((props) => ({
      type: "Feature",
      geometry:
        geometryType === "Point"
          ? { type: "Point", coordinates: [0, 0] }
          : {
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
      properties: props,
    })),
  } as FeatureCollection;
  return { type: "geojson" as const, geojson };
}

const NO_POINTS = { supportsPointRenderer: false };

describe("buildStyleSuggestions", () => {
  it("suggests categorizing by a low-cardinality label", () => {
    const layer = layerWith([{ zone: "A" }, { zone: "B" }, { zone: "A" }, { zone: "C" }]);
    const suggestions = buildStyleSuggestions(layer, ["zone"], NO_POINTS);
    assert.deepEqual(suggestions, [{ kind: "categorized", property: "zone" }]);
  });

  it("suggests graduating by the numeric column with the most spread", () => {
    const layer = layerWith([
      { pop: 10, flag: 1 },
      { pop: 5000, flag: 1 },
      { pop: 120000, flag: 0 },
    ]);
    const suggestions = buildStyleSuggestions(layer, ["pop", "flag"], NO_POINTS);
    const graduated = suggestions.find((item) => item.kind === "graduated");
    assert.equal(graduated?.property, "pop");
  });

  it("offers both when a layer has a label and a measure", () => {
    const layer = layerWith([
      { zone: "A", pop: 10 },
      { zone: "B", pop: 5000 },
      { zone: "A", pop: 120000 },
    ]);
    const kinds = buildStyleSuggestions(layer, ["zone", "pop"], NO_POINTS).map((s) => s.kind);
    // Categorized first: a label needs no scale to read.
    assert.deepEqual(kinds, ["categorized", "graduated"]);
  });

  it("skips a high-cardinality column that would produce a class per feature", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: `id-${index}` }));
    const suggestions = buildStyleSuggestions(layerWith(rows), ["id"], NO_POINTS);
    assert.equal(
      suggestions.some((item) => item.kind === "categorized"),
      false,
    );
  });

  it("skips a single-valued column, which classifies to one class", () => {
    const layer = layerWith([{ kind: "same" }, { kind: "same" }, { kind: "same" }]);
    assert.deepEqual(buildStyleSuggestions(layer, ["kind"], NO_POINTS), []);
  });

  it("offers a heatmap only for a dense point layer", () => {
    const dense = Array.from({ length: HEATMAP_SUGGESTION_MIN_FEATURES }, () => ({}));
    const sparse = Array.from({ length: HEATMAP_SUGGESTION_MIN_FEATURES - 1 }, () => ({}));

    assert.ok(
      buildStyleSuggestions(layerWith(dense, "Point"), [], {
        supportsPointRenderer: true,
      }).some((item) => item.kind === "heatmap"),
    );
    assert.equal(
      buildStyleSuggestions(layerWith(sparse, "Point"), [], {
        supportsPointRenderer: true,
      }).some((item) => item.kind === "heatmap"),
      false,
    );
    // Not offered where the renderer does not apply, even when dense.
    assert.equal(
      buildStyleSuggestions(layerWith(dense), [], NO_POINTS).some(
        (item) => item.kind === "heatmap",
      ),
      false,
    );
  });

  it("returns nothing for a layer with no attributes", () => {
    assert.deepEqual(buildStyleSuggestions(layerWith([{}, {}]), [], NO_POINTS), []);
  });

  describe("columns it refuses to recommend", () => {
    it("never suggests a timestamp column, which legends as epoch numbers", () => {
      const layer = layerWith([
        { time: 1_700_000_000_000, mag: 2.5 },
        { time: 1_700_000_050_000, mag: 4.1 },
        { time: 1_700_000_090_000, mag: 6.3 },
      ]);
      const graduated = buildStyleSuggestions(layer, ["time", "mag"], NO_POINTS).find(
        (item) => item.kind === "graduated",
      );
      // `time` scores higher than `mag` on raw spread, so this only passes
      // because timestamps are excluded outright.
      assert.equal(graduated?.property, "mag");
    });

    it("never suggests a camelCase identifier or timestamp column", () => {
      // These evade a bare suffix match (no separator) and, on a small layer,
      // also evade the near-unique ratio.
      for (const name of ["featureId", "createdAt", "updatedAt", "objectId"]) {
        const layer = layerWith([
          { [name]: 1, score: 5 },
          { [name]: 2, score: 40 },
          { [name]: 3, score: 900 },
        ]);
        const graduated = buildStyleSuggestions(layer, [name, "score"], NO_POINTS).find(
          (item) => item.kind === "graduated",
        );
        assert.equal(graduated?.property, "score", name);
      }
    });

    it("keeps ordinary words that merely end in an excluded suffix", () => {
      // "grid" ends in "id" and "candidate" ends in "date"; neither is an
      // identifier, so a boundary is required rather than a bare suffix match.
      for (const name of ["grid", "candidate", "valid"]) {
        const layer = layerWith([{ [name]: 1 }, { [name]: 40 }, { [name]: 900 }]);
        const graduated = buildStyleSuggestions(layer, [name], NO_POINTS).find(
          (item) => item.kind === "graduated",
        );
        assert.equal(graduated?.property, name, name);
      }
    });

    it("never suggests a constant numeric column, which cannot form two stops", () => {
      const layer = layerWith([{ elevation: 100 }, { elevation: 100 }, { elevation: 100 }]);
      assert.deepEqual(buildStyleSuggestions(layer, ["elevation"], NO_POINTS), []);
    });

    it("never suggests an identifier column", () => {
      for (const name of ["id", "OBJECTID", "feature_id", "row-index", "uuid"]) {
        const layer = layerWith([
          { [name]: 1, score: 5 },
          { [name]: 2, score: 40 },
          { [name]: 3, score: 900 },
        ]);
        const graduated = buildStyleSuggestions(layer, [name, "score"], NO_POINTS).find(
          (item) => item.kind === "graduated",
        );
        assert.equal(graduated?.property, "score", name);
      }
    });

    it("never suggests a near-unique label column, whatever its name", () => {
      const rows = Array.from({ length: 50 }, (_, index) => ({
        ref: `bldg-${index}`,
        band: index % 4,
      }));
      const graduated = buildStyleSuggestions(layerWith(rows), ["ref", "band"], NO_POINTS).find(
        (item) => item.kind === "graduated",
      );
      assert.equal(graduated?.property, "band");
    });

    it("still suggests a near-unique *measurement*, which is what graduation is for", () => {
      // Matches the las_vegas_buildings dataset: an `id` of hashes plus a
      // `height` that is 538 distinct across 540 features. Excluding a column
      // for being near-unique would throw away the canonical choropleth —
      // distinctness cannot tell a measurement from an identifier, so only
      // non-numeric columns are judged that way.
      const rows = Array.from({ length: 50 }, (_, index) => ({
        id: `08b2986b81b34fff${index}`,
        height: 2.5 + index * 0.37,
      }));
      const suggestions = buildStyleSuggestions(layerWith(rows), ["id", "height"], NO_POINTS);
      assert.deepEqual(suggestions, [{ kind: "graduated", property: "height" }]);
    });

    it("keeps a small layer's distinct column, where the ratio proves nothing", () => {
      // 3 rows, all distinct — too small a sample to call it an identifier.
      const layer = layerWith([{ depth: 1 }, { depth: 90 }, { depth: 4000 }]);
      const graduated = buildStyleSuggestions(layer, ["depth"], NO_POINTS).find(
        (item) => item.kind === "graduated",
      );
      assert.equal(graduated?.property, "depth");
    });

    it("offers nothing rather than a meaningless column when only ids remain", () => {
      const rows = Array.from({ length: 30 }, (_, index) => ({ objectid: index }));
      assert.deepEqual(buildStyleSuggestions(layerWith(rows), ["objectid"], NO_POINTS), []);
    });
  });
});
