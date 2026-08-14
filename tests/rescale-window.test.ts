import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boundText,
  nextRescaleWindow,
  parseBound,
} from "../apps/geolibre-desktop/src/lib/rescale-window";

describe("nextRescaleWindow", () => {
  it("applies the window once both ends are filled", () => {
    assert.deepEqual(nextRescaleWindow("0", "255"), [0, 255]);
    assert.deepEqual(nextRescaleWindow("-1.5", "2.5"), [-1.5, 2.5]);
  });

  it("stays unset while only one end is filled", () => {
    // The reported bug: filling only the max used to copy 255 onto the min.
    assert.equal(nextRescaleWindow("", "255"), null);
    assert.equal(nextRescaleWindow("0", ""), null);
  });

  it("stays unset while a bound is not yet a number", () => {
    assert.equal(nextRescaleWindow("0", "-"), null);
    assert.equal(nextRescaleWindow("abc", "255"), null);
  });

  it("stays unset when neither end is filled", () => {
    assert.equal(nextRescaleWindow("", ""), null);
  });

  it("keeps a zero bound, which is a value and not an empty field", () => {
    assert.deepEqual(nextRescaleWindow("0", "0"), [0, 0]);
  });
});

describe("bound fields", () => {
  it("round-trips a set bound", () => {
    assert.equal(parseBound(boundText(255)), 255);
    assert.equal(parseBound(boundText(0)), 0);
  });

  it("renders an unset bound as an empty field", () => {
    assert.equal(boundText(null), "");
    assert.equal(parseBound(""), null);
  });
});
