import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  BUILT_IN_STYLE_PRESETS,
  DEFAULT_LAYER_STYLE,
  extractStyleLibraryStyle,
  normalizeStyleLibraryEntries,
  parseProject,
  parseStyleLibrary,
  projectFromStore,
  RAMP_STYLE_KEYS,
  sanitizeLayerStylePatch,
  serializeProject,
  serializeStyleLibrary,
  SYMBOL_STYLE_KEYS,
  useAppStore,
  type LayerStyle,
  type StyleLibraryEntry,
} from "@geolibre/core";

function entry(patch: Partial<StyleLibraryEntry> = {}): StyleLibraryEntry {
  return {
    id: "entry-a",
    name: "Entry A",
    kind: "symbol",
    tags: ["boundary"],
    style: { fillColor: "#ff0000", fillOpacity: 0.5 },
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...patch,
  };
}

describe("extractStyleLibraryStyle", () => {
  const style: LayerStyle = {
    ...DEFAULT_LAYER_STYLE,
    fillColor: "#123456",
    strokeWidth: 3,
    vectorStyleColorRamp: "plasma",
    vectorStyleClassCount: 7,
    vectorStyleProperty: "population",
    labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name" },
  };

  it("captures exactly the symbol keys for a symbol entry", () => {
    const subset = extractStyleLibraryStyle(style, "symbol");
    assert.deepEqual(Object.keys(subset).sort(), [...SYMBOL_STYLE_KEYS].sort());
    assert.equal(subset.fillColor, "#123456");
    assert.equal(subset.strokeWidth, 3);
  });

  it("captures only the labels block for a labels entry", () => {
    const subset = extractStyleLibraryStyle(style, "labels");
    assert.deepEqual(Object.keys(subset), ["labels"]);
    assert.equal(subset.labels?.enabled, true);
    assert.equal(subset.labels?.field, "name");
  });

  it("captures the ramp keys but not the data-specific property for a ramp entry", () => {
    const subset = extractStyleLibraryStyle(style, "ramp");
    assert.deepEqual(Object.keys(subset).sort(), [...RAMP_STYLE_KEYS].sort());
    assert.equal(subset.vectorStyleColorRamp, "plasma");
    assert.equal(subset.vectorStyleClassCount, 7);
    assert.equal("vectorStyleProperty" in subset, false);
  });

  it("captures the complete style, detached from the source object", () => {
    const subset = extractStyleLibraryStyle(style, "style");
    assert.equal(subset.fillColor, "#123456");
    assert.equal(subset.labels?.enabled, true);
    // Mutating the extracted copy must not touch the source labels object.
    subset.labels!.enabled = false;
    assert.equal(style.labels.enabled, true);
  });
});

describe("sanitizeLayerStylePatch", () => {
  it("drops unknown keys and type-mismatched values", () => {
    const patch = sanitizeLayerStylePatch({
      fillColor: "#ff0000",
      strokeWidth: "wide",
      bogusKey: true,
    });
    assert.deepEqual(patch, { fillColor: "#ff0000" });
  });

  it("completes a partial labels object against the defaults", () => {
    const patch = sanitizeLayerStylePatch({ labels: { enabled: true } });
    assert.equal(patch.labels?.enabled, true);
    assert.equal(patch.labels?.haloWidth, DEFAULT_LAYER_STYLE.labels.haloWidth);
    assert.equal(patch.labels?.anchor, DEFAULT_LAYER_STYLE.labels.anchor);
  });

  it("drops malformed stop and rule elements while keeping valid ones", () => {
    const patch = sanitizeLayerStylePatch({
      vectorStyleStops: [
        { value: 1, color: "#111111" },
        { value: {}, color: "#222222" },
        { color: "#333333" },
        "junk",
      ],
      vectorRules: [
        { id: "r1", label: "A", filter: "[]", color: "#111111", isElse: false },
        { id: "r2", label: "B", filter: "[]", color: "#222222" },
        null,
      ],
    });
    assert.deepEqual(patch.vectorStyleStops, [{ value: 1, color: "#111111" }]);
    assert.deepEqual(patch.vectorRules, [
      { id: "r1", label: "A", filter: "[]", color: "#111111", isElse: false },
    ]);
  });

  it("returns an empty patch for non-object input", () => {
    assert.deepEqual(sanitizeLayerStylePatch(null), {});
    assert.deepEqual(sanitizeLayerStylePatch("x"), {});
    assert.deepEqual(sanitizeLayerStylePatch([1]), {});
  });
});

