import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INITIAL_SIDE_SHEET_STATE,
  reportSideSheet,
  shouldYieldSideSheet,
  type SideSheetState,
} from "../apps/geolibre-desktop/src/lib/side-sheets";

const open = (...steps: Array<["layers" | "style", boolean]>): SideSheetState =>
  steps.reduce(
    (state, [id, expanded]) => reportSideSheet(state, id, expanded),
    INITIAL_SIDE_SHEET_STATE,
  );

describe("side sheets", () => {
  it("records the panel expanded most recently", () => {
    const state = open(["layers", true], ["style", true]);
    assert.deepEqual(state.expanded, { layers: true, style: true });
    assert.equal(state.lastExpanded, "style");
  });

  it("keeps the most recent panel when one collapses", () => {
    const state = open(["layers", true], ["style", true], ["style", false]);
    assert.equal(state.lastExpanded, "style");
    assert.equal(state.expanded.style, false);
  });

  it("returns the same record when nothing changed", () => {
    const state = open(["layers", true]);
    assert.equal(reportSideSheet(state, "layers", true), state);
  });

  it("folds back the earlier panel on a narrow viewport", () => {
    const state = open(["layers", true], ["style", true]);
    assert.equal(shouldYieldSideSheet(state, "layers", true), true);
    assert.equal(shouldYieldSideSheet(state, "style", true), false);
  });

  it("follows the order the panels were opened in", () => {
    const state = open(["style", true], ["layers", true]);
    assert.equal(shouldYieldSideSheet(state, "style", true), true);
    assert.equal(shouldYieldSideSheet(state, "layers", true), false);
  });

  it("leaves both panels open on a wide viewport", () => {
    const state = open(["layers", true], ["style", true]);
    assert.equal(shouldYieldSideSheet(state, "layers", false), false);
    assert.equal(shouldYieldSideSheet(state, "style", false), false);
  });

  it("does not fold a panel when the other one is closed", () => {
    // Style was opened last but is closed again, so Layers stays open when
    // the window narrows.
    const state = open(["layers", true], ["style", true], ["style", false]);
    assert.equal(shouldYieldSideSheet(state, "layers", true), false);
  });

  it("does not fold a collapsed panel", () => {
    const state = open(["style", true]);
    assert.equal(shouldYieldSideSheet(state, "layers", true), false);
  });
});
