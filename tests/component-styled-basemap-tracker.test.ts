// The harness registers the Vite hooks the `@geolibre/map` barrel's CSS
// imports need, so the modules under test are loaded dynamically after it.
import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const { hasPMTilesArchive, registerOfflineBasemapStyle, registerPMTilesArchive } =
  await import("@geolibre/map");
// Not re-exported by the barrel; the same module instance the barrel loads.
const { getOfflineBasemapStyle } = await import("../packages/map/src/protomaps-basemap");
const { activeStyledBasemap, forgetStyledBasemap, trackStyledBasemap } =
  await import("../apps/geolibre-desktop/src/lib/styled-basemap-tracker");

describe("styled basemap tracker", () => {
  const style = { version: 8 as const, sources: {}, layers: [] };
  const register = (id: string) => {
    registerPMTilesArchive(`${id}.pmtiles`, new Uint8Array([1, 2, 3]));
    return registerOfflineBasemapStyle(id, style);
  };

  afterEach(() => {
    const active = activeStyledBasemap();
    if (active) forgetStyledBasemap(active.id);
  });

  it("frees the replaced in-memory archive and style when another basemap is applied", () => {
    const first = register("tracker-a");
    trackStyledBasemap("tracker-a", "tracker-a.pmtiles");
    const second = register("tracker-b");
    trackStyledBasemap("tracker-b", "tracker-b.pmtiles");
    assert.equal(hasPMTilesArchive("tracker-a.pmtiles"), false);
    assert.equal(getOfflineBasemapStyle(first), null);
    assert.equal(hasPMTilesArchive("tracker-b.pmtiles"), true);
    assert.ok(getOfflineBasemapStyle(second));
    assert.deepEqual(activeStyledBasemap(), {
      id: "tracker-b",
      archiveKey: "tracker-b.pmtiles",
      persistent: false,
    });
  });

  it("keeps a re-applied basemap and a persistent native package resident", () => {
    register("tracker-c");
    trackStyledBasemap("tracker-c", "tracker-c.pmtiles");
    trackStyledBasemap("tracker-c", "tracker-c.pmtiles");
    assert.equal(hasPMTilesArchive("tracker-c.pmtiles"), true);
    register("tracker-native");
    trackStyledBasemap("tracker-native", "tracker-native.pmtiles", true);
    trackStyledBasemap("tracker-d", "tracker-d.pmtiles");
    assert.equal(hasPMTilesArchive("tracker-native.pmtiles"), true);
  });

  it("forgets only the active basemap", () => {
    register("tracker-e");
    trackStyledBasemap("tracker-e", "tracker-e.pmtiles");
    forgetStyledBasemap("someone-else");
    assert.equal(activeStyledBasemap()?.id, "tracker-e");
    forgetStyledBasemap("tracker-e");
    assert.equal(activeStyledBasemap(), null);
    assert.equal(hasPMTilesArchive("tracker-e.pmtiles"), false);
  });
});
