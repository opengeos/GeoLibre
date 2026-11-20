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

    // Deleting Point 1 and capturing again must not reuse id field-pt-2.
    const afterDelete = {
      type: "FeatureCollection" as const,
      features: second.features.slice(1),
    };
    const third = appendFieldCaptureFeature(afterDelete, {
      lng: -98.4,
      lat: 37.6,
      source: "crosshair",
      capturedAt: "2026-11-19T12:02:00.000Z",
    });
    assert.equal(third.features[1].id, "field-pt-3");
    assert.equal(third.features[1].properties?.name, "Point 3");

    // Passing a persisted next index keeps IDs strictly monotonic even if the newest point is deleted.
    const afterDeleteNewest = {
      type: "FeatureCollection" as const,
      features: third.features.slice(0, 1),
    };
    const fourth = appendFieldCaptureFeature(
      afterDeleteNewest,
      {
        lng: -98.5,
        lat: 37.7,
        source: "crosshair",
        capturedAt: "2026-11-19T12:03:00.000Z",
      },
      4,
    );
    assert.equal(fourth.features[1].id, "field-pt-4");
    assert.equal(fourth.features[1].properties?.name, "Point 4");
  });
});
