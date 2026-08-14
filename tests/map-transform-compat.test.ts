import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Map as MapLibreMap } from "maplibre-gl";
import { installMapTransformCompat } from "../packages/map/src/map-transform-compat";

/**
 * MapLibre v6 moved the transform to `map._camera.transform`, but deck.gl (and
 * two maplibre-gl-* controls) still read `map.transform` on every render. The
 * shim re-exposes it. These assert the two things that would fail silently: a
 * map with no `_camera` must not throw, and the `_nearZ`/`_farZ` aliases must
 * resolve to v6's public `nearZ`/`farZ` so deck.gl keeps its depth precision.
 */
describe("installMapTransformCompat", () => {
  it("exposes the camera transform as map.transform", () => {
    installMapTransformCompat();

    const transform = { height: 720, width: 1280, elevation: 12, nearZ: 3, farZ: 4000 };
    const map = Object.create(MapLibreMap.prototype) as {
      _camera?: unknown;
      transform?: typeof transform;
    };
    map._camera = { transform };

    assert.equal(map.transform, transform);
    assert.equal(map.transform?.height, 720);
    assert.equal(map.transform?.elevation, 12);
  });

  it("aliases the v5 _nearZ/_farZ spellings onto the v6 transform", () => {
    installMapTransformCompat();

    const transform: Record<string, unknown> = { height: 720, nearZ: 3, farZ: 4000 };
    const map = Object.create(MapLibreMap.prototype) as {
      _camera?: unknown;
      transform?: Record<string, unknown>;
    };
    map._camera = { transform };

    assert.equal(map.transform?._nearZ, 3);
    assert.equal(map.transform?._farZ, 4000);

    // Live getters, not a one-time copy: deck.gl reads them every frame.
    transform.nearZ = 7;
    assert.equal(map.transform?._nearZ, 7);
  });

  it("leaves a transform that already spells them itself alone", () => {
    installMapTransformCompat();

    const transform = { height: 720, _nearZ: 1, nearZ: 99 };
    const map = Object.create(MapLibreMap.prototype) as {
      _camera?: unknown;
      transform?: typeof transform;
    };
    map._camera = { transform };

    assert.equal(map.transform?._nearZ, 1);
  });

  it("returns undefined rather than throwing when there is no camera yet", () => {
    installMapTransformCompat();

    const map = Object.create(MapLibreMap.prototype) as { transform?: unknown };
    assert.equal(map.transform, undefined);
  });

  it("is idempotent and reports that it did nothing the second time", () => {
    installMapTransformCompat();
    assert.equal(installMapTransformCompat(), false, "Map#transform should already be defined");
  });
});
