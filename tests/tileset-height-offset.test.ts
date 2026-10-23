import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  tilesetHeightOffset,
  tilesetHeightOffsetPatch,
} from "../apps/geolibre-desktop/src/components/panels/style-panel/TilesetHeightOffsetSection";

// The Style panel's height field for a 3D tileset (#3107) reads and writes the
// same `altitudeOffset` the Add Data flows and the Python builders store.

const tileset = (source: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
  ({
    id: "t",
    name: "Tiles",
    type: "3d-tiles",
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    source: { type: "3d-tiles", url: "https://tiles/root.json", ...source },
    metadata: { sourceKind: "3d-tiles-url", ...metadata },
  }) as GeoLibreLayer;

describe("tilesetHeightOffset", () => {
  it("reads the source offset, which is what the renderers apply", () => {
    assert.equal(tilesetHeightOffset(tileset({ altitudeOffset: -43.2 })), -43.2);
    // The metadata mirror alone does not move the tileset, so it is not shown.
    assert.equal(tilesetHeightOffset(tileset({}, { altitudeOffset: 7 })), 0);
  });

  it("treats a missing or non-numeric offset as zero", () => {
    assert.equal(tilesetHeightOffset(tileset({})), 0);
    assert.equal(tilesetHeightOffset(tileset({ altitudeOffset: "abc" })), 0);
  });
});

describe("tilesetHeightOffsetPatch", () => {
  it("writes the offset to source and metadata and keeps every other field", () => {
    const layer = tileset({ requestHeaders: { a: "b" } }, { center: [5, 52] });
    const patch = tilesetHeightOffsetPatch(layer, -12.5);
    assert.deepEqual(patch.source, {
      type: "3d-tiles",
      url: "https://tiles/root.json",
      requestHeaders: { a: "b" },
      altitudeOffset: -12.5,
    });
    assert.deepEqual(patch.metadata, {
      sourceKind: "3d-tiles-url",
      center: [5, 52],
      altitudeOffset: -12.5,
    });
  });
});
