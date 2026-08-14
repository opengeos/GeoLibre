import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getTimeSliderSymbology,
  parseBandList,
  setTimeSliderSymbology,
} from "../packages/plugins/src/plugins/time-slider-symbology";

describe("parseBandList", () => {
  it("parses a comma-separated RGB composite", () => {
    assert.deepEqual(parseBandList("4,3,2"), [4, 3, 2]);
  });

  it("tolerates spaces around and between the numbers", () => {
    assert.deepEqual(parseBandList("  4 , 3   2 "), [4, 3, 2]);
  });

  it("treats an empty field as the renderer default", () => {
    assert.deepEqual(parseBandList(""), []);
    assert.deepEqual(parseBandList("   "), []);
  });

  it("rejects a list that is not whole 1-based band numbers", () => {
    // Bands are 1-based positions, so these are typos rather than selections —
    // and null is what keeps a half-typed value from reaching the renderer.
    assert.equal(parseBandList("0"), null);
    assert.equal(parseBandList("-1"), null);
    assert.equal(parseBandList("1.5"), null);
    assert.equal(parseBandList("red"), null);
  });

  it("collapses repeated separators rather than rejecting the list", () => {
    // A doubled comma is a typo with an unambiguous reading, and rejecting it
    // would flag the field as invalid mid-edit for no gain.
    assert.deepEqual(parseBandList("4,,2"), [4, 2]);
  });
});

describe("time-slider symbology with no dock", () => {
  // Every accessor goes through the live control, so with the plugin inactive
  // they must report "nothing to edit" rather than throwing into the panel.
  it("reads nothing", () => {
    assert.equal(getTimeSliderSymbology("anything"), null);
  });

  it("applies nothing", () => {
    assert.equal(setTimeSliderSymbology("anything", { colormap: "viridis" }), false);
  });
});
