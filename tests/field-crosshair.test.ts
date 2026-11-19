import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendFieldCaptureFeature,
  buildFieldCaptureFeature,
} from "../apps/geolibre-desktop/src/lib/field-crosshair";

describe("field crosshair capture helpers", () => {
  it("builds a GeoJSON point feature with metadata", () => {
    const feature = buildFieldCaptureFeature(
      {
        lng: -83.9207,
        lat: 35.9606,
        accuracyM: 4.26,
        source: "gps",
        capturedAt: "2026-11-19T12:00:00.000Z",
      },
      1,
    );
    assert.equal(feature.geometry.type, "Point");
    assert.deepEqual(feature.geometry.coordinates, [-83.9207, 35.9606]);
    assert.equal(feature.properties?.source, "gps");
    assert.equal(feature.properties?.accuracy_m, 4.3);
    assert.equal(feature.properties?.name, "Point 1");
  });

  it("appends captures immutably to an existing collection", () => {
    const first = appendFieldCaptureFeature(undefined, {
      lng: -98.2,
      lat: 37.4,
      source: "crosshair",
      capturedAt: "2026-11-19T12:00:00.000Z",
    });
    const second = appendFieldCaptureFeature(first, {
      lng: -98.3,
      lat: 37.5,
      source: "crosshair",
      capturedAt: "2026-11-19T12:01:00.000Z",
    });
    assert.equal(first.features.length, 1);
    assert.equal(second.features.length, 2);
    assert.equal(second.features[1].properties?.name, "Point 2");
  });
});
