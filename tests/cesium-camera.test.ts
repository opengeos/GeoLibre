import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MapViewState } from "../packages/core/src/types";
import {
  cesiumPitchToMapLibreDeg,
  groundResolution,
  isSameView,
  mapLibrePitchToCesiumDeg,
  normalizeBearing,
  rangeToZoom,
  zoomToRange,
} from "../packages/map/src/cesium-camera";

// The pure camera math that keeps the Cesium 3D-globe view in step with the 2D
// MapLibre panes. These functions run without loading Cesium (its import is
// type-only), so they can be exercised directly.

const FOVY = Math.PI / 3; // Cesium's default vertical field of view.
const HEIGHT = 800; // a representative canvas height in px.
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

describe("groundResolution", () => {
  it("matches the Web Mercator metres-per-pixel at the equator", () => {
    // Zoom 0 spans the world in one 512 px tile: circumference / 512.
    const expected = EARTH_CIRCUMFERENCE / 512;
    assert.ok(Math.abs(groundResolution(0, 0) - expected) < 1e-6);
  });

  it("halves for each zoom level", () => {
    assert.ok(Math.abs(groundResolution(1, 0) - groundResolution(0, 0) / 2) < 1e-6);
    assert.ok(Math.abs(groundResolution(5, 0) - groundResolution(4, 0) / 2) < 1e-6);
  });

  it("shrinks with latitude by cos(lat)", () => {
    const atEquator = groundResolution(4, 0);
    const at60 = groundResolution(4, 60);
    assert.ok(Math.abs(at60 - atEquator * Math.cos((60 * Math.PI) / 180)) < 1e-6);
  });

  it("clamps beyond the Mercator limit rather than returning 0 or NaN", () => {
    const r = groundResolution(4, 89);
    assert.ok(Number.isFinite(r) && r > 0);
  });
});

describe("zoomToRange / rangeToZoom", () => {
  it("round-trips zoom through range within tight tolerance", () => {
    for (const zoom of [0, 2, 4.5, 7, 10, 14, 18]) {
      for (const lat of [0, 23.5, 45, -60]) {
        const range = zoomToRange(zoom, lat, HEIGHT, FOVY);
        const back = rangeToZoom(range, lat, HEIGHT, FOVY);
        assert.ok(
          Math.abs(back - zoom) < 1e-9,
          `zoom ${zoom} @ lat ${lat} round-tripped to ${back}`,
        );
      }
    }
  });

  it("gives a larger range for a lower zoom (further out)", () => {
    assert.ok(zoomToRange(2, 0, HEIGHT, FOVY) > zoomToRange(8, 0, HEIGHT, FOVY));
  });

  it("keeps ground scale constant across canvas heights", () => {
    // A taller canvas needs a proportionally larger range to hold the same
    // metres-per-pixel, so range / height is invariant.
    const short = zoomToRange(10, 30, 400, FOVY) / 400;
    const tall = zoomToRange(10, 30, 1200, FOVY) / 1200;
    assert.ok(Math.abs(short - tall) < 1e-6);
  });
});

describe("pitch conversion", () => {
  it("maps MapLibre nadir (0) to Cesium nadir (-90)", () => {
    assert.equal(mapLibrePitchToCesiumDeg(0), -90);
    assert.equal(cesiumPitchToMapLibreDeg(-90), 0);
  });

  it("round-trips a tilted pitch", () => {
    assert.equal(mapLibrePitchToCesiumDeg(60), -30);
    assert.equal(cesiumPitchToMapLibreDeg(-30), 60);
  });

  it("clamps to MapLibre's 0..85 range", () => {
    assert.equal(mapLibrePitchToCesiumDeg(120), 85 - 90);
    assert.equal(cesiumPitchToMapLibreDeg(45), 85); // 45 + 90 clamps to 85
    assert.equal(cesiumPitchToMapLibreDeg(-200), 0);
  });
});

describe("normalizeBearing", () => {
  it("keeps in-range bearings untouched", () => {
    assert.equal(normalizeBearing(0), 0);
    assert.equal(normalizeBearing(45), 45);
    assert.equal(normalizeBearing(-120), -120);
  });

  it("wraps to [-180, 180]", () => {
    assert.equal(normalizeBearing(190), -170);
    assert.equal(normalizeBearing(-190), 170);
    assert.equal(normalizeBearing(360), 0);
    assert.equal(normalizeBearing(540), 180);
  });
});

describe("isSameView", () => {
  const base: MapViewState = {
    center: [-100, 40],
    zoom: 5,
    bearing: 0,
    pitch: 0,
  };

  it("treats a tiny rounding drift as the same view (echo suppression)", () => {
    const echo: MapViewState = {
      center: [-100.000005, 40.000004],
      zoom: 5.005,
      bearing: 0.05,
      pitch: 0.02,
    };
    assert.equal(isSameView(base, echo), true);
  });

  it("treats a real move as a different view", () => {
    assert.equal(isSameView(base, { ...base, zoom: 6 }), false);
    assert.equal(isSameView(base, { ...base, center: [-100.5, 40] }), false);
  });

  it("handles bearing wraparound near 0/360", () => {
    assert.equal(isSameView({ ...base, bearing: 359.95 }, { ...base, bearing: 0.02 }), true);
    assert.equal(isSameView({ ...base, bearing: 355 }, { ...base, bearing: 5 }), false);
  });

  it("handles longitude wraparound across the antimeridian", () => {
    // Two points ~2e-6° apart straddling ±180°: same view despite a ~360 raw diff.
    assert.equal(
      isSameView({ ...base, center: [179.999999, 40] }, { ...base, center: [-179.999999, 40] }),
      true,
    );
    // A genuine move near the antimeridian is still a different view.
    assert.equal(
      isSameView({ ...base, center: [179.9, 40] }, { ...base, center: [-179.9, 40] }),
      false,
    );
  });
});
