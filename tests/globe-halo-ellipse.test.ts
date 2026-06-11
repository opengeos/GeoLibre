import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fitEllipse,
  type GlobeEllipse,
} from "../packages/plugins/src/plugins/maplibre-effects";

/**
 * Sample `n` points on the boundary of an ellipse with the given center,
 * semi-axes, and rotation. Sampling is uneven on purpose (rays from an interior
 * point that is *not* the center, mimicking how the silhouette is sampled from
 * the projected map center) to prove the fit does not depend on uniform spacing.
 */
function ellipsePoints(
  e: GlobeEllipse,
  n: number,
  from: [number, number] = [e.cx, e.cy],
): Array<[number, number]> {
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    // Boundary point at parameter t, in ellipse-local then world coords.
    const t = (i / n) * 2 * Math.PI;
    const lx = e.rx * Math.cos(t);
    const ly = e.ry * Math.sin(t);
    const bx = e.cx + lx * cos - ly * sin;
    const by = e.cy + lx * sin + ly * cos;
    // Re-parameterize by angle from `from` so spacing is uneven (irrelevant to
    // the fit, but matches the real ray-cast sampling).
    const ang = Math.atan2(by - from[1], bx - from[0]);
    pts.push([ang, bx, by] as unknown as [number, number]);
  }
  // sort by angle from `from`, keep coords
  return (pts as unknown as Array<[number, number, number]>)
    .sort((a, b) => a[0] - b[0])
    .map(([, x, y]) => [x, y]);
}

/** Largest absolute residual: how far each point sits off the fitted ellipse. */
function maxResidual(
  e: GlobeEllipse,
  pts: Array<[number, number]>,
): number {
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  let worst = 0;
  for (const [x, y] of pts) {
    const dx = x - e.cx;
    const dy = y - e.cy;
    // Project into ellipse-local frame and evaluate the implicit form.
    const u = (dx * cos + dy * sin) / e.rx;
    const v = (-dx * sin + dy * cos) / e.ry;
    worst = Math.max(worst, Math.abs(Math.hypot(u, v) - 1));
  }
  return worst;
}

describe("fitEllipse", () => {
  it("recovers a circle (top-down globe) exactly", () => {
    const truth: GlobeEllipse = { cx: 344, cy: 392, rx: 325, ry: 325, angle: 0 };
    const fit = fitEllipse(ellipsePoints(truth, 24));
    assert.ok(fit, "expected a fit");
    assert.ok(Math.abs(fit.cx - 344) < 1e-6);
    assert.ok(Math.abs(fit.cy - 392) < 1e-6);
    assert.ok(Math.abs(fit.rx - 325) < 1e-6);
    assert.ok(Math.abs(fit.ry - 325) < 1e-6);
    assert.ok(maxResidual(fit, ellipsePoints(truth, 64)) < 1e-6);
  });

  it("recovers an axis-aligned ellipse (pitched globe)", () => {
    const truth: GlobeEllipse = {
      cx: 344,
      cy: 630,
      rx: 455,
      ry: 447,
      angle: 0,
    };
    const fit = fitEllipse(ellipsePoints(truth, 24));
    assert.ok(fit, "expected a fit");
    assert.ok(maxResidual(fit, ellipsePoints(truth, 64)) < 1e-6);
  });

  it("recovers a rotated, eccentric ellipse (pitch + bearing)", () => {
    const truth: GlobeEllipse = {
      cx: 100,
      cy: -50,
      rx: 1337,
      ry: 1072,
      angle: 0.7,
    };
    const fit = fitEllipse(ellipsePoints(truth, 32));
    assert.ok(fit, "expected a fit");
    // The fit may report axes/angle for either principal direction; verify by
    // residual rather than comparing angle directly (atan2 sign ambiguity).
    assert.ok(maxResidual(fit, ellipsePoints(truth, 96)) < 1e-5);
    // Center is exact regardless of rotation (bbox-center property).
    assert.ok(Math.abs(fit.cx - 100) < 1e-6);
    assert.ok(Math.abs(fit.cy + 50) < 1e-6);
  });

  it("uses the bounding-box center even from off-center sampling", () => {
    const truth: GlobeEllipse = {
      cx: 200,
      cy: 300,
      rx: 400,
      ry: 250,
      angle: 0.3,
    };
    // Sample as rays from a point well inside but away from the center.
    const pts = ellipsePoints(truth, 40, [260, 340]);
    const fit = fitEllipse(pts);
    assert.ok(fit, "expected a fit");
    assert.ok(Math.abs(fit.cx - 200) < 1e-6);
    assert.ok(Math.abs(fit.cy - 300) < 1e-6);
    assert.ok(maxResidual(fit, pts) < 1e-5);
  });

  it("returns null for degenerate input", () => {
    assert.equal(fitEllipse([]), null);
    assert.equal(
      fitEllipse([
        [0, 0],
        [1, 1],
      ]),
      null,
    );
    // Collinear points do not bound an ellipse.
    assert.equal(
      fitEllipse([
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
      null,
    );
  });
});
