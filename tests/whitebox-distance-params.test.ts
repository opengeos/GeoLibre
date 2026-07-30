import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DISTANCE_UNITS,
  degreesToUnit,
  formatDistanceValue,
  isDistanceParameterName,
  metersPerDegreeAt,
  unitToDegrees,
} from "../apps/geolibre-desktop/src/lib/whitebox-distance-params";

describe("isDistanceParameterName", () => {
  it("matches the ground-distance parameters the vector tools expose", () => {
    // Every one of these is a real parameter on a tool whose only dataset input
    // is a vector layer (GeoLibre#1540), so it is measured in the layer's
    // coordinate units.
    for (const name of [
      "spacing",
      "tolerance",
      "snap_tolerance",
      "gap_tolerance",
      "search_radius",
      "radius",
      "max_dist",
      "dist",
      "snap_dist",
      "tolerance_dist",
      "distance",
      "max_distance",
      "search_distance",
      "max_snap_distance",
      "max_offset_distance",
      "segment_length",
      "max_edge_length",
      "max_triangle_edge_length",
      "min_overlap_length",
      "resolution",
      "cell_size",
      "width",
      "height",
    ]) {
      assert.equal(isDistanceParameterName(name), true, name);
    }
  });

  it("leaves parameters that are not a length alone", () => {
    // Counts, angles, weights, times and penalties share a form with the names
    // above but are not in coordinate units, so converting them would be wrong.
    for (const name of [
      "num_samples",
      "iterations",
      "azimuth",
      "altitude",
      "z_factor",
      "turn_penalty",
      "travel_speed",
      "max_route_time",
      "break_duration",
      "filter_size",
      "polynomial_order",
      "min_overlap_fraction",
      "vehicle_capacity",
      "alpha",
      "seed",
    ]) {
      assert.equal(isDistanceParameterName(name), false, name);
    }
  });

  it("only treats width/height as a length when that is the whole name", () => {
    // `width`/`height` are a grid cell's dimensions on the vector grid tools but
    // a pixel count on the photogrammetry ones, so the segment rule is not
    // allowed to reach into a longer name.
    assert.equal(isDistanceParameterName("width"), true);
    assert.equal(isDistanceParameterName("image_width"), false);
    assert.equal(isDistanceParameterName("image_height"), false);
  });

  it("matches whole name segments rather than substrings", () => {
    assert.equal(isDistanceParameterName("distribution"), false);
    assert.equal(isDistanceParameterName("radiused"), false);
    assert.equal(isDistanceParameterName("lengthy"), false);
  });
});

describe("metersPerDegreeAt", () => {
  it("sits between the meridional and parallel scales at mid latitudes", () => {
    // The geometric mean is bracketed by the two axes it averages: ~80.2 km per
    // degree of longitude and ~111.1 km per degree of latitude at 44°N.
    const value = metersPerDegreeAt(44);
    assert.ok(value > 80_000 && value < 111_500, `${value}`);
    assert.ok(Math.abs(value - 94_400) < 200, `${value}`);
  });

  it("is about 111 km at the equator and shrinks toward the poles", () => {
    // The mean of the 110.574 km meridian degree and the 111.319 km equatorial
    // parallel degree.
    assert.ok(Math.abs(metersPerDegreeAt(0) - 110_946) < 200);
    assert.ok(metersPerDegreeAt(60) < metersPerDegreeAt(30));
    assert.equal(metersPerDegreeAt(-44), metersPerDegreeAt(44));
  });

  it("stays positive at the poles, where the parallel scale vanishes", () => {
    // Clamped to ±85°, so a polar layer cannot divide a conversion by zero.
    assert.ok(metersPerDegreeAt(90) > 0);
    assert.equal(metersPerDegreeAt(90), metersPerDegreeAt(85));
  });
});

describe("unitToDegrees / degreesToUnit", () => {
  it("leaves a value in degrees untouched", () => {
    assert.equal(unitToDegrees(0.01, "degrees", 44), 0.01);
    assert.equal(degreesToUnit(0.01, "degrees", 44), 0.01);
  });

  it("converts metres to the degrees the tool will read", () => {
    // 200 m at 44°N, the Points Along Lines case from GeoLibre#1540.
    const degrees = unitToDegrees(200, "meters", 44);
    assert.ok(Math.abs(degrees - 0.00212) < 0.00001, `${degrees}`);
  });

  it("round-trips every unit, so switching the picker keeps the distance", () => {
    for (const unit of DISTANCE_UNITS) {
      const back = degreesToUnit(unitToDegrees(250, unit, 44), unit, 44);
      assert.ok(Math.abs(back - 250) < 1e-9, unit);
    }
  });

  it("scales the ground units against each other", () => {
    assert.ok(
      Math.abs(unitToDegrees(1, "kilometers", 0) - unitToDegrees(1000, "meters", 0)) < 1e-12,
    );
    // A mile is 5280 feet.
    assert.ok(Math.abs(unitToDegrees(1, "miles", 0) - unitToDegrees(5280, "feet", 0)) < 1e-12);
  });
});

describe("formatDistanceValue", () => {
  it("keeps significant digits without trailing zeros", () => {
    assert.equal(formatDistanceValue(0.0106012345, 6), "0.0106012");
    assert.equal(formatDistanceValue(1.5, 6), "1.5");
    assert.equal(formatDistanceValue(200, 6), "200");
    assert.equal(formatDistanceValue(0, 6), "0");
  });

  it("never uses exponent notation, which the tools' parsers may reject", () => {
    // Below 1e-6 a plain Number.toString() would flip to "9e-7".
    for (const value of [9e-7, 1e-9, 0.0000001234]) {
      assert.ok(!formatDistanceValue(value, 8).includes("e"), `${value}`);
    }
    assert.equal(formatDistanceValue(9e-7, 8), "0.0000009");
  });

  it("returns an empty string for a value that is not a number", () => {
    assert.equal(formatDistanceValue(Number.NaN), "");
    assert.equal(formatDistanceValue(Number.POSITIVE_INFINITY), "");
  });
});
