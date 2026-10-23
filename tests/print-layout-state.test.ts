import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDefaultPrintLayout,
  printLayoutConfigsEqual,
  type PrintLayoutConfig,
} from "../packages/core/src/print-layout-config";
import {
  CONTROLS_DEFAULT_WIDTH,
  CONTROLS_MAX_WIDTH,
  CONTROLS_MIN_WIDTH,
  createPrintLayoutState,
  customLegendSeqFor,
  parseLegendDict,
  printLayoutReducer,
  type PrintLayoutAction,
  type PrintLayoutState,
} from "../apps/geolibre-desktop/src/components/layout/print-layout/state";
import type { CapturedMap } from "../apps/geolibre-desktop/src/lib/print-layout-export";

// The Print Layout composer keeps its state in one reducer (GH #2633). The
// dialog pushes `state.layout` into the project on every change, so these
// tests pin both the multi-field transitions the dialog used to spread across
// several setters and the invariant that the persisted shape never changes.

/** A fresh state seeded from the default layout, with optional overrides. */
function stateWith(overrides: Partial<PrintLayoutConfig> = {}): PrintLayoutState {
  return createPrintLayoutState({ ...createDefaultPrintLayout(), ...overrides });
}

/** Apply a sequence of actions. */
function run(state: PrintLayoutState, ...actions: PrintLayoutAction[]): PrintLayoutState {
  return actions.reduce(printLayoutReducer, state);
}

const fakeCapture = (width = 100): CapturedMap => ({
  image: {} as HTMLCanvasElement,
  width,
  height: 50,
  metersPerPixel: 2,
  pixelRatio: 1,
  bearingDeg: 0,
});

describe("createPrintLayoutState", () => {
  it("keeps the stored layout object so the first push to the store is a no-op", () => {
    const stored = createDefaultPrintLayout();
    const state = createPrintLayoutState(stored);
    assert.equal(state.layout, stored);
  });

  it("starts the session-only state blank", () => {
    const state = stateWith({ mapBackground: "#123456" });
    assert.equal(state.mapBackgroundDraft, "#123456");
    assert.equal(state.captured, null);
    assert.equal(state.error, null);
    assert.equal(state.atlasIndex, 0);
    assert.equal(state.atlasBusy, false);
    assert.equal(state.exporting, false);
    assert.equal(state.copied, false);
    assert.equal(state.scaleDraft, "");
    assert.equal(state.mapFit, "cover");
    assert.equal(state.controlsWidth, CONTROLS_DEFAULT_WIDTH);
    assert.equal(state.dialogSize, null);
  });

  it("seeds the custom-legend id counter past the restored ids", () => {
    assert.equal(customLegendSeqFor([]), 0);
    assert.equal(
      customLegendSeqFor([
        { id: "cl-1", label: "a", color: "#000" },
        { id: "cl-7", label: "b", color: "#000" },
      ]),
      7,
    );
    // Non-numeric ids never go below the entry count.
    assert.equal(
      customLegendSeqFor([
        { id: "x", label: "a", color: "#000" },
        { id: "y", label: "b", color: "#000" },
      ]),
      2,
    );
  });
});

describe("printLayoutReducer: persisted shape", () => {
  it("keeps exactly the PrintLayoutConfig keys through every layout action", () => {
    const keys = Object.keys(createDefaultPrintLayout()).sort();
    const end = run(
      stateWith(),
      { type: "setLayout", patch: { title: "T", paperSize: "a3" } },
      { type: "setCustomSize", width: 10 },
      { type: "commitMapBackground", value: "#abcdef" },
      { type: "setAtlasEnabled", enabled: true },
      { type: "selectAtlasLayer", layerId: "l1" },
      { type: "setAtlasCoverage", coverage: "line" },
      { type: "selectTableLayer", layerId: "l2" },
      { type: "selectChartLayer", layerId: "l3" },
      { type: "addCustomLegendEntry" },
      { type: "extentDrawn", extent: [0, 0, 1, 1] },
      { type: "setCaptureMode", mode: "viewport" },
      { type: "extentCleared" },
    );
    assert.deepEqual(Object.keys(end.layout).sort(), keys);
  });

  it("returns the same state object when an action changes nothing", () => {
    const state = stateWith({ title: "Same" });
    assert.equal(printLayoutReducer(state, { type: "setLayout", patch: { title: "Same" } }), state);
    assert.equal(printLayoutReducer(state, { type: "setUi", patch: { error: null } }), state);
    assert.equal(printLayoutReducer(state, { type: "dialogOpened" }), state);
    assert.equal(printLayoutReducer(state, { type: "setCaptureMode", mode: "viewport" }), state);
  });

  it("leaves the layout object untouched on session-only actions", () => {
    const state = stateWith();
    const next = run(
      state,
      { type: "setUi", patch: { exporting: true, scaleDraft: "5000" } },
      { type: "captureSucceeded", captured: fakeCapture() },
      { type: "setControlsWidth", width: 400 },
    );
    assert.equal(next.layout, state.layout);
  });
});

