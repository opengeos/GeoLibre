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
  createProjectedReadout,
  DEFAULT_COORDINATE_EPSG_CODE,
  formatCoordinate,
  nextCoordinateFormat,
  normalizeCoordinateEpsgCode,
  normalizeCoordinateFormat,
  parseEpsgCodeInput,
  type CoordinateFormat,
  type ProjectedReadout,
} from "../apps/geolibre-desktop/src/lib/coordinate-format";
import { lngLatToUtm } from "../packages/plugins/src/plugins/maplibre-graticule";
import { createEmptyProject, parseProject, serializeProject } from "../packages/core/src/project";

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
    for (const value of [undefined, null, "", "bng", "MGRS", 42, {}]) {
      assert.equal(normalizeCoordinateFormat(value), "dd");
    }
  });
});

describe("nextCoordinateFormat", () => {
  it("cycles through every format and returns to the start", () => {
    let format: CoordinateFormat = COORDINATE_FORMATS[0];
    const seen: CoordinateFormat[] = [format];
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
    assert.equal(formatCoordinate(WH_LNG, WH_LAT, "bng"), formatCoordinate(WH_LNG, WH_LAT, "dd"));
  });
});

// The USNG standard's own worked example: the Washington Monument is
// 18S UJ 23371 06519. Decoding a 1 m reference gives the square's centre, so
// this is the point that must format back to exactly that reference.
const MONUMENT_LNG = -77.03653728231987;
const MONUMENT_LAT = 38.889805116520165;

describe("formatCoordinate — MGRS and USNG (#2858)", () => {
  it("formats the Washington Monument reference point", () => {
    assert.equal(formatCoordinate(MONUMENT_LNG, MONUMENT_LAT, "mgrs"), "18SUJ2337106519");
    assert.equal(formatCoordinate(MONUMENT_LNG, MONUMENT_LAT, "usng"), "18S UJ 23371 06519");
  });

  it("agrees with the UTM readout's easting and northing", () => {
    // MGRS digits are the UTM easting/northing truncated to the metre within
    // the 100 km square, so they must match the UTM projection the UTM readout
    // uses wherever the zone is a regular one (not the Norway exceptions).
    const points: [number, number][] = [
      [MONUMENT_LNG, MONUMENT_LAT],
      [151.2153, -33.8568], // Sydney Opera House
      [-0.1276, 51.5072], // London
      [139.6917, 35.6895], // Tokyo
      [-43.2105, -22.9519], // Rio de Janeiro
      [18.4241, -33.9249], // Cape Town
    ];
    for (const [lng, lat] of points) {
      const utm = lngLatToUtm(lng, lat);
      assert.ok(utm);
      const mgrs = formatCoordinate(lng, lat, "mgrs");
      const easting = String(Math.floor(utm.easting) % 100_000).padStart(5, "0");
      const northing = String(Math.floor(utm.northing) % 100_000).padStart(5, "0");
      assert.ok(
        mgrs.startsWith(`${utm.zone}${utm.band}`),
        `${mgrs} vs zone ${utm.zone}${utm.band}`,
      );
      assert.ok(mgrs.endsWith(`${easting}${northing}`), `${mgrs} vs ${easting} ${northing}`);
    }
  });

  it("applies the Norway and Svalbard zone exceptions", () => {
    // Bergen is in the widened zone 32V and Longyearbyen in 33X, although by
    // longitude alone they would sit in the regular zones 31 and 33.
    assert.match(formatCoordinate(5.3221, 60.3913, "mgrs"), /^32V/);
    assert.match(formatCoordinate(8.5, 78.2, "mgrs"), /^31X/);
    assert.match(formatCoordinate(10, 78.2, "mgrs"), /^33X/);
  });

  it("falls back to decimal degrees in the polar UPS areas", () => {
    for (const [lng, lat] of [
      [0, 84],
      [0, 89.5],
      [120, -80.5],
      [0, -90],
    ]) {
      for (const format of ["mgrs", "usng"] as const) {
        assert.equal(formatCoordinate(lng, lat, format), formatCoordinate(lng, lat, "dd"));
      }
    }
    // The edges of the grid itself still format.
    assert.match(formatCoordinate(0, 83.99, "mgrs"), /^31X/);
    assert.match(formatCoordinate(0, -80, "mgrs"), /^31C/);
  });

  it("wraps a longitude that has run past the antimeridian", () => {
    assert.equal(formatCoordinate(190, 10, "mgrs"), formatCoordinate(-170, 10, "mgrs"));
    assert.equal(formatCoordinate(-190, 10, "usng"), formatCoordinate(170, 10, "usng"));
  });
});

