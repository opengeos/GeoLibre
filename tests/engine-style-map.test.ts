import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MapEngine } from "@geolibre/map";
import {
  createEnginePopup,
  engineStyleMap,
} from "../apps/geolibre-desktop/src/lib/engine-style-map";

// The map overlays (sample markers, the pixel time series, NetCDF identify)
// reach the 2D map and its popup class through these, so they work on the
// Mapbox renderer as well as MapLibre (#2475).
const engine = (patch: Record<string, unknown>) => patch as unknown as MapEngine;

describe("engineStyleMap", () => {
  it("prefers the MapLibre map, then the Mapbox map, else null", () => {
    const maplibre = {};
    const mapbox = {};
    assert.equal(engineStyleMap(engine({ kind: "maplibre", getMap: () => maplibre })), maplibre);
    assert.equal(
      engineStyleMap(engine({ kind: "mapbox", getMap: () => null, getMapboxMap: () => mapbox })),
      mapbox,
    );
    assert.equal(engineStyleMap(engine({ kind: "cesium", getMap: () => null })), null);
    assert.equal(engineStyleMap(null), null);
  });
});

describe("createEnginePopup", () => {
  it("builds mapbox-gl's Popup on the Mapbox engine", () => {
    class FakePopup {
      constructor(public options: unknown) {}
    }
    const mapboxEngine = {
      kind: "mapbox",
      getMap: () => null,
      getMapboxGl() {
        // Called as a method, so `this` is the engine.
        assert.equal(this, mapboxEngine);
        return { Popup: FakePopup };
      },
    };
    const popup = createEnginePopup(engine(mapboxEngine), { closeButton: false });
    assert.ok(popup instanceof FakePopup);
    assert.deepEqual((popup as unknown as FakePopup).options, { closeButton: false });
  });
});
