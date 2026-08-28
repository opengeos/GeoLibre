import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGlobalIdentifyHitDeduper,
  globalIdentifyHitKey,
} from "../packages/map/src/identify-all";

const pointFeature = {
  source: "cities-source",
  sourceLayer: "cities",
  geometry: { type: "Point" },
  properties: { name: "Olympia", population: 55_605 },
};

describe("globalIdentifyHitKey", () => {
  it("deduplicates style-layer copies that share a stable feature id", () => {
    const first = globalIdentifyHitKey("cities", "42", pointFeature);
    const second = globalIdentifyHitKey("cities", "42", {
      ...pointFeature,
      properties: { name: "A style-layer copy may carry different decoded properties" },
    });

    assert.equal(first, second);
  });

  it("keeps identical feature ids separate across sources and source layers", () => {
    const original = globalIdentifyHitKey("cities", "42", pointFeature);
    const otherSource = globalIdentifyHitKey("cities", "42", {
      ...pointFeature,
      source: "historic-cities-source",
    });
    const otherSourceLayer = globalIdentifyHitKey("cities", "42", {
      ...pointFeature,
      sourceLayer: "capitals",
    });

    assert.notEqual(original, otherSource);
    assert.notEqual(original, otherSourceLayer);
  });

  it("deduplicates id-less fill and outline copies without serializing geometry", () => {
    const polygon = {
      source: "regions-source",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-123, 47],
            [-122, 47],
            [-122, 48],
            [-123, 47],
          ],
        ],
      },
      properties: { name: "West" },
    };

    assert.equal(
      globalIdentifyHitKey("regions", null, polygon),
      globalIdentifyHitKey("regions", null, polygon),
    );
    assert.doesNotMatch(globalIdentifyHitKey("regions", null, polygon), /coordinates/);
  });

  it("keeps id-less features with different attributes distinct", () => {
    const original = globalIdentifyHitKey("cities", null, pointFeature);
    const neighbor = globalIdentifyHitKey("cities", null, {
      ...pointFeature,
      properties: { ...pointFeature.properties, name: "Tacoma" },
    });

    assert.notEqual(original, neighbor);
  });

  it("keeps id-less features with equal attributes and different coordinates", () => {
    const accept = createGlobalIdentifyHitDeduper();
    const first = {
      source: "regions-source",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      properties: { category: "unlabeled" },
    };
    const second = {
      ...first,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [2, 2],
            [3, 2],
            [2, 2],
          ],
        ],
      },
    };

    assert.equal(accept("regions", null, first), true);
    assert.equal(accept("regions", null, first), false);
    assert.equal(accept("regions", null, second), true);
  });
});