describe("printLayoutReducer: page size and orientation", () => {
  it("changes the paper size and orientation", () => {
    const next = run(
      stateWith(),
      { type: "setLayout", patch: { paperSize: "letter" } },
      { type: "setLayout", patch: { orientation: "portrait" } },
    );
    assert.equal(next.layout.paperSize, "letter");
    assert.equal(next.layout.orientation, "portrait");
  });

  it("floors a custom page's sides at 1", () => {
    const next = run(
      stateWith({ paperSize: "custom" }),
      { type: "setCustomSize", width: 0 },
      { type: "setCustomSize", height: -5 },
    );
    assert.equal(next.layout.customWidth, 1);
    assert.equal(next.layout.customHeight, 1);
    const sized = run(next, { type: "setCustomSize", width: 300, height: 200 });
    assert.equal(sized.layout.customWidth, 300);
    assert.equal(sized.layout.customHeight, 200);
  });
});

describe("printLayoutReducer: map frame", () => {
  it("commits only complete hex map backgrounds but always keeps the draft", () => {
    const partial = run(stateWith({ mapBackground: "#e5e7eb" }), {
      type: "commitMapBackground",
      value: "#12",
    });
    assert.equal(partial.mapBackgroundDraft, "#12");
    assert.equal(partial.layout.mapBackground, "#e5e7eb");
    const full = run(partial, { type: "commitMapBackground", value: " #123 " });
    assert.equal(full.mapBackgroundDraft, " #123 ");
    assert.equal(full.layout.mapBackground, "#123");
  });

  it("switches to the extent when one is drawn and back when cleared", () => {
    const drawn = run(stateWith(), { type: "extentDrawn", extent: [1, 2, 3, 4] });
    assert.deepEqual(drawn.layout.extentBbox, [1, 2, 3, 4]);
    assert.equal(drawn.layout.captureMode, "extent");
    const cleared = run(drawn, { type: "extentCleared" });
    assert.equal(cleared.layout.extentBbox, null);
    assert.equal(cleared.layout.captureMode, "viewport");
  });

  it("clears the scale notice when switching to extent mode only", () => {
    const withNotice = run(stateWith({ extentBbox: [0, 0, 1, 1] }), {
      type: "setUi",
      patch: { scaleNotice: "out of range" },
    });
    const toExtent = run(withNotice, { type: "setCaptureMode", mode: "extent" });
    assert.equal(toExtent.layout.captureMode, "extent");
    assert.equal(toExtent.scaleNotice, null);
    const back = run(
      toExtent,
      { type: "setUi", patch: { scaleNotice: "again" } },
      { type: "setCaptureMode", mode: "viewport" },
    );
    assert.equal(back.layout.captureMode, "viewport");
    assert.equal(back.scaleNotice, "again");
  });
});

