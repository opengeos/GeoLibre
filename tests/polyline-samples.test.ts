import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { batchDecodePolylines, decodePolylineDetailed } from "@geolibre/core";
import { SAMPLE_POLYLINES } from "../apps/geolibre-desktop/src/lib/polyline-samples";

/**
 * The Add Encoded Polyline Layer dialog offers these as one-click samples. An
 * encoded polyline is opaque, so a sample that decodes to nothing (or to
 * coordinates off the planet) reads as a bug in the decoder rather than as a
 * bad sample. These tests decode each entry exactly the way the dialog does.
 */
describe("Add Data encoded polyline samples", () => {
  for (const sample of SAMPLE_POLYLINES) {
    it(`decodes ${sample.key} into in-bounds line geometry`, () => {
      const fc = batchDecodePolylines(sample.value, {
        precision: sample.precision,
        unescape: sample.unescape ?? true,
      });
      assert.ok(fc.features.length > 0, "sample decoded to no features");
      for (const feature of fc.features) {
        assert.equal(feature.geometry.type, "LineString");
        const coords = feature.geometry.coordinates as [number, number][];
        assert.ok(coords.length >= 2, "line has fewer than two points");
        for (const [lon, lat] of coords) {
          assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180, `longitude ${lon}`);
          assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90, `latitude ${lat}`);
        }
      }
    });
  }

  it("gives the escaped sample a doubled backslash that only decodes once unescaped", () => {
    const sample = SAMPLE_POLYLINES.find((s) => s.key === "addData.polyline.sampleEscaped");
    assert.ok(sample, "escaped sample is missing");
    // A JSON payload carries the backslash doubled; the dialog's unescape step
    // is what collapses it back to the single byte the decoder needs.
    assert.ok(sample.value.includes("\\\\"), "sample carries no escaped backslash");
    assert.equal(sample.unescape, true);
    assert.equal(decodePolylineDetailed(sample.value, sample.precision, true).complete, true);
    assert.equal(decodePolylineDetailed(sample.value, sample.precision, false).complete, false);
  });

  it("decodes the escaped sample to the San Francisco to Monterey route", () => {
    const sample = SAMPLE_POLYLINES.find((s) => s.key === "addData.polyline.sampleEscaped");
    assert.ok(sample);
    const coords = decodePolylineDetailed(sample.value, 5, true).coordinates;
    assert.equal(coords.length, 5);
    assert.ok(Math.abs(coords[0][0] - -122.41958) < 1e-5);
    assert.ok(Math.abs(coords[0][1] - 37.7749) < 1e-5);
    assert.ok(Math.abs(coords[4][0] - -121.8947) < 1e-5);
    assert.ok(Math.abs(coords[4][1] - 36.6002) < 1e-5);
  });
});
