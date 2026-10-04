/**
 * Tests for MGRS/USNG and UTM grid-reference parsing and formatting (#2858):
 * the place search resolves typed references locally, and the status-bar
 * readout prints them, so the two must round-trip.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCoordinate } from "../apps/geolibre-desktop/src/lib/coordinate-format";
import { parseLatLon } from "../apps/geolibre-desktop/src/lib/coordinates";
import {
  parseGridReference,
  parseMgrsInput,
  parseUtmReference,
} from "../apps/geolibre-desktop/src/lib/grid-reference";
import { utmToLngLat } from "../packages/plugins/src/plugins/maplibre-graticule";
import {
  lngLatToMgrs,
  lngLatToUsng,
  mgrsToUsng,
  parseMgrsReference,
} from "../packages/plugins/src/plugins/mgrs-reference";

/** Assert two numbers agree within a tolerance. */
function near(actual: number, expected: number, tolerance: number, label = ""): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

describe("parseMgrsReference", () => {
  it("decodes the Washington Monument in MGRS and USNG spellings", () => {
    // 18S UJ 23371 06519 is the monument's reference in the USNG standard. In
    // zone 18 the column U is the third 100 km column (300 km) and the row J
    // sits at 4,300 km, so the square's centre is UTM 18N 323371.5 4306519.5;
    // proj4 unprojects that independently of the mgrs package.
    const expected = utmToLngLat(18, false, 323_371.5, 4_306_519.5);
    assert.ok(expected);
    for (const text of [
      "18SUJ2337106519",
      "18S UJ 23371 06519",
      "18suj2337106519",
      "  18S UJ2337106519 ",
      "18SUJ 23371 06519",
    ]) {
      const match = parseMgrsReference(text);
      assert.ok(match, text);
      near(match.lng, expected[0], 1e-7, `${text} lng`);
      near(match.lat, expected[1], 1e-7, `${text} lat`);
      assert.equal(match.precision, 5);
      assert.equal(match.mgrs, "18SUJ2337106519");
      assert.equal(match.usng, "18S UJ 23371 06519");
    }
  });

  it("accepts every precision from the 100 km square to 1 m", () => {
    const square = parseMgrsReference("18SUJ");
    assert.ok(square);
    assert.equal(square.precision, 0);
    assert.equal(square.usng, "18S UJ");
    // Near the square's grid centre, 50 km into it. `mgrs` averages the
    // square's lon/lat corners rather than unprojecting the grid centre, which
    // differs by a few hundred metres on a 100 km square.
    const centre = utmToLngLat(18, false, 350_000, 4_350_000);
    assert.ok(centre);
    near(square.lng, centre[0], 0.01);
    near(square.lat, centre[1], 0.01);

    for (const [text, precision] of [
      ["18SUJ2306", 2],
      ["18SUJ233065", 3],
      ["18S UJ 2337 0651", 4],
    ] as const) {
      const match = parseMgrsReference(text);
      assert.ok(match, text);
      assert.equal(match.precision, precision);
      // Every coarser reference still contains the monument.
      near(match.lat, 38.8898, 0.5 / 10 ** precision + 0.01, text);
    }
  });

  it("decodes single-digit zones and the southern hemisphere", () => {
    // Honolulu sits in 4Q; Sydney in 56H.
    const honolulu = parseMgrsReference(lngLatToMgrs(-157.8583, 21.3069) ?? "");
    assert.ok(honolulu);
    assert.match(honolulu.mgrs, /^4Q/);
    near(honolulu.lat, 21.3069, 1e-4);
    const sydney = parseMgrsReference("56HLH3436850948");
    assert.ok(sydney);
    near(sydney.lat, -33.8688, 1e-4);
    near(sydney.lng, 151.2093, 1e-4);
    // A zero-padded zone is the same zone.
    assert.deepEqual(parseMgrsReference("04QFJ1234567890"), parseMgrsReference("4QFJ1234567890"));
  });

  it("rejects malformed references", () => {
    for (const text of [
      "",
      "18S",
      "18SU",
      "18SUJ233710651", // odd digit count
      "18S UJ 2337 06519", // unequal halves
      "18SUJ23371065190000", // more than 1 m precision
      "61SUJ2337106519", // zone out of range
      "0SUJ2337106519",
      "18IUJ2337106519", // I is not a band
      "18YUJ2337106519", // polar UPS letters are unsupported
      "ZAH1234512345",
      "18 SUJ2337106519", // zone and band are never split
      "1 MAD", // a street address, not a 100 km square
      "Paris",
    ]) {
      assert.equal(parseMgrsReference(text), null, text);
    }
  });

  it("rejects squares that cannot occur in the stated zone or band", () => {
    // Zone 18 uses columns S–Z; A is a zone 1/4/7… column.
    assert.equal(parseMgrsReference("18SAJ2337106519"), null);
    // Row A in band S decodes south of band S.
    assert.equal(parseMgrsReference("18SUA2337106519"), null);
    // The same row with the band that does contain it is valid.
    assert.ok(parseMgrsReference("18RUA2337106519"));
  });

  it("round-trips formatted references across the whole grid", () => {
    let checked = 0;
    for (let lat = -79.5; lat < 84; lat += 3.7) {
      for (let lng = -179.5; lng < 180; lng += 7.3) {
        for (let precision = 0; precision <= 5; precision += 1) {
          const reference = lngLatToMgrs(lng, lat, precision);
          assert.ok(reference, `${lng},${lat}`);
          const match = parseMgrsReference(reference);
          assert.ok(match, `${reference} from ${lng},${lat}`);
          assert.equal(match.mgrs, reference);
          // Formatting truncates and decoding returns the square's centre, so
          // the point is at most half a square away (about 0.7 m at 1 m).
          if (precision === 5) {
            near(match.lat, lat, 1e-5, reference);
            near(match.lng, lng, 1e-5 / Math.cos((lat * Math.PI) / 180), reference);
          }
          checked += 1;
        }
      }
    }
    assert.ok(checked > 5000);
  });
});

