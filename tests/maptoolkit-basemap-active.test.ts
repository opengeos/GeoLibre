import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { isMaptoolkitBasemapActive } from "../apps/geolibre-desktop/src/lib/maptoolkit-basemap";

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