describe("printLayoutReducer: dialog session", () => {
  it("clears the error, scale notice and Copied flag on open", () => {
    const stale = run(stateWith(), {
      type: "setUi",
      patch: { error: "boom", scaleNotice: "range", copied: true, scaleDraft: "10" },
    });
    const opened = run(stale, { type: "dialogOpened" });
    assert.equal(opened.error, null);
    assert.equal(opened.scaleNotice, null);
    assert.equal(opened.copied, false);
    // Only the notices reset: the composed layout and other drafts persist.
    assert.equal(opened.scaleDraft, "10");
    assert.equal(opened.layout, stale.layout);
  });

  it("records a capture and clears the error, or clears the capture on failure", () => {
    const cap = fakeCapture();
    const ok = run(
      stateWith(),
      { type: "setUi", patch: { error: "old" } },
      { type: "captureSucceeded", captured: cap },
    );
    assert.equal(ok.captured, cap);
    assert.equal(ok.error, null);
    const failed = run(ok, { type: "captureFailed", error: "nope" });
    assert.equal(failed.captured, null);
    assert.equal(failed.error, "nope");
  });

  it("clamps the controls column width when dragged or nudged", () => {
    const state = stateWith();
    assert.equal(
      run(state, { type: "setControlsWidth", width: 10 }).controlsWidth,
      CONTROLS_MIN_WIDTH,
    );
    assert.equal(
      run(state, { type: "setControlsWidth", width: 9999 }).controlsWidth,
      CONTROLS_MAX_WIDTH,
    );
    assert.equal(
      run(state, { type: "nudgeControlsWidth", delta: 8 }).controlsWidth,
      CONTROLS_DEFAULT_WIDTH + 8,
    );
    assert.equal(
      run(state, { type: "nudgeControlsWidth", delta: -1000 }).controlsWidth,
      CONTROLS_MIN_WIDTH,
    );
  });

  it("resizes the dialog", () => {
    const next = run(stateWith(), {
      type: "setUi",
      patch: { dialogSize: { width: 900, height: 700 } },
    });
    assert.deepEqual(next.dialogSize, { width: 900, height: 700 });
  });
});

describe("printLayoutReducer: atlas", () => {
  it("restarts the series from the first page when enabled, not when disabled", () => {
    const onPage = run(stateWith(), { type: "setUi", patch: { atlasIndex: 4 } });
    const enabled = run(onPage, { type: "setAtlasEnabled", enabled: true });
    assert.equal(enabled.layout.atlasEnabled, true);
    assert.equal(enabled.atlasIndex, 0);
    const paged = run(enabled, { type: "setUi", patch: { atlasIndex: 3 } });
    const disabled = run(paged, { type: "setAtlasEnabled", enabled: false });
    assert.equal(disabled.layout.atlasEnabled, false);
    assert.equal(disabled.atlasIndex, 3);
  });

  it("drops the old layer's name/sort fields and restarts when the coverage layer changes", () => {
    const configured = run(
      stateWith({ atlasLayerId: "a", atlasNameField: "NAME", atlasSortField: "POP" }),
      { type: "setUi", patch: { atlasIndex: 5 } },
    );
    const next = run(configured, { type: "selectAtlasLayer", layerId: "b" });
    assert.equal(next.layout.atlasLayerId, "b");
    assert.equal(next.layout.atlasNameField, "");
    assert.equal(next.layout.atlasSortField, "");
    assert.equal(next.atlasIndex, 0);
  });

  it("restarts the series when the coverage strategy changes", () => {
    const next = run(
      stateWith(),
      { type: "setUi", patch: { atlasIndex: 2 } },
      { type: "setAtlasCoverage", coverage: "line" },
    );
    assert.equal(next.layout.atlasCoverage, "line");
    assert.equal(next.atlasIndex, 0);
  });

  it("keeps plain atlas settings as typed", () => {
    const next = run(stateWith(), {
      type: "setLayout",
      patch: {
        atlasExtentMode: "scale",
        atlasScale: "25000",
        atlasMarginPct: 20,
        atlasFilter: "POP > 10",
        atlasFilenamePattern: "{name}",
        atlasSortDescending: true,
        atlasMaskEnabled: true,
      },
    });
    assert.equal(next.layout.atlasExtentMode, "scale");
    assert.equal(next.layout.atlasScale, "25000");
    assert.equal(next.layout.atlasMarginPct, 20);
    assert.equal(next.layout.atlasFilter, "POP > 10");
    assert.equal(next.layout.atlasFilenamePattern, "{name}");
    assert.equal(next.layout.atlasSortDescending, true);
    assert.equal(next.layout.atlasMaskEnabled, true);
  });

  it("moves the preview to a captured page", () => {
    const cap = fakeCapture(321);
    const next = run(stateWith(), {
      type: "atlasPageCaptured",
      captured: cap,
      index: 3,
      bounds: [0, 1, 2, 3],
    });
    assert.equal(next.captured, cap);
    assert.equal(next.atlasIndex, 3);
    assert.deepEqual(next.atlasViewBounds, { index: 3, bounds: [0, 1, 2, 3] });
  });
});

