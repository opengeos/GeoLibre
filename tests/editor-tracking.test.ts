import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Feature, FeatureCollection } from "geojson";
import {
  DEFAULT_EDITOR_IDENTITY,
  DEFAULT_EDITOR_TRACKING_CONFIG,
  editorTrackingFieldNames,
  ensureEditorTrackingFields,
  isMaintainedEditorTrackingField,
  pickEditorIdentity,
  resolveEditorTrackingConfig,
  stampFeatureCollectionEditorTracking,
  stampFeatureEditorTracking,
  stampFeaturePropertiesEditorTracking,
} from "../packages/core/src/editor-tracking";

describe("editor-tracking", () => {
  it("resolveEditorTrackingConfig provides correct defaults when empty", () => {
    const resolved = resolveEditorTrackingConfig();
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.createdByField, "created_by");
    assert.equal(resolved.createdAtField, "created_at");
    assert.equal(resolved.editedByField, "edited_by");
    assert.equal(resolved.editedAtField, "edited_at");
  });

  it("resolveEditorTrackingConfig throws on invalid configurations", () => {
    assert.throws(() => {
      resolveEditorTrackingConfig({ enabled: true, createdAtField: "same", editedAtField: "same" });
    }, /non-empty and unique/);

    assert.throws(() => {
      resolveEditorTrackingConfig({ enabled: true, createdByField: "   " });
    }, /non-empty and unique/);
  });

  it("isMaintainedEditorTrackingField correctly identifies tracking columns", () => {
    const config = { enabled: true };
    assert.equal(isMaintainedEditorTrackingField("created_by", config), true);
    assert.equal(isMaintainedEditorTrackingField("created_at", config), true);
    assert.equal(isMaintainedEditorTrackingField("edited_by", config), true);
    assert.equal(isMaintainedEditorTrackingField("edited_at", config), true);
    assert.equal(isMaintainedEditorTrackingField("name", config), false);
    assert.equal(isMaintainedEditorTrackingField("population", config), false);

    assert.equal(isMaintainedEditorTrackingField("created_by", { enabled: false }), false);

    const customConfig = {
      enabled: true,
      createdByField: "author",
      createdAtField: "created_time",
      editedByField: "modifier",
      editedAtField: "modified_time",
    };
    assert.equal(isMaintainedEditorTrackingField("author", customConfig), true);
    assert.equal(isMaintainedEditorTrackingField("created_by", customConfig), false);
  });

  it("trims field names so they cannot become padded property keys", () => {
    const resolved = resolveEditorTrackingConfig({ enabled: true, createdByField: "  author  " });
    assert.equal(resolved.createdByField, "author");

    const stamped = stampFeaturePropertiesEditorTracking({}, "create", {
      config: { enabled: true, createdByField: "  author  " },
      userIdentity: "alice",
      timestamp: "2026-08-14T12:00:00.000Z",
    });
    assert.equal(stamped.author, "alice");
    assert.equal("  author  " in stamped, false);
  });

  it("does not validate the field names of a disabled config", () => {
    // A half-filled or hand-edited config left behind on a layer with tracking
    // off must not make every save on that layer throw: nothing is written, so
    // the names cannot matter.
    assert.doesNotThrow(() =>
      resolveEditorTrackingConfig({ enabled: false, createdByField: "", editedByField: "" }),
    );
    assert.deepEqual(
      stampFeaturePropertiesEditorTracking({ id: 1 }, "update", {
        config: { enabled: false, createdAtField: "same", editedAtField: "same" },
      }),
      { id: 1 },
    );
  });

  it("query helpers degrade to disabled instead of throwing on an invalid config", () => {
    // A half-filled settings form or a hand-edited project must not crash the
    // Attribute Table / Field Calculator, which call these once per field.
    const blank = { enabled: true, createdByField: "  " };
    const duplicate = { enabled: true, createdAtField: "same", editedAtField: "same" };

    assert.equal(isMaintainedEditorTrackingField("created_at", blank), false);
    assert.equal(isMaintainedEditorTrackingField("same", duplicate), false);
    assert.deepEqual(ensureEditorTrackingFields(["id"], blank), ["id"]);
    assert.deepEqual(ensureEditorTrackingFields(["id"], duplicate), ["id"]);

    // The stamping path still surfaces the misconfiguration.
    assert.throws(
      () => stampFeaturePropertiesEditorTracking({ id: 1 }, "create", { config: blank }),
      /non-empty and unique/,
    );
  });

  it("ensureEditorTrackingFields adds fields when tracking is enabled", () => {
    const initialFields = ["id", "name"];
    const disabledResult = ensureEditorTrackingFields(initialFields, { enabled: false });
    assert.deepEqual(disabledResult, ["id", "name"]);

    const enabledResult = ensureEditorTrackingFields(initialFields, { enabled: true });
    assert.deepEqual(enabledResult, [
      "id",
      "name",
      "created_by",
      "created_at",
      "edited_by",
      "edited_at",
    ]);

    // Avoid duplicate field entries
    const existingResult = ensureEditorTrackingFields(["id", "created_by", "name"], {
      enabled: true,
    });
    assert.deepEqual(existingResult, [
      "id",
      "created_by",
      "name",
      "created_at",
      "edited_by",
      "edited_at",
    ]);
  });

  it("stampFeaturePropertiesEditorTracking creates timestamp and author on action='create'", () => {
    const props = { name: "Park", area: 50 };
    const stamped = stampFeaturePropertiesEditorTracking(props, "create", {
      config: { enabled: true },
      userIdentity: "alice",
      timestamp: "2026-08-14T12:00:00.000Z",
    });

    assert.equal(stamped.name, "Park");
    assert.equal(stamped.area, 50);
    assert.equal(stamped.created_by, "alice");
    assert.equal(stamped.created_at, "2026-08-14T12:00:00.000Z");
    assert.equal(stamped.edited_by, "alice");
    assert.equal(stamped.edited_at, "2026-08-14T12:00:00.000Z");
  });

  it("create overwrites a creation stamp copied from another feature", () => {
    // Reachable two ways: the geometry editor's copy action clones a tracked
    // feature's properties, and a Field Collection form can define a capture
    // field whose key is a tracking column. Either would otherwise credit a
    // brand-new feature to whoever created the thing it came from.
    const copied = {
      name: "duplicate",
      created_by: "bob",
      created_at: "2020-01-01T00:00:00.000Z",
    };
    const stamped = stampFeaturePropertiesEditorTracking(copied, "create", {
      config: { enabled: true },
      userIdentity: "ada",
      timestamp: "2026-08-16T12:00:00.000Z",
    });
    assert.deepEqual(stamped, {
      name: "duplicate",
      created_by: "ada",
      created_at: "2026-08-16T12:00:00.000Z",
      edited_by: "ada",
      edited_at: "2026-08-16T12:00:00.000Z",
    });
  });

  it("stampFeaturePropertiesEditorTracking updates edit info and preserves creation info on action='update'", () => {
    const props = {
      name: "Park",
      created_by: "alice",
      created_at: "2026-08-14T12:00:00.000Z",
      edited_by: "alice",
      edited_at: "2026-08-14T12:00:00.000Z",
    };

    const stamped = stampFeaturePropertiesEditorTracking(props, "update", {
      config: { enabled: true },
      userIdentity: "bob",
      timestamp: "2026-08-14T15:30:00.000Z",
    });

    assert.equal(stamped.created_by, "alice");
    assert.equal(stamped.created_at, "2026-08-14T12:00:00.000Z");
    assert.equal(stamped.edited_by, "bob");
    assert.equal(stamped.edited_at, "2026-08-14T15:30:00.000Z");
  });

  it("stampFeatureEditorTracking and stampFeatureCollectionEditorTracking work on GeoJSON features", () => {
    const feature: Feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { label: "Tree" },
    };

    const stampedFeat = stampFeatureEditorTracking(feature, "create", {
      config: { enabled: true },
      userIdentity: "charlie",
      timestamp: "2026-08-14T10:00:00.000Z",
    });

    assert.equal(stampedFeat.properties?.created_by, "charlie");
    assert.equal(stampedFeat.properties?.edited_by, "charlie");

    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [feature],
    };

    const stampedColl = stampFeatureCollectionEditorTracking(collection, "update", {
      config: { enabled: true },
      userIdentity: "dave",
      timestamp: "2026-08-14T18:00:00.000Z",
    });

    assert.equal(stampedColl.features[0].properties?.edited_by, "dave");
    assert.equal(stampedColl.features[0].properties?.edited_at, "2026-08-14T18:00:00.000Z");
  });

  it("does nothing when enabled is false", () => {
    const props = { name: "Lake" };
    const stamped = stampFeaturePropertiesEditorTracking(props, "create", {
      config: { enabled: false },
    });
    assert.deepEqual(stamped, { name: "Lake" });
  });
});

