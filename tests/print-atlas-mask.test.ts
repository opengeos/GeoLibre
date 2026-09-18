import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, Point, Polygon } from "geojson";

import {
  clearAtlasFeatureMask,
  showAtlasFeatureMask,
} from "../apps/geolibre-desktop/src/lib/print-atlas-mask";

interface FakeSource {
  data: unknown;
  setData: (data: unknown) => void;
}

class FakeMap {
  layers = new Map<string, unknown>();
  sources = new Map<string, FakeSource>();
  addedBeforeLayerId: string | undefined;
  movedBeforeLayerId: string | undefined;
  moveLayerCallCount = 0;

  getLayer(id: string) {
    return this.layers.get(id);
  }

  addLayer(layer: { id: string }, beforeLayerId?: string) {
    this.layers.set(layer.id, layer);
    this.addedBeforeLayerId = beforeLayerId;
  }

  moveLayer(_id: string, beforeLayerId?: string) {
    this.moveLayerCallCount += 1;
    this.movedBeforeLayerId = beforeLayerId;
  }

  removeLayer(id: string) {
    this.layers.delete(id);
  }

  getSource(id: string) {
    return this.sources.get(id);
  }

  addSource(id: string, source: { data: unknown }) {
    const fakeSource: FakeSource = {
      data: source.data,
      setData: (data) => {
        fakeSource.data = data;
      },
    };
    this.sources.set(id, fakeSource);
  }

  removeSource(id: string) {
    this.sources.delete(id);
  }
}

const polygon: Feature<Polygon> = {
  type: "Feature",
  properties: { name: "coverage" },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
  },
};

describe("atlas feature mask", () => {
  it("adds and clears the temporary mask source and layer", () => {
    const map = new FakeMap();
    assert.equal(showAtlasFeatureMask(map as never, polygon), true);
    assert.equal(map.layers.size, 1);
    assert.equal(map.sources.size, 1);

    clearAtlasFeatureMask(map as never);
    assert.equal(map.layers.size, 0);
    assert.equal(map.sources.size, 0);
  });

  it("reuses the derived mask when the same feature is shown again", () => {
    const map = new FakeMap();
    showAtlasFeatureMask(map as never, polygon);
    const source = map.sources.get("geolibre-print-atlas-mask");
    const firstMask = source?.data;

    showAtlasFeatureMask(map as never, polygon);
    assert.strictEqual(source?.data, firstMask);
    assert.equal(map.layers.size, 1);
    assert.equal(map.sources.size, 1);
  });

  it("places the mask below a requested label layer", () => {
    const map = new FakeMap();
    map.layers.set("graticule-labels", {});

    showAtlasFeatureMask(map as never, polygon, "graticule-labels");
    assert.equal(map.addedBeforeLayerId, "graticule-labels");
  });

  it("falls back to the top when the requested label layer is missing", () => {
    const map = new FakeMap();

    showAtlasFeatureMask(map as never, polygon, "missing-labels");
    assert.equal(map.addedBeforeLayerId, undefined);
  });

  it("moves an existing mask below a requested label layer", () => {
    const map = new FakeMap();
    showAtlasFeatureMask(map as never, polygon);
    map.layers.set("graticule-labels", {});

    showAtlasFeatureMask(map as never, polygon, "graticule-labels");
    assert.equal(map.moveLayerCallCount, 1);
    assert.equal(map.movedBeforeLayerId, "graticule-labels");
  });

  it("does not move the mask before itself", () => {
    const map = new FakeMap();
    showAtlasFeatureMask(map as never, polygon);

    showAtlasFeatureMask(map as never, polygon, "geolibre-print-atlas-mask-fill");
    assert.equal(map.moveLayerCallCount, 0);
  });

  it("rejects a non-polygon feature and removes any previous mask", () => {
    const map = new FakeMap();
    showAtlasFeatureMask(map as never, polygon);
    const point: Feature<Point> = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [1, 1] },
    };

    assert.equal(showAtlasFeatureMask(map as never, point), false);
    assert.equal(map.layers.size, 0);
    assert.equal(map.sources.size, 0);
  });
});