describe("lngLatToMgrs / lngLatToUsng", () => {
  it("formats at a chosen precision and spaces USNG", () => {
    const lng = -77.03653728231987;
    const lat = 38.889805116520165;
    assert.equal(lngLatToMgrs(lng, lat), "18SUJ2337106519");
    assert.equal(lngLatToMgrs(lng, lat, 3), "18SUJ233065");
    assert.equal(lngLatToMgrs(lng, lat, 0), "18SUJ");
    assert.equal(lngLatToUsng(lng, lat), "18S UJ 23371 06519");
    assert.equal(lngLatToUsng(lng, lat, 0), "18S UJ");
  });

  it("returns null outside the UTM latitudes and for non-finite input", () => {
    assert.equal(lngLatToMgrs(0, 84), null);
    assert.equal(lngLatToMgrs(0, -80.01), null);
    assert.equal(lngLatToMgrs(Number.NaN, 0), null);
    assert.equal(lngLatToUsng(0, 90), null);
  });

  it("leaves a malformed reference unchanged when spacing it", () => {
    assert.equal(mgrsToUsng("not a reference"), "not a reference");
    assert.equal(mgrsToUsng("18SUJ123"), "18SUJ123");
    assert.equal(mgrsToUsng("4QFJ1234567890"), "4Q FJ 12345 67890");
  });
});

