/**
 * Tests for the status bar's coordinate notation switch (issue #1814).
 *
 * The interesting cases are the ones where a format has no answer: UTM is
 * undefined at the poles, and a hand-edited project can carry any string at
 * all. Both must degrade to decimal degrees rather than print something wrong.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COORDINATE_FORMATS,
  formatCoordinate,
  nextCoordinateFormat,
  normalizeCoordinateFormat,
} from "../apps/geolibre-desktop/src/lib/coordinate-format";

// The White House, used by the lab material this was built for.
const WH_LNG = -77.036566;
const WH_LAT = 38.897631;

describe("normalizeCoordinateFormat", () => {
  it("passes through every supported format", () => {
    for (const format of COORDINATE_FORMATS) {
      assert.equal(normalizeCoordinateFormat(format), format);
    }
  });

  it("falls back to decimal degrees for anything else", () => {
    for (const value of [undefined, null, "", "mgrs", 42, {}]) {
      assert.equal(normalizeCoordinateFormat(value), "dd");
    }
  });
});

describe("nextCoordinateFormat", () => {
  it("cycles through every format and returns to the start", () => {
    let format = COORDINATE_FORMATS[0];
    const seen = [format];
    for (let i = 0; i < COORDINATE_FORMATS.length - 1; i += 1) {
      format = nextCoordinateFormat(format);
      seen.push(format);
    }
    assert.deepEqual([...seen].sort(), [...COORDINATE_FORMATS].sort());
    assert.equal(nextCoordinateFormat(format), COORDINATE_FORMATS[0]);
  });
});

describe("formatCoordinate", () => {
  it("renders decimal degrees as lng, lat", () => {
    assert.equal(formatCoordinate(WH_LNG, WH_LAT, "dd"), "-77.03657, 38.89763");
  });

  it("renders DMS latitude-first with hemispheres", () => {
    const text = formatCoordinate(WH_LNG, WH_LAT, "dms");
    assert.match(text, /^38°53'/, `latitude should lead: ${text}`);
    assert.match(text, /N/);
    assert.match(text, /77°2'/);
    assert.match(text, /W/);
  });

  it("renders DDM with decimal minutes and no seconds", () => {
    const text = formatCoordinate(WH_LNG, WH_LAT, "ddm");
    assert.match(text, /^38°53\./, `expected decimal minutes: ${text}`);
    assert.ok(!text.includes('"'), `DDM must not carry seconds: ${text}`);
  });

  it("renders UTM as zone, band, easting and northing", () => {
    const text = formatCoordinate(WH_LNG, WH_LAT, "utm");
    // Washington D.C. sits in zone 18, band S.
    assert.match(text, /^18S /, `unexpected zone designation: ${text}`);
    assert.match(text, /\d+mE /);
    assert.match(text, /\d+mN$/);
  });

  it("falls back to decimal degrees where UTM is undefined", () => {
    // UTM covers -80 to 84; the poles have no zone.
    const north = formatCoordinate(0, 89, "utm");
    const south = formatCoordinate(0, -85, "utm");
    assert.equal(north, formatCoordinate(0, 89, "dd"));
    assert.equal(south, formatCoordinate(0, -85, "dd"));
  });

  it("handles the southern hemisphere and the antimeridian", () => {
    // Sydney: southern band, so the northing uses the 10,000km false northing.
    const sydney = formatCoordinate(151.2093, -33.8688, "utm");
    assert.match(sydney, /^56H /, `unexpected zone: ${sydney}`);
    // Near the antimeridian the zone must still be in range.
    const fiji = formatCoordinate(179.9, -18, "utm");
    assert.match(fiji, /^60K /, `unexpected zone: ${fiji}`);
  });

  it("wraps a longitude that has run past the antimeridian", () => {
    // MapLibre does not wrap lngLat.lng after panning, so it can arrive as 190.
    // Unwrapped, DMS would render 190 degrees east and UTM would pick a zone
    // that does not exist.
    assert.equal(formatCoordinate(190, 10, "dd"), formatCoordinate(-170, 10, "dd"));
    assert.equal(formatCoordinate(190, 10, "dms"), formatCoordinate(-170, 10, "dms"));
    assert.equal(formatCoordinate(-190, 10, "utm"), formatCoordinate(170, 10, "utm"));
    assert.match(formatCoordinate(190, 10, "dms"), /W/, "190E is 170W");
  });

  it("treats an unknown format as decimal degrees", () => {
    // @ts-expect-error deliberately passing an unsupported notation
    assert.equal(formatCoordinate(WH_LNG, WH_LAT, "mgrs"), formatCoordinate(WH_LNG, WH_LAT, "dd"));
  });
});