describe("formatCoordinate — EPSG (#2858)", () => {
  it("projects into Web Mercator", async () => {
    const readout = await createProjectedReadout(3857);
    assert.ok(readout);
    assert.equal(readout.geographic, false);
    const lng = -77.0353;
    const lat = 38.8895;
    // Spherical Mercator, computed independently of proj4.
    const R = 6378137;
    const x = (R * lng * Math.PI) / 180;
    const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    assert.equal(
      formatCoordinate(lng, lat, "epsg", { projected: readout }),
      `${x.toFixed(2)}, ${y.toFixed(2)} (EPSG:3857)`,
    );
  });

  it("matches the UTM readout for a WGS 84 / UTM zone code", async () => {
    const readout = await createProjectedReadout(32618);
    assert.ok(readout);
    const utm = lngLatToUtm(MONUMENT_LNG, MONUMENT_LAT);
    assert.ok(utm);
    const [x, y] = readout.forward(MONUMENT_LNG, MONUMENT_LAT);
    assert.ok(Math.abs(x - utm.easting) < 1e-3, `${x} vs ${utm.easting}`);
    assert.ok(Math.abs(y - utm.northing) < 1e-3, `${y} vs ${utm.northing}`);
    assert.equal(
      formatCoordinate(MONUMENT_LNG, MONUMENT_LAT, "epsg", { projected: readout }),
      `${x.toFixed(2)}, ${y.toFixed(2)} (EPSG:32618)`,
    );
  });

  it("projects into a national grid with a datum shift", async () => {
    // Trafalgar Square on the British National Grid is about 530000E 180400N.
    const readout = await createProjectedReadout(27700);
    assert.ok(readout);
    const [x, y] = readout.forward(-0.1281, 51.508);
    assert.ok(Math.abs(x - 530_000) < 200, `easting ${x}`);
    assert.ok(Math.abs(y - 180_450) < 200, `northing ${y}`);
  });

  it("prints a geographic CRS in degrees", async () => {
    const readout = await createProjectedReadout(4269);
    assert.ok(readout);
    assert.equal(readout.geographic, true);
    assert.match(
      formatCoordinate(-77.0353, 38.8895, "epsg", { projected: readout }),
      /^-77\.03\d{4}, 38\.88\d{4} \(EPSG:4269\)$/,
    );
  });

  it("returns null for a code the EPSG tables do not know", async () => {
    assert.equal(await createProjectedReadout(999_999), null);
  });

  it("falls back to decimal degrees until a projection is available", () => {
    const dd = formatCoordinate(MONUMENT_LNG, MONUMENT_LAT, "dd");
    assert.equal(formatCoordinate(MONUMENT_LNG, MONUMENT_LAT, "epsg"), dd);
    assert.equal(formatCoordinate(MONUMENT_LNG, MONUMENT_LAT, "epsg", { projected: null }), dd);
  });

  it("falls back to decimal degrees when the projection cannot place the point", () => {
    const dd = formatCoordinate(10, 20, "dd");
    const nonFinite: ProjectedReadout = {
      code: 1,
      geographic: false,
      forward: () => [Number.POSITIVE_INFINITY, Number.NaN],
    };
    const throwing: ProjectedReadout = {
      code: 2,
      geographic: false,
      forward: () => {
        throw new Error("outside the projection's domain");
      },
    };
    assert.equal(formatCoordinate(10, 20, "epsg", { projected: nonFinite }), dd);
    assert.equal(formatCoordinate(10, 20, "epsg", { projected: throwing }), dd);
  });
});

describe("EPSG code preference", () => {
  it("defaults to Web Mercator", () => {
    assert.equal(DEFAULT_COORDINATE_EPSG_CODE, 3857);
    for (const value of [undefined, null, 0, -4326, 3857.5, "3857", Number.NaN]) {
      assert.equal(normalizeCoordinateEpsgCode(value), 3857);
    }
    assert.equal(normalizeCoordinateEpsgCode(32618), 32618);
  });

  it("parses typed codes with or without the EPSG prefix", () => {
    assert.equal(parseEpsgCodeInput("3857"), 3857);
    assert.equal(parseEpsgCodeInput(" EPSG:32618 "), 32618);
    assert.equal(parseEpsgCodeInput("epsg 27700"), 27700);
    assert.equal(parseEpsgCodeInput("EPSG::4326"), 4326);
    for (const text of ["", "EPSG:", "0", "-3857", "38.57", "abc", "1234567"]) {
      assert.equal(parseEpsgCodeInput(text), null, text);
    }
  });

  it("round-trips through a saved project and drops invalid values", () => {
    const project = createEmptyProject();
    const preferences = project.preferences;
    assert.ok(preferences);
    project.preferences = {
      ...preferences,
      map: { ...preferences.map, coordinateFormat: "epsg", coordinateEpsgCode: 32618 },
    };
    const restored = parseProject(serializeProject(project)).preferences?.map;
    assert.equal(restored?.coordinateFormat, "epsg");
    assert.equal(restored?.coordinateEpsgCode, 32618);

    const invalid = JSON.parse(serializeProject(project));
    invalid.preferences.map.coordinateEpsgCode = "3857";
    assert.equal(
      parseProject(JSON.stringify(invalid)).preferences?.map.coordinateEpsgCode,
      undefined,
    );
    delete invalid.preferences.map.coordinateEpsgCode;
    assert.equal(
      parseProject(JSON.stringify(invalid)).preferences?.map.coordinateEpsgCode,
      undefined,
    );
  });
});
