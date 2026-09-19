import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "../packages/map/src/map-engine";
import { applySelectionHighlight, resolveHighlightIds } from "../packages/map/src/map-selection";
import { geojsonLayer } from "./helpers/layer-fixtures";

describe("map selection highlight", () => {
  it("prefers the multi-selection over its anchor", () => {
    assert.deepEqual(
      resolveHighlightIds({
        selectedFeatureId: "anchor",
        selectedFeatureIds: ["a", "b"],
      }),
      ["a", "b"],
    );
    assert.deepEqual(
      resolveHighlightIds({
        selectedFeatureId: "anchor",
        selectedFeatureIds: [],
      }),
      ["anchor"],
    );
  });

  it("fits only when an enabled selection key changes", () => {
    const layer = geojsonLayer();
    const calls: Array<{
      layer: GeoLibreLayer | undefined;
      ids: string | string[] | null;
      fit: boolean | undefined;
    }> = [];
    const engine = {
      highlightFeature: (
        selectedLayer: GeoLibreLayer | undefined,
        ids: string | string[] | null,
        options?: { fit?: boolean },
      ) => calls.push({ layer: selectedLayer, ids, fit: options?.fit }),
    } as unknown as MapEngine;

    const key = applySelectionHighlight(
      engine,
      [layer],
      layer.id,
      "a",
      ["a", "b"],
      true,
      null,
      false,
    );
    assert.equal(key, JSON.stringify([layer.id, ["a", "b"]]));
    assert.deepEqual(calls.at(-1), { layer, ids: ["a", "b"], fit: true });

    applySelectionHighlight(engine, [layer], layer.id, "a", ["a", "b"], true, key, false);
    assert.equal(calls.at(-1)?.fit, false);
  });

  it("refits when ids differ only by where a delimiter falls", () => {
    const layer = geojsonLayer();
    let fit: boolean | undefined;
    const engine = {
      highlightFeature: (
        _layer: GeoLibreLayer | undefined,
        _ids: string | string[] | null,
        options?: { fit?: boolean }
      ) => {
        fit = options?.fit;
      },
    } as unknown as MapEngine;

    const key = applySelectionHighlight(
      engine,
      [layer],
      layer.id,
      "a\u0000b",
      ["a\u0000b"],
      true,
      null,
      false
    );
    const nextKey = applySelectionHighlight(
      engine,
      [layer],
      layer.id,
      "a",
      ["a", "b"],
      true,
      key,
      false
    );
    assert.notEqual(nextKey, key);
    assert.equal(fit, true);
  });

  it("does not fit while restoring an identify selection", () => {
    const layer = geojsonLayer();
    let fit: boolean | undefined;
    const engine = {
      highlightFeature: (
        _layer: GeoLibreLayer | undefined,
        _ids: string | string[] | null,
        options?: { fit?: boolean },
      ) => {
        fit = options?.fit;
      },
    } as unknown as MapEngine;

    applySelectionHighlight(engine, [layer], layer.id, "a", [], true, null, true);
    assert.equal(fit, false);
  });

  it("clears the highlight and key when no feature is selected", () => {
    const layer = geojsonLayer();
    let ids: string | string[] | null = "not-cleared";
    const engine = {
      highlightFeature: (_layer: GeoLibreLayer | undefined, nextIds: string | string[] | null) => {
        ids = nextIds;
      },
    } as unknown as MapEngine;

    const key = applySelectionHighlight(
      engine,
      [layer],
      layer.id,
      null,
      [],
      true,
      `${layer.id}:a`,
      false,
    );
    assert.equal(key, null);
    assert.equal(ids, null);
  });
});