describe("pickEditorIdentity", () => {
  it("prefers the collaboration session's name", () => {
    // Everyone else in the session sees the same edits attributed to that name,
    // so it has to win over whatever this browser was configured with.
    assert.equal(pickEditorIdentity("Ada (session)", "ada-local"), "Ada (session)");
  });

  it("falls back to the locally configured name", () => {
    assert.equal(pickEditorIdentity(undefined, "ada-local"), "ada-local");
    assert.equal(pickEditorIdentity("   ", "ada-local"), "ada-local");
  });

  it("falls back to the anonymous default", () => {
    assert.equal(pickEditorIdentity(), DEFAULT_EDITOR_IDENTITY);
    assert.equal(pickEditorIdentity(null, "  "), DEFAULT_EDITOR_IDENTITY);
  });

  it("trims the name it returns", () => {
    assert.equal(pickEditorIdentity(" Ada "), "Ada");
  });
});

describe("editorTrackingFieldNames", () => {
  it("lists the maintained columns, creation first", () => {
    assert.deepEqual(editorTrackingFieldNames({ enabled: true }), [
      "created_by",
      "created_at",
      "edited_by",
      "edited_at",
    ]);
  });

  it("honors renamed columns", () => {
    assert.deepEqual(editorTrackingFieldNames({ enabled: true, createdByField: "author" }), [
      "author",
      "created_at",
      "edited_by",
      "edited_at",
    ]);
  });

  it("reports nothing for a disabled, absent, or unusable configuration", () => {
    assert.equal(editorTrackingFieldNames(), null);
    assert.equal(editorTrackingFieldNames({ enabled: false }), null);
    assert.equal(editorTrackingFieldNames({ enabled: true, createdByField: "  " }), null);
    assert.equal(
      editorTrackingFieldNames({ enabled: true, createdAtField: "x", editedAtField: "x" }),
      null,
    );
  });
});