describe("parseUtmReference", () => {
  // UTM 18N 323394 4307395 is the White House area of Washington, D.C.
  const expected = utmToLngLat(18, false, 323_394, 4_307_395);

  it("reads a zone with a hemisphere or band letter", () => {
    assert.ok(expected);
    for (const text of [
      "18N 323394 4307395",
      "18n 323394 4307395",
      "18 N 323394 4307395",
      "18S 323394 4307395", // band S (32°N–40°N), the readout's own spelling
      "18S 323394mE 4307395mN", // pasted straight from the UTM readout
      "18S, 323394, 4307395",
      "18S 323394.4 4307395.2",
    ]) {
      const match = parseUtmReference(text);
      assert.ok(match, text);
      assert.equal(match.kind, "utm");
      near(match.lon, expected[0], 1e-5, text);
      near(match.lat, expected[1], 1e-5, text);
    }
  });

  it("reads S as the southern hemisphere when the band does not fit", () => {
    // Sydney: a southern northing, which in band S would land far outside it.
    const sydney = parseUtmReference("56S 334369 6250948");
    assert.ok(sydney);
    near(sydney.lat, -33.8688, 1e-4);
    near(sydney.lon, 151.2093, 1e-4);
    // Spelled with Sydney's own band letter, the same coordinate.
    const banded = parseUtmReference("56H 334369 6250948");
    assert.ok(banded);
    near(banded.lat, sydney.lat, 1e-9);
  });

  it("rejects a band letter the northing contradicts", () => {
    // Band T is 40°N–48°N; this northing is at 38.9°N.
    assert.equal(parseUtmReference("18T 323394 4307395"), null);
    // Band H is southern; a northern-hemisphere northing in band H is not.
    assert.equal(parseUtmReference("56H 334369 1000"), null);
  });

  it("rejects out-of-range and malformed input", () => {
    for (const text of [
      "61N 323394 4307395",
      "0N 323394 4307395",
      "18I 323394 4307395",
      "18N 23394 4307395", // easting too small for any zone
      "18N 993394 4307395", // and too large
      "18N 323394 10000001",
      "18N 323394",
      "323394 4307395",
      "18N 323394 4307395 12",
    ]) {
      assert.equal(parseUtmReference(text), null, text);
    }
  });

  it("round-trips the status-bar UTM readout", () => {
    for (const [lng, lat] of [
      [-77.0366, 38.8977],
      [151.2093, -33.8688],
      [-0.1276, 51.5072],
      [-70.6693, -33.4489],
      [179.9, -18],
      [10, 79.5],
    ]) {
      const text = formatCoordinate(lng, lat, "utm");
      const match = parseUtmReference(text);
      assert.ok(match, text);
      near(match.lat, lat, 1e-5, text);
      near(match.lon, lng, 1e-5 / Math.cos((lat * Math.PI) / 180), text);
    }
  });
});

describe("parseGridReference", () => {
  it("routes MGRS/USNG and UTM to their parsers", () => {
    assert.equal(parseGridReference("18SUJ2337106519")?.kind, "mgrs");
    assert.equal(parseGridReference("18S UJ 23371 06519")?.label, "18SUJ2337106519");
    assert.equal(parseGridReference("18N 323394 4307395")?.kind, "utm");
    assert.equal(parseGridReference("18N 323394 4307395")?.label, "18N 323394 4307395");
    assert.deepEqual(parseMgrsInput("18SUJ2337106519"), parseGridReference("18suj2337106519"));
  });

  it("leaves lat/lon, H3 and place text alone", () => {
    for (const text of [
      "38.8895, -77.0353",
      "38°53'22\"N 77°2'7\"W",
      "8a2a1072b59ffff",
      "622236750694711295",
      "Washington Monument",
      "10 Downing Street",
      "1 MAD",
    ]) {
      assert.equal(parseGridReference(text), null, text);
    }
  });

  it("round-trips the MGRS and USNG readouts", () => {
    for (const [lng, lat] of [
      [-77.0366, 38.8977],
      [151.2093, -33.8688],
      [5.3221, 60.3913], // Norway exception zone 32V
      [15.6356, 78.2232], // Svalbard
    ]) {
      for (const format of ["mgrs", "usng"] as const) {
        const text = formatCoordinate(lng, lat, format);
        const match = parseGridReference(text);
        assert.ok(match, text);
        near(match.lat, lat, 2e-5, text);
        near(match.lon, lng, 2e-5 / Math.cos((lat * Math.PI) / 180), text);
      }
    }
  });

  it("is never pre-empted by the lat/lon parser for grid input", () => {
    // The place search tries grid references before lat/lon; these must not
    // also parse as lat/lon, or the order would silently matter.
    for (const text of ["18SUJ2337106519", "18S UJ 23371 06519", "18N 323394 4307395"]) {
      assert.equal(parseLatLon(text), null, text);
    }
  });
});