describe("normalizeStyleLibraryEntries", () => {
  it("drops entries without a usable id, name, or style and de-duplicates", () => {
    const entries = normalizeStyleLibraryEntries([
      entry(),
      entry({ id: "entry-a", name: "Duplicate" }),
      entry({ id: "" }),
      entry({ id: "entry-b", name: "" }),
      entry({ id: "entry-c", style: { nothing: true } as never }),
      null,
      "junk",
    ]);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["entry-a"],
    );
    assert.equal(entries[0].name, "Entry A");
  });

  it("restricts the payload to the declared kind's key set", () => {
    const [symbol] = normalizeStyleLibraryEntries([
      entry({
        kind: "symbol",
        style: {
          fillColor: "#ff0000",
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true },
          vectorStyleColorRamp: "plasma",
        },
      }),
    ]);
    // A "Symbol only" entry must not smuggle labels or ramp fields, or
    // applying it would silently change more than symbology.
    assert.deepEqual(Object.keys(symbol.style), ["fillColor"]);

    const dropped = normalizeStyleLibraryEntries([
      entry({
        kind: "ramp",
        style: { fillColor: "#ff0000" },
      }),
    ]);
    // Nothing ramp-related survives, so the entry is dropped entirely.
    assert.equal(dropped.length, 0);
  });

  it("coerces an unknown kind to style and cleans tags", () => {
    const [normalized] = normalizeStyleLibraryEntries([
      entry({
        kind: "bogus" as never,
        tags: ["  a  ", "", "a", 7 as never, "b"],
      }),
    ]);
    assert.equal(normalized.kind, "style");
    assert.deepEqual(normalized.tags, ["a", "b"]);
  });
});

describe("style library bundles", () => {
  it("round-trips entries through serialize/parse", () => {
    const entries = [entry(), entry({ id: "entry-b", kind: "ramp", style: { vectorStyleColorRamp: "blues" } })];
    const parsed = parseStyleLibrary(serializeStyleLibrary(entries));
    assert.deepEqual(parsed, entries);
  });

  it("accepts a bare entries array", () => {
    const parsed = parseStyleLibrary(JSON.stringify([entry()]));
    assert.equal(parsed.length, 1);
  });

  it("rejects invalid JSON, foreign JSON, and empty bundles", () => {
    assert.throws(() => parseStyleLibrary("not json"));
    assert.throws(() => parseStyleLibrary('{"type":"something-else"}'));
    assert.throws(() =>
      parseStyleLibrary('{"type":"geolibre-style-library","entries":[]}'),
    );
  });
});

describe("built-in presets", () => {
  it("survive normalization unchanged (ids, kinds, and style keys are all valid)", () => {
    const normalized = normalizeStyleLibraryEntries([...BUILT_IN_STYLE_PRESETS]);
    assert.deepEqual(normalized, BUILT_IN_STYLE_PRESETS);
  });

  it("are namespaced so user entries cannot collide", () => {
    for (const preset of BUILT_IN_STYLE_PRESETS) {
      assert.ok(preset.id.startsWith("preset-"), preset.id);
    }
  });
});

