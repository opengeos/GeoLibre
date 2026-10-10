import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as C from "@cesium/engine";
import { horizonDepthDistance, horizonDistance } from "../packages/map/src/cesium-horizon";

/** A widget whose camera sits `height` metres above (0°, 0°), with a real preRender event. */
function makeViewer(height: number, mode = C.SceneMode.SCENE3D) {
  const camera = { positionWC: C.Cartesian3.fromDegrees(0, 0, height) };
  const scene = { mode, globe: { ellipsoid: C.Ellipsoid.WGS84 }, preRender: new C.Event() };
  return { camera, scene } as unknown as C.CesiumWidget & {
    camera: typeof camera;
    scene: typeof scene;
  };
}

describe("horizon depth distance", () => {
  it("is the tangent distance to the ellipsoid, so the near side passes and the far side fails", () => {
    const viewer = makeViewer(1e7);
    const distance = horizonDistance(C, viewer);
    const R = C.Ellipsoid.WGS84.maximumRadius;
    const beyond = Math.sqrt(8849 * (2 * R + 8849));
    assert.ok(Math.abs(distance / (Math.sqrt(1e7 * (2 * R + 1e7)) + beyond) - 1.01) < 1e-9);
    const eye = viewer.camera.positionWC;
    const near = C.Cartesian3.distance(eye, C.Cartesian3.fromDegrees(30, 10));
    const far = C.Cartesian3.distance(eye, C.Cartesian3.fromDegrees(150, 0));
    assert.ok(near < distance, "a visible point skips the depth test");
    assert.ok(far > distance, "a far-side point is depth-tested against the globe");

    // From 1 km up, a ridge 200 km away is past the smooth horizon (~113 km)
    // but in view; it still draws over the terrain it sits on.
    const low = makeViewer(1000);
    const ridge = C.Cartesian3.distance(
      low.camera.positionWC,
      C.Cartesian3.fromDegrees(1.8, 0, 3000),
    );
    assert.ok(ridge < horizonDistance(C, low));
  });

  it("is infinite in the flat scene modes and below the ellipsoid", () => {
    assert.equal(horizonDistance(C, makeViewer(1e7, C.SceneMode.SCENE2D)), Infinity);
    assert.equal(horizonDistance(C, makeViewer(-10)), Infinity);
  });

  it("updates once per frame and republishes to primitives only on a real change", () => {
    const viewer = makeViewer(1e7);
    const horizon = horizonDepthDistance(C, viewer);
    assert.equal(horizonDepthDistance(C, viewer), horizon, "one per globe");
    const seen: number[] = [];
    let keep = true;
    horizon.subscribe((distance) => {
      seen.push(distance);
      return keep;
    });
    assert.equal(seen.length, 1, "called with the current distance");
    viewer.camera.positionWC = C.Cartesian3.fromDegrees(0, 0, 1e7 + 1);
    viewer.scene.preRender.raiseEvent();
    assert.equal(seen.length, 1, "a tiny move is not republished");
    viewer.camera.positionWC = C.Cartesian3.fromDegrees(0, 0, 2e6);
    viewer.scene.preRender.raiseEvent();
    assert.equal(seen.length, 2);
    assert.equal(
      (horizon.property as C.CallbackProperty).getValue(C.JulianDate.now()),
      horizon.distance(),
    );
    keep = false;
    viewer.camera.positionWC = C.Cartesian3.fromDegrees(0, 0, 5e6);
    viewer.scene.preRender.raiseEvent();
    viewer.camera.positionWC = C.Cartesian3.fromDegrees(0, 0, 9e6);
    viewer.scene.preRender.raiseEvent();
    assert.equal(seen.length, 3, "a listener that returns false stops listening");
  });

  it("answers infinity for a widget without a scene event", () => {
    const horizon = horizonDepthDistance(C, { scene: {} } as never);
    assert.equal(horizon.distance(), Infinity);
    assert.equal(horizon.property, Infinity);
  });
});
