import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEGACY_COG_ENGINE,
  cogEngineDefaults,
  deepLinkCogDefaults,
} from "../apps/geolibre-desktop/src/lib/cog-render-engine";

// The raster control holds one engine for every raster it manages, so the
// difference between "no engine key" and "engine: <default>" decides whether
// adding a COG silently re-renders layers another panel put on the map. That
// only shows up as a UI side effect, hence these assertions.
describe("cogEngineDefaults", () => {
  it("leaves URL deep links on the fresh control's globe-compatible default", () => {
    const defaults = deepLinkCogDefaults();
    assert.deepEqual(defaults, {});
    assert.equal("engine" in defaults, false);
  });

  it('omits the engine entirely for "auto" so the control is left alone', () => {
    const defaults = cogEngineDefaults("auto");
    assert.deepEqual(defaults, {});
    assert.equal("engine" in defaults, false);
  });

  it("passes an explicit engine through so a caller can opt in", () => {
    assert.deepEqual(cogEngineDefaults("titiler"), { engine: "titiler" });
    assert.deepEqual(cogEngineDefaults("cog-tiler-wasm"), { engine: "cog-tiler-wasm" });
  });

  it("keeps the legacy GPU default for a caller that says nothing", () => {
    assert.deepEqual(cogEngineDefaults(undefined), { engine: LEGACY_COG_ENGINE });
    assert.equal(LEGACY_COG_ENGINE, "maplibre-gl-raster");
  });
});
