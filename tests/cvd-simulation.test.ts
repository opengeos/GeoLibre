import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRgbMatrix,
  colorMatrixValues,
  CVD_MATRICES,
  CVD_MODES,
  cvdColorMatrixValues,
  cvdFilterId,
  isCvdMode,
} from "../apps/geolibre-desktop/src/lib/cvd-simulation";

const close = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps;

describe("CVD simulation matrices", () => {
  it("covers the four modes, in menu order", () => {
    assert.deepEqual([...CVD_MODES], ["protanopia", "deuteranopia", "tritanopia", "achromatopsia"]);
    for (const mode of CVD_MODES) assert.ok(CVD_MATRICES[mode]);
  });

  it("keeps white white and black black (every row sums to 1)", () => {
    for (const mode of CVD_MODES) {
      const white = applyRgbMatrix(CVD_MATRICES[mode], [1, 1, 1]);
      for (const channel of white) assert.ok(close(channel, 1), `${mode}: ${white.join(",")}`);
      assert.deepEqual(applyRgbMatrix(CVD_MATRICES[mode], [0, 0, 0]), [0, 0, 0]);
    }
  });

  it("matches Machado et al. 2009 at full severity", () => {
    // Spot-check the first row of each dichromacy against the published table.
    assert.deepEqual(CVD_MATRICES.protanopia[0], [0.152286, 1.052583, -0.204868]);
    assert.deepEqual(CVD_MATRICES.deuteranopia[0], [0.367322, 0.860646, -0.227968]);
    assert.deepEqual(CVD_MATRICES.tritanopia[0], [1.255528, -0.076749, -0.178779]);
  });

  it("makes red and green hard to tell apart for protan/deutan, not tritan", () => {
    const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
    const baseline = distance([1, 0, 0], [0, 1, 0]);
    for (const mode of ["protanopia", "deuteranopia"] as const) {
      const red = applyRgbMatrix(CVD_MATRICES[mode], [1, 0, 0]);
      const green = applyRgbMatrix(CVD_MATRICES[mode], [0, 1, 0]);
      // Hue collapses: red and green land on the same yellowish axis (R ≈ G),
      // differing mostly in brightness.
      assert.ok(Math.abs(red[0] / red[1] - green[0] / green[1]) < 0.6, mode);
      assert.ok(distance(red, green) < baseline, mode);
    }
  });

  it("maps every color to a gray for achromatopsia", () => {
    const [r, g, b] = applyRgbMatrix(CVD_MATRICES.achromatopsia, [0.9, 0.2, 0.4]);
    assert.ok(close(r, g) && close(g, b));
    assert.ok(close(r, 0.2126 * 0.9 + 0.7152 * 0.2 + 0.0722 * 0.4));
  });
});

describe("feColorMatrix values builder", () => {
  it("emits a 4×5 matrix with alpha passed through and no offsets", () => {
    const values = colorMatrixValues([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    assert.equal(values, "1 2 3 0 0 4 5 6 0 0 7 8 9 0 0 0 0 0 1 0");
  });

  it("builds 20 finite numbers for every mode", () => {
    for (const mode of CVD_MODES) {
      const numbers = cvdColorMatrixValues(mode).split(" ").map(Number);
      assert.equal(numbers.length, 20, mode);
      assert.ok(numbers.every(Number.isFinite), mode);
      assert.deepEqual(numbers.slice(15), [0, 0, 0, 1, 0], mode);
    }
  });

  it("gives each mode a distinct filter id and validates mode strings", () => {
    const ids = CVD_MODES.map(cvdFilterId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(cvdFilterId("tritanopia"), "geolibre-cvd-tritanopia");
    assert.ok(isCvdMode("deuteranopia"));
    assert.ok(!isCvdMode("off"));
    assert.ok(!isCvdMode(undefined));
  });
});
