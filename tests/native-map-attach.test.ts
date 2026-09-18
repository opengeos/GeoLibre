import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CESIUM_CAPABILITIES } from "../packages/map/src/cesium-engine";
import { MAPLIBRE_CAPABILITIES } from "../packages/map/src/map-engine";
import type { MapEngine } from "../packages/map/src/map-engine";
import { shouldAwaitNativeMap } from "../apps/geolibre-desktop/src/lib/native-map-attach";

// The guard three hooks use to decide whether polling for the native MapLibre
// map is still worth another frame (#2268). It exists as a shared function
// precisely because it was written inline three times, two of them got the
// Cesium case and the third did not — so the case that matters is asserted
// against both engines' real capability objects rather than a hand-written stub.

const engine = (capabilities: MapEngine["capabilities"]) =>
  ({ capabilities }) as unknown as MapEngine;

describe("shouldAwaitNativeMap", () => {
  it("keeps waiting while no engine has published yet", () => {
    // A null ref during mount is the case the polling loop was written for.
    assert.equal(shouldAwaitNativeMap(null), true);
    assert.equal(shouldAwaitNativeMap(undefined), true);
  });

  it("keeps waiting for a MapLibre engine, whose map is still coming", () => {
    assert.equal(shouldAwaitNativeMap(engine(MAPLIBRE_CAPABILITIES)), true);
  });

  it("stops for an engine that will never have a native map", () => {
    // The whole point: without this the loop schedules a frame every frame for
    // the life of the globe, since `CesiumEngine.getMap()` is null forever.
    assert.equal(shouldAwaitNativeMap(engine(CESIUM_CAPABILITIES)), false);
  });

  it("decides from the capability, not the engine's name", () => {
    // A future engine that does expose a MapLibre map should be waited for, and
    // one that does not should not — without this helper learning about it.
    assert.equal(
      shouldAwaitNativeMap(engine({ ...CESIUM_CAPABILITIES, nativeMapInstance: true })),
      true,
    );
    assert.equal(
      shouldAwaitNativeMap(engine({ ...MAPLIBRE_CAPABILITIES, nativeMapInstance: false })),
      false,
    );
  });
});
