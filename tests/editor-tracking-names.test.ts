import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EDITOR_TRACKING_NAMES,
  editorTrackingNameProblem,
  type EditorTrackingFieldKey,
} from "../apps/geolibre-desktop/src/lib/editor-tracking-names";

function names(overrides: Partial<Record<EditorTrackingFieldKey, string>> = {}) {
  return { ...DEFAULT_EDITOR_TRACKING_NAMES, ...overrides };
}

describe("editorTrackingNameProblem", () => {
  it("accepts the defaults against an unrelated layer", () => {
    assert.equal(editorTrackingNameProblem(names(), new Set(["name", "population"])), null);
  });

  it("rejects a blank name", () => {
    assert.deepEqual(editorTrackingNameProblem(names({ editedAtField: "   " }), new Set()), {
      reason: "blankName",
    });
  });

  it("rejects two columns sharing a name", () => {
    assert.deepEqual(
      editorTrackingNameProblem(names({ editedByField: "x", editedAtField: "x" }), new Set()),
      { reason: "duplicateName" },
    );
  });

  it("rejects a name that already holds real attribute values", () => {
    // A tracking column is written unconditionally on every stamp, so this
    // would overwrite the layer's `population` values feature by feature with
    // no warning — and none of the protection `renameColumn` gives an ordinary
    // column, since the config is written straight to the store.
    assert.deepEqual(
      editorTrackingNameProblem(
        names({ editedAtField: "population" }),
        new Set(["name", "population"]),
      ),
      { reason: "columnTaken", name: "population" },
    );
  });

  it("reports the blank and duplicate problems before the collision", () => {
    // Blank and duplicate are about the set itself, so they are the more
    // actionable message when both apply.
    assert.deepEqual(
      editorTrackingNameProblem(names({ editedAtField: "" }), new Set(["created_by"])),
      { reason: "blankName" },
    );
  });

  it("accepts a name the caller has excluded as already maintained", () => {
    // The panel removes the columns tracking already writes before calling
    // this, so keeping a renamed column's own name is not a collision, and a
    // layer that already has a `created_by` column is taken over by the
    // identically-named default rather than being refused.
    assert.equal(editorTrackingNameProblem(names(), new Set(["name"])), null);
    assert.deepEqual(editorTrackingNameProblem(names(), new Set(["name", "created_by"])), {
      reason: "columnTaken",
      name: "created_by",
    });
  });

  it("trims before comparing, matching the resolver", () => {
    assert.deepEqual(
      editorTrackingNameProblem(
        names({ editedAtField: "  population  " }),
        new Set(["population"]),
      ),
      { reason: "columnTaken", name: "population" },
    );
  });
});