describe("style library store actions", () => {
  beforeEach(() => {
    useAppStore.setState({
      styleLibrary: [],
      projectStyleLibrary: [],
      isDirty: false,
    });
  });

  it("saves to the app scope without dirtying the project", () => {
    useAppStore.getState().saveStyleLibraryEntry(entry());
    const state = useAppStore.getState();
    assert.equal(state.styleLibrary.length, 1);
    assert.equal(state.projectStyleLibrary.length, 0);
    assert.equal(state.isDirty, false);
  });

  it("upserts by id within a scope", () => {
    useAppStore.getState().saveStyleLibraryEntry(entry());
    useAppStore.getState().saveStyleLibraryEntry(entry({ name: "Renamed" }));
    const state = useAppStore.getState();
    assert.equal(state.styleLibrary.length, 1);
    assert.equal(state.styleLibrary[0].name, "Renamed");
  });

  it("saves to the project scope, marks dirty, and moves the id between scopes", () => {
    useAppStore.getState().saveStyleLibraryEntry(entry(), "project");
    let state = useAppStore.getState();
    assert.equal(state.projectStyleLibrary.length, 1);
    assert.equal(state.isDirty, true);

    useAppStore.setState({ isDirty: false });
    useAppStore.getState().saveStyleLibraryEntry(entry(), "app");
    state = useAppStore.getState();
    assert.equal(state.projectStyleLibrary.length, 0);
    assert.equal(state.styleLibrary.length, 1);
    // Moving out of the project scope changes the project file, so dirty.
    assert.equal(state.isDirty, true);
  });

  it("deletes from whichever scope holds the id and dirties only for project entries", () => {
    useAppStore.getState().saveStyleLibraryEntry(entry());
    useAppStore.setState({ isDirty: false });
    useAppStore.getState().deleteStyleLibraryEntry("entry-a");
    let state = useAppStore.getState();
    assert.equal(state.styleLibrary.length, 0);
    assert.equal(state.isDirty, false);

    useAppStore.getState().saveStyleLibraryEntry(entry(), "project");
    useAppStore.setState({ isDirty: false });
    useAppStore.getState().deleteStyleLibraryEntry("entry-a");
    state = useAppStore.getState();
    assert.equal(state.projectStyleLibrary.length, 0);
    assert.equal(state.isDirty, true);
  });
});

describe("style library project round-trip", () => {
  const baseState = {
    projectName: "Styles",
    mapView: { center: [0, 0] as [number, number], zoom: 1, bearing: 0, pitch: 0 },
    basemapStyleUrl: "https://example.com/style.json",
    basemapVisible: true,
    basemapOpacity: 1,
    layers: [],
    preferences: useAppStore.getState().preferences,
    metadata: {},
  };

  it("serializes project-scoped entries and parses them back", () => {
    const project = projectFromStore({
      ...baseState,
      styleLibrary: [entry()],
    });
    assert.equal(project.styleLibrary?.length, 1);
    const reparsed = parseProject(serializeProject(project));
    assert.deepEqual(reparsed.styleLibrary, [entry()]);
  });

  it("omits the field entirely when there are no project-scoped entries", () => {
    const project = projectFromStore({ ...baseState });
    assert.equal("styleLibrary" in project, false);
    const reparsed = parseProject(serializeProject(project));
    assert.equal("styleLibrary" in reparsed, false);
  });

  it("loadProject replaces the project scope and leaves the app library alone", () => {
    useAppStore.setState({
      styleLibrary: [entry({ id: "app-entry" })],
      projectStyleLibrary: [entry({ id: "old-project-entry" })],
    });
    const project = projectFromStore({
      ...baseState,
      styleLibrary: [entry({ id: "new-project-entry" })],
    });
    useAppStore.getState().loadProject(project);
    const state = useAppStore.getState();
    assert.deepEqual(
      state.projectStyleLibrary.map((e) => e.id),
      ["new-project-entry"],
    );
    assert.deepEqual(
      state.styleLibrary.map((e) => e.id),
      ["app-entry"],
    );
  });
});
