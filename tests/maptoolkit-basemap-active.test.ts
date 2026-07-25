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
});
