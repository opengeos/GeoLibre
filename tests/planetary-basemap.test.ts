import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore, undo } from "../packages/core/src/store";
import { getPlanetaryBasemapById } from "../packages/core/src/ellipsoids";
import { setHistoryCoalesceMs } from "../packages/core/src/history";

const mars = getPlanetaryBasemapById("mars-viking-mdim21")!;
const moon = getPlanetaryBasemapById("moon-hillshaded-albedo")!;
const earth = getPlanetaryBasemapById("earth-usgs-imagery")!;

describe("applyPlanetaryBasemap", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "reset" });
  });

  it("applies the basemap and syncs the ellipsoid to the body", () => {
    useAppStore.getState().applyPlanetaryBasemap(mars);
    const state = useAppStore.getState();
    assert.equal(state.basemapStyleUrl, mars.styleUrl);
    assert.equal(state.preferences.map.ellipsoidId, "mars");
  });

  it("leaves the other map preferences untouched", () => {
    const before = useAppStore.getState().preferences.map;
    useAppStore.getState().applyPlanetaryBasemap(moon);
    const after = useAppStore.getState().preferences.map;
    assert.deepEqual(after, { ...before, ellipsoidId: "moon" });
  });

  it("does not rewrite preferences when the ellipsoid already matches", () => {
    // The default project is already on Earth, so applying an Earth basemap
    // must not touch (or replace the reference of) the preferences object.
    const before = useAppStore.getState().preferences;
    useAppStore.getState().applyPlanetaryBasemap(earth);
    const state = useAppStore.getState();
    assert.equal(state.basemapStyleUrl, earth.styleUrl);
    assert.equal(state.preferences, before);
  });
});

describe("restoreEarthBasemap", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "reset" });
  });

  it("applies the given basemap and resets the ellipsoid to Earth", () => {
    useAppStore.getState().applyPlanetaryBasemap(mars);
    useAppStore.getState().restoreEarthBasemap("https://example.com/style.json");
    const state = useAppStore.getState();
    assert.equal(state.basemapStyleUrl, "https://example.com/style.json");
    assert.equal(state.preferences.map.ellipsoidId, "earth");
  });
});

describe("undo keeps the ellipsoid in sync with the restored basemap", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "reset" });
  });

  it("re-derives Earth after undoing a switch to a planetary basemap", () => {
    assert.equal(useAppStore.getState().preferences.map.ellipsoidId, "earth");
    useAppStore.getState().applyPlanetaryBasemap(mars);
    assert.equal(useAppStore.getState().preferences.map.ellipsoidId, "mars");
    undo();
    const state = useAppStore.getState();
    assert.notEqual(state.basemapStyleUrl, mars.styleUrl);
    // The basemap reverted to Earth, so the ellipsoid must follow — otherwise
    // measurements would use the Mars radius under an Earth basemap.
    assert.equal(state.preferences.map.ellipsoidId, "earth");
  });

  it("leaves a manually-set ellipsoid alone on an undo that keeps the basemap", () => {
    // The ellipsoid can be set independently of the basemap (Settings), e.g. to
    // measure imported Mars data while staying on an Earth basemap.
    const prefs = useAppStore.getState().preferences;
    useAppStore.getState().setPreferences({
      ...prefs,
      map: { ...prefs.map, ellipsoidId: "mars" },
    });
    // An unrelated undoable action that doesn't touch the basemap, then undo.
    useAppStore
      .getState()
      .addGeoJsonLayer("A", { type: "FeatureCollection", features: [] });
    undo();
    // The basemap never changed, so the manual ellipsoid must survive.
    assert.equal(useAppStore.getState().preferences.map.ellipsoidId, "mars");
  });
});
