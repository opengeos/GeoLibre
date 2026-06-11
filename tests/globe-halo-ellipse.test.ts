import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fitEllipse,
  type GlobeEllipse,
} from "../packages/plugins/src/plugins/maplibre-effects";

/**
 * Sample `n` boundary points by casting rays at uniform angles from `from` (an
 * interior point) to the ellipse — exactly how the production code samples the
 * silhouette from the projected map center. When `from` is the ellipse center
 * the rays are radial; when it is offset (as it is under pitch) the hit points
 * are *not* symmetric about the center, which is the case a bounding-box-center
 * fit would get wrong and a true conic fit must get right.
 */
function ellipsePoints(
  e: GlobeEllipse,
  n: number,
  from: [number, number] = [e.cx, e.cy],
): Array<[number, number]> {
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  // Ray origin in the ellipse-local frame, scaled so the ellipse is the unit
  // circle: translate to center, unrotate, divide by the semi-axes.
  const ox = ((from[0] - e.cx) * cos + (from[1] - e.cy) * sin) / e.rx;
  const oy = (-(from[0] - e.cx) * sin + (from[1] - e.cy) * cos) / e.ry;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * 2 * Math.PI;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    // Same ray direction in the unit-circle frame, then the far intersection
    // with the unit circle: |origin + t·dir| = 1.
    const dx = (cosA * cos + sinA * sin) / e.rx;
    const dy = (-cosA * sin + sinA * cos) / e.ry;
    const qa = dx * dx + dy * dy;
    const qb = ox * dx + oy * dy;
    const qc = ox * ox + oy * oy - 1;
    const disc = qb * qb - qa * qc;
    if (disc < 0) continue; // ray misses (only if `from` is outside the ellipse)
    const t = (-qb + Math.sqrt(disc)) / qa; // far (forward) intersection
    pts.push([from[0] + cosA * t, from[1] + sinA * t]);
  }
  return pts;
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
    // The 5-parameter conic fit is well within a thousandth of a pixel — far
    // tighter than the sub-pixel accuracy the effect needs.
    assert.ok(Math.abs(fit.rx - 325) < 1e-3, `rx ${fit.rx}`);
    assert.ok(Math.abs(fit.ry - 325) < 1e-3, `ry ${fit.ry}`);
    assert.ok(maxResidual(fit, ellipsePoints(truth, 64)) < 1e-5);
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
    // Center is solved from the conic, so it is exact regardless of rotation.
    assert.ok(Math.abs(fit.cx - 100) < 1e-6);
    assert.ok(Math.abs(fit.cy + 50) < 1e-6);
  });

  it("solves the center from off-center ray-cast sampling", () => {
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

  it("recovers the center when rays are cast far from it (steep pitch)", () => {
    // Replicates the production case: an eccentric, offset silhouette sampled by
    // rays from the projected map center, ~1200px from the ellipse center. A
    // bounding-box-center fit is off by ~16px here; solving the conic is exact.
    const truth: GlobeEllipse = {
      cx: 344,
      cy: 1578,
      rx: 1337,
      ry: 1072,
      angle: -2.2,
    };
    const pts = ellipsePoints(truth, 24, [344, 392]);
    const fit = fitEllipse(pts);
    assert.ok(fit, "expected a fit");
    assert.ok(Math.abs(fit.cx - 344) < 1e-4, `cx ${fit.cx}`);
    assert.ok(Math.abs(fit.cy - 1578) < 1e-4, `cy ${fit.cy}`);
    assert.ok(maxResidual(fit, pts) < 1e-6);
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
    // Six collinear points (enough for the 5-parameter fit) do not bound an
    // ellipse, so the normal equations are singular and the fit bails.
    assert.equal(
      fitEllipse([
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
        [5, 5],
      ]),
      null,
    );
  });
});
