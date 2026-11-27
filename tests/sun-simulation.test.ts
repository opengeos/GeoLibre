import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SUN_SETTINGS,
  advanceSunClock,
  getSunSettings,
  normalizeSunSettings,
  setSunSettings,
  SUN_SHADE_MAX,
  SUN_SPEED_MAX,
  SUN_SPEED_MIN,
} from "../packages/plugins/src/plugins/maplibre-sun";
import { solarEphemeris, subsolarPoint, sunPosition } from "@geolibre/core";
import { sunPosition as processingSunPosition } from "@geolibre/core/worker-safe";
import { sunPosition as shadowToolSunPosition } from "../packages/processing/src/solar-position";

describe("normalizeSunSettings", () => {
  it("fills defaults for missing/invalid fields", () => {
    const s = normalizeSunSettings({});
    assert.deepEqual(s, DEFAULT_SUN_SETTINGS);
  });

  it("clamps speed and shade into range and coerces types", () => {
    const s = normalizeSunSettings({
      speed: 100000,
      shadeOpacity: 5,
      playing: "yes" as unknown as boolean,
      dateMs: Number.NaN,
    });
    assert.equal(s.speed, SUN_SPEED_MAX);
    assert.equal(s.shadeOpacity, SUN_SHADE_MAX);
    // Non-boolean playing falls back to the default, NaN date to the default.
    assert.equal(s.playing, DEFAULT_SUN_SETTINGS.playing);
    assert.equal(s.dateMs, DEFAULT_SUN_SETTINGS.dateMs);
  });

  it("keeps a valid low speed and floors are respected", () => {
    assert.equal(normalizeSunSettings({ speed: -10 }).speed, SUN_SPEED_MIN);
  });
});

describe("solar declination", () => {
  it("is near +23.4° at the June solstice and near -23.4° at December", () => {
    const june = solarEphemeris(Date.UTC(2024, 5, 20, 20, 51)).declination;
    assert.ok(Math.abs(june - 23.44) < 0.05, `June declination ${june} not near +23.44`);
    const dec = solarEphemeris(Date.UTC(2024, 11, 21, 9, 21)).declination;
    assert.ok(Math.abs(dec + 23.44) < 0.05, `December declination ${dec} not near -23.44`);
  });

  it("is near 0° at the equinoxes", () => {
    const mar = solarEphemeris(Date.UTC(2024, 2, 20, 3, 6)).declination;
    assert.ok(Math.abs(mar) < 0.02, `March declination ${mar}`);
  });
});

describe("subsolarPoint / sunPosition round trip", () => {
  // Sampling several instants across a year is the strongest end-to-end check:
  // the sun must sit ~overhead at its own subsolar point and ~underfoot at the
  // antipode, which only holds if declination, the equation of time and the
  // hour angle all agree.
  const instants = [
    Date.UTC(2024, 0, 5, 3, 0),
    Date.UTC(2024, 3, 15, 12, 30),
    Date.UTC(2024, 6, 21, 18, 45),
    Date.UTC(2024, 9, 2, 6, 15),
    Date.UTC(2025, 1, 11, 21, 0),
  ];

  for (const dateMs of instants) {
    it(`sun is overhead at its subsolar point (${new Date(dateMs).toISOString()})`, () => {
      const { lat, lng } = subsolarPoint(dateMs);
      assert.ok(lng >= -180 && lng < 180, `longitude ${lng} in [-180, 180)`);
      const here = sunPosition(dateMs, lat, lng);
      assert.ok(
        here.geometricElevation > 89.99,
        `elevation ${here.geometricElevation} at subsolar point should be ~90`,
      );
      const anti = sunPosition(dateMs, -lat, lng + 180);
      assert.ok(
        anti.geometricElevation < -89.99,
        `elevation ${anti.geometricElevation} at antipode should be ~-90`,
      );
    });
  }

  it("declination equals the subsolar latitude", () => {
    const dateMs = Date.UTC(2024, 7, 1, 9, 0);
    const { lat } = subsolarPoint(dateMs);
    assert.ok(Math.abs(lat - solarEphemeris(dateMs).declination) < 1e-9);
  });
});

describe("Sun control ephemeris (issue #3698)", () => {
  it("is the same function the Building shadows tool uses", () => {
    // One implementation, re-exported: no second series to drift.
    assert.equal(processingSunPosition, sunPosition);
    assert.equal(shadowToolSunPosition, sunPosition);
  });

  // Near sunrise and sunset, where the old Sun control (no refraction) was up
  // to ~0.6° low. [UTC instant, lat, lon, azimuth, apparent elevation] from
  // pvlib's NREL SPA.
  const cases: [string, number, number, number, number][] = [
    ["2026-03-20T06:10:00Z", 0, 0, 90.142, 1.022],
    ["2026-06-21T09:50:00Z", 40.7, -74.0, 61.528, 3.458],
    ["2026-06-21T00:20:00Z", 40.7, -74.0, 300.786, 1.23],
    ["2026-12-21T21:30:00Z", 40.7, -74.0, 238.895, 0.027],
    ["2026-11-03T06:30:00Z", 0, 0, 105.38, 11.285],
  ];
  for (const [iso, lat, lon, azimuth, elevation] of cases) {
    it(`matches NREL SPA near the horizon at ${iso} (${lat}, ${lon})`, () => {
      const sun = sunPosition(Date.parse(iso), lat, lon);
      assert.ok(
        Math.abs(sun.elevation - elevation) <= 0.05,
        `elevation ${sun.elevation} vs ${elevation}`,
      );
      assert.ok(Math.abs(sun.azimuth - azimuth) <= 0.1, `azimuth ${sun.azimuth} vs ${azimuth}`);
    });
  }
});

describe("advanceSunClock", () => {
  it("loops within the displayed local day", () => {
    const start = new Date(2024, 0, 15, 23, 59, 0).getTime();
    setSunSettings({ ...DEFAULT_SUN_SETTINGS, dateMs: start, loop: true });
    advanceSunClock(2 * 60 * 1000);

    const next = new Date(getSunSettings().dateMs);
    assert.equal(next.getFullYear(), 2024);
    assert.equal(next.getMonth(), 0);
    assert.equal(next.getDate(), 15);
    assert.equal(next.getHours(), 0);
    assert.equal(next.getMinutes(), 1);

    setSunSettings(DEFAULT_SUN_SETTINGS);
  });
});
