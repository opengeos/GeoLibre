import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  createMaptoolkitLogoEngineSync,
  isMaptoolkitBasemapActive,
} from "../apps/geolibre-desktop/src/lib/maptoolkit-basemap";
import {
  newProjectBuiltInControlVisible,
  newProjectToolbarControlVisibility,
} from "../apps/geolibre-desktop/src/components/layout/toolbar/constants";

/** Minimal GeoLibreLayer stub with just the fields the predicate reads. */
function basemapLayer(overrides: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "basemap-x",
    name: "x",
    type: "raster",
    source: {},
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: { basemapProvider: "maptoolkit" },
    ...overrides,
  };
}

describe("isMaptoolkitBasemapActive", () => {
  it("matches a Maptoolkit style basemap by host, including subdomains", () => {
    assert.equal(isMaptoolkitBasemapActive("https://styles.maptoolkit.org/terrain.json", []), true);
    assert.equal(isMaptoolkitBasemapActive("https://maptoolkit.org/style.json", []), true);
  });

  it("does not match a look-alike host that merely contains the string", () => {
    // A loose substring check would false-positive on these.
    assert.equal(isMaptoolkitBasemapActive("https://example.com/maptoolkit.org.json", []), false);
    assert.equal(isMaptoolkitBasemapActive("https://evil.com/?ref=maptoolkit.org", []), false);
  });

  it("ignores a non-URL basemap sentinel without throwing", () => {
    assert.equal(isMaptoolkitBasemapActive("offline-basemap:abc", []), false);
    assert.equal(isMaptoolkitBasemapActive("", []), false);
  });

  it("matches a visible Maptoolkit-tagged raster basemap layer", () => {
    assert.equal(
      isMaptoolkitBasemapActive("https://tiles.openfreemap.org/styles/positron", [basemapLayer()]),
      true,
    );
  });

  it("ignores a hidden Maptoolkit-tagged layer", () => {
    assert.equal(
      isMaptoolkitBasemapActive("https://tiles.openfreemap.org/styles/positron", [
        basemapLayer({ visible: false }),
      ]),
      false,
    );
  });

  it("ignores layers tagged with a different provider", () => {
    assert.equal(
      isMaptoolkitBasemapActive("https://tiles.openfreemap.org/styles/positron", [
        basemapLayer({ metadata: { basemapProvider: "esri" } }),
      ]),
      false,
    );
  });

  it("does not match a Maptoolkit style hidden behind an opaque raster basemap from another provider", () => {
    // Raster basemaps never replace the style — they only stack on top (see
    // registerRasterBasemap) — so picking plain OpenStreetMap tiles over a
    // Maptoolkit style leaves basemapStyleUrl on maptoolkit.org even though
    // its tiles are now fully covered.
    assert.equal(
      isMaptoolkitBasemapActive("https://styles.maptoolkit.org/summer.json", [
        basemapLayer({
          metadata: { sourceKind: "maplibre-basemap-control", basemapProvider: "openstreetmap" },
        }),
      ]),
      false,
    );
  });

  it("still matches a Maptoolkit style under a translucent raster overlay from another provider", () => {
    assert.equal(
      isMaptoolkitBasemapActive("https://styles.maptoolkit.org/summer.json", [
        basemapLayer({
          opacity: 0.5,
          metadata: { sourceKind: "maplibre-basemap-control", basemapProvider: "openstreetmap" },
        }),
      ]),
      true,
    );
  });

  it("still matches a Maptoolkit style under an opaque raster basemap that is itself Maptoolkit", () => {
    assert.equal(
      isMaptoolkitBasemapActive("https://styles.maptoolkit.org/summer.json", [
        basemapLayer({
          metadata: { sourceKind: "maplibre-basemap-control", basemapProvider: "maptoolkit" },
        }),
      ]),
      true,
    );
  });

  it("ignores a hidden opaque raster basemap when deciding whether the style is obscured", () => {
    assert.equal(
      isMaptoolkitBasemapActive("https://styles.maptoolkit.org/summer.json", [
        basemapLayer({
          visible: false,
          metadata: { sourceKind: "maplibre-basemap-control", basemapProvider: "openstreetmap" },
        }),
      ]),
      true,
    );
  });

  it("does not treat an unrelated opaque raster data layer as obscuring the style", () => {
    // Only layers the basemap control itself manages (sourceKind
    // "maplibre-basemap-control") count — a plain XYZ layer added through Add
    // Data is a data overlay, not a basemap replacement.
    assert.equal(
      isMaptoolkitBasemapActive("https://styles.maptoolkit.org/summer.json", [
        basemapLayer({ metadata: {} }),
      ]),
      true,
    );
  });
});

/** A recording stand-in for a map engine's logo toggle. */
function fakeEngine() {
  const calls: boolean[] = [];
  return {
    calls,
    setBuiltInControlVisible: (_control: "maptoolkit-logo", visible: boolean) => {
      calls.push(visible);
      return true;
    },
  };
}

describe("createMaptoolkitLogoEngineSync", () => {
  it("gives a replacement engine the logo after a renderer swap", () => {
    const sync = createMaptoolkitLogoEngineSync();
    const first = fakeEngine();
    sync(first, true);
    assert.deepEqual(first.calls, [true]);
    // The swap publishes a new engine with the Maptoolkit basemap still active.
    const second = fakeEngine();
    sync(second, true);
    assert.deepEqual(second.calls, [true]);
  });

  it("leaves the same engine alone, so a manual toggle survives a style load", () => {
    const sync = createMaptoolkitLogoEngineSync();
    const engine = fakeEngine();
    sync(engine, true);
    sync(engine, true);
    sync(engine, false);
    assert.deepEqual(engine.calls, [true]);
  });

  it("waits for an engine to exist", () => {
    const sync = createMaptoolkitLogoEngineSync();
    sync(null, true);
    const engine = fakeEngine();
    sync(engine, true);
    assert.deepEqual(engine.calls, [true]);
  });
});

describe("newProjectToolbarControlVisibility", () => {
  it("keeps the Maptoolkit logo when the new project opens on a Maptoolkit basemap", () => {
    assert.equal(newProjectBuiltInControlVisible("maptoolkit-logo", true), true);
    assert.equal(newProjectToolbarControlVisibility(true)["maptoolkit-logo"], true);
  });

  it("hides it otherwise and leaves the other defaults as they were", () => {
    assert.equal(newProjectBuiltInControlVisible("maptoolkit-logo", false), false);
    const visible = newProjectToolbarControlVisibility(false);
    assert.equal(visible["maptoolkit-logo"], false);
    assert.equal(visible.fullscreen, true);
    assert.equal(visible.scale, false);
    assert.equal(newProjectBuiltInControlVisible("layer-control", true), true);
    assert.deepEqual(
      newProjectToolbarControlVisibility(true),
      { ...newProjectToolbarControlVisibility(false), "maptoolkit-logo": true },
      "only the Maptoolkit logo follows the basemap",
    );
  });
});