describe("printLayoutReducer: data blocks", () => {
  it("drops the old layer's columns and sort when the table layer changes", () => {
    const next = run(stateWith({ tableColumns: ["a", "b"], tableSortField: "a" }), {
      type: "selectTableLayer",
      layerId: "other",
    });
    assert.equal(next.layout.tableLayerId, "other");
    assert.deepEqual(next.layout.tableColumns, []);
    assert.equal(next.layout.tableSortField, "");
  });

  it("drops the old layer's fields when the chart layer changes", () => {
    const next = run(stateWith({ chartCategoryField: "c", chartValueField: "v" }), {
      type: "selectChartLayer",
      layerId: "other",
    });
    assert.equal(next.layout.chartLayerId, "other");
    assert.equal(next.layout.chartCategoryField, "");
    assert.equal(next.layout.chartValueField, "");
  });

  it("toggles and positions a block", () => {
    const next = run(stateWith(), {
      type: "setLayout",
      patch: { showDataTable: true, tablePosition: "bottom-left" },
    });
    assert.equal(next.layout.showDataTable, true);
    assert.equal(next.layout.tablePosition, "bottom-left");
  });
});

describe("printLayoutReducer: custom legend", () => {
  it("adds swatches with fresh ids after the restored ones", () => {
    const base = stateWith({
      customLegendEntries: [{ id: "cl-4", label: "Old", color: "#000000" }],
    });
    const next = run(base, { type: "addCustomLegendEntry" }, { type: "addCustomLegendEntry" });
    assert.deepEqual(
      next.layout.customLegendEntries.map((e) => e.id),
      ["cl-4", "cl-5", "cl-6"],
    );
    assert.deepEqual(next.layout.customLegendEntries[1], {
      id: "cl-5",
      label: "",
      color: "#888888",
    });
  });

  it("edits and removes one swatch by id", () => {
    const base = stateWith({
      customLegendEntries: [
        { id: "cl-1", label: "A", color: "#111111" },
        { id: "cl-2", label: "B", color: "#222222" },
      ],
    });
    const edited = run(
      base,
      { type: "updateCustomLegendEntry", id: "cl-2", patch: { label: "Bee" } },
      { type: "updateCustomLegendEntry", id: "cl-2", patch: { color: "#ff0000" } },
    );
    assert.deepEqual(edited.layout.customLegendEntries[1], {
      id: "cl-2",
      label: "Bee",
      color: "#ff0000",
    });
    assert.deepEqual(edited.layout.customLegendEntries[0], base.layout.customLegendEntries[0]);
    const removed = run(edited, { type: "removeCustomLegendEntry", id: "cl-1" });
    assert.deepEqual(
      removed.layout.customLegendEntries.map((e) => e.id),
      ["cl-2"],
    );
  });

  it("replaces the swatches from a dictionary, continuing the id sequence", () => {
    const next = run(
      stateWith({ customLegendEntries: [{ id: "cl-2", label: "Old", color: "#000" }] }),
      { type: "setUi", patch: { legendDict: '{"Water": "#00f", "Land": "#0f0"}' } },
      { type: "importLegendDict", errorMessage: "bad" },
    );
    assert.deepEqual(next.layout.customLegendEntries, [
      { id: "cl-3", label: "Water", color: "#00f" },
      { id: "cl-4", label: "Land", color: "#0f0" },
    ]);
    assert.equal(next.legendDictError, null);
    const more = run(next, { type: "addCustomLegendEntry" });
    assert.equal(more.layout.customLegendEntries[2].id, "cl-5");
  });

  it("reports a malformed dictionary without touching the swatches", () => {
    for (const text of ["{", "[1,2]", "{}", "null", '"x"']) {
      const base = stateWith();
      const next = run(
        base,
        { type: "setUi", patch: { legendDict: text } },
        { type: "importLegendDict", errorMessage: "bad" },
      );
      assert.equal(next.legendDictError, "bad", text);
      assert.equal(next.layout, base.layout, text);
    }
  });

  it("parses dictionary values to strings", () => {
    assert.deepEqual(parseLegendDict('{"A": 1}'), [["A", "1"]]);
    assert.equal(parseLegendDict("not json"), null);
  });
});

describe("printLayoutReducer: element toggles", () => {
  it("round-trips a toggled layout back to the default config", () => {
    const toggled = run(
      stateWith(),
      { type: "setLayout", patch: { showNorthArrow: false, showColorbar: true } },
      { type: "setLayout", patch: { showNorthArrow: true, showColorbar: false } },
    );
    assert.ok(printLayoutConfigsEqual(toggled.layout, createDefaultPrintLayout()));
  });
});
