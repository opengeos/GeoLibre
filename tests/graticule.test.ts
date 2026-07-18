import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  autoMetricStep,
  DEFAULT_GRATICULE_SETTINGS,
  formatEasting,
  formatLat,
  formatLon,
  formatNorthing,
  getGraticuleSettings,
  maplibreGraticulePlugin,
  normalizeGraticuleSettings,
  setGraticuleSettings,
  utmLatBand,
  utmZoneDesignation,
  utmZoneForLon,
} from "../packages/plugins/src/plugins/maplibre-graticule";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("normalizeGraticuleSettings", () => {
  it("returns the defaults for undefined/empty input", () => {
    assert.deepEqual(normalizeGraticuleSettings(undefined), DEFAULT_GRATICULE_SETTINGS);
    assert.deepEqual(normalizeGraticuleSettings({}), DEFAULT_GRATICULE_SETTINGS);
  });

  it("coerces enum-like fields to their valid values", () => {
    const result = normalizeGraticuleSettings({
      gridType: "nonsense",
      spacingMode: "nonsense",
      labelFormat: "nonsense",
      labelEdges: "nonsense",
    });
    assert.equal(result.gridType, "geographic");
    assert.equal(result.spacingMode, "auto");
    assert.equal(result.labelFormat, "dd");
    assert.equal(result.labelEdges, "left-bottom");

    const fixed = normalizeGraticuleSettings({
      gridType: "utm",
      spacingMode: "fixed",
      labelFormat: "dms",
      labelEdges: "all",
    });
    assert.equal(fixed.gridType, "utm");
    assert.equal(fixed.spacingMode, "fixed");
    assert.equal(fixed.labelFormat, "dms");
    assert.equal(fixed.labelEdges, "all");
  });

  it("clamps the UTM metre interval into its allowed range", () => {
    assert.equal(normalizeGraticuleSettings({ spacingMeters: 5 }).spacingMeters, 100);
    assert.equal(normalizeGraticuleSettings({ spacingMeters: 9_999_999 }).spacingMeters, 1_000_000);
    assert.equal(
      normalizeGraticuleSettings({ spacingMeters: Number.NaN }).spacingMeters,
      DEFAULT_GRATICULE_SETTINGS.spacingMeters,
    );
  });

  it("clamps numeric fields into their allowed range", () => {
    const high = normalizeGraticuleSettings({
      spacingDegrees: 9999,
      lineWidth: 100,
      lineOpacity: 5,
      labelSize: 999,
    });
    assert.equal(high.spacingDegrees, 45);
    assert.equal(high.lineWidth, 6);
    assert.equal(high.lineOpacity, 1);
    assert.equal(high.labelSize, 28);

    const low = normalizeGraticuleSettings({
      lineOpacity: -3,
      lineWidth: 0,
      labelSize: 0,
    });
    assert.equal(low.lineOpacity, 0);
    assert.equal(low.lineWidth, 0.1);
    assert.equal(low.labelSize, 6);
  });

  it("falls back to defaults for non-finite numbers and bad colors", () => {
    const result = normalizeGraticuleSettings({
      spacingDegrees: Number.NaN,
      lineColor: "not-a-color",
      labelColor: "#GGGGGG",
    });
    assert.equal(result.spacingDegrees, DEFAULT_GRATICULE_SETTINGS.spacingDegrees);
    assert.equal(result.lineColor, DEFAULT_GRATICULE_SETTINGS.lineColor);
    assert.equal(result.labelColor, DEFAULT_GRATICULE_SETTINGS.labelColor);
  });

  it("rejects malformed-length and alpha hex colors", () => {
    const result = normalizeGraticuleSettings({
      lineColor: "#12345", // 5 digits
      labelColor: "#11223344", // rrggbbaa, not displayable by the color input
    });
    assert.equal(result.lineColor, DEFAULT_GRATICULE_SETTINGS.lineColor);
    assert.equal(result.labelColor, DEFAULT_GRATICULE_SETTINGS.labelColor);
  });

  it("canonicalizes valid hex colors to lowercase #rrggbb", () => {
    const result = normalizeGraticuleSettings({
      lineColor: "#FF0000",
      labelColor: "#0a0",
    });
    assert.equal(result.lineColor, "#ff0000");
    // Shorthand expands so the native color input can display it.
    assert.equal(result.labelColor, "#00aa00");
  });
});

describe("coordinate label formatting", () => {
  it("formats decimal-degree longitudes with a hemisphere suffix", () => {
    assert.equal(formatLon(-110, 5, "dd"), "110°W");
    assert.equal(formatLon(110, 5, "dd"), "110°E");
    assert.equal(formatLon(0, 5, "dd"), "0°");
  });

  it("formats decimal-degree latitudes with a hemisphere suffix", () => {
    assert.equal(formatLat(50, 5, "dd"), "50°N");
    assert.equal(formatLat(-12.5, 0.5, "dd"), "12.5°S");
    assert.equal(formatLat(0, 5, "dd"), "0°");
  });

  it("normalizes wrapped longitudes into [-180, 180]", () => {
    assert.equal(formatLon(190, 10, "dd"), "170°W");
    assert.equal(formatLon(-190, 10, "dd"), "170°E");
    assert.equal(formatLon(360, 10, "dd"), "0°");
  });

  it("uses more decimals for finer intervals", () => {
    assert.equal(formatLon(1.25, 0.25, "dd"), "1.25°E");
    assert.equal(formatLon(1, 1, "dd"), "1°E");
  });

  it("formats degrees/minutes/seconds", () => {
    assert.equal(formatLon(-122.5, 0.5, "dms"), `122°30'00"W`);
    assert.equal(formatLat(45.50833, 0.1, "dms"), `45°30'30"N`);
    assert.equal(formatLat(0, 5, "dms"), `0°00'00"`);
  });
});

describe("UTM grid helpers", () => {
  it("maps longitudes to their 6°-wide UTM zone", () => {
    assert.equal(utmZoneForLon(-180), 1);
    assert.equal(utmZoneForLon(-177), 1);
    assert.equal(utmZoneForLon(0), 31);
    assert.equal(utmZoneForLon(12), 33);
    assert.equal(utmZoneForLon(179.9), 60);
    // Unwrapped (antimeridian-crossing) longitudes normalize into a valid zone.
    assert.equal(utmZoneForLon(190), utmZoneForLon(-170));
  });

  it("assigns the correct UTM latitude band letter (skips I and O)", () => {
    assert.equal(utmLatBand(0), "N");
    assert.equal(utmLatBand(-0.0001), "M");
    assert.equal(utmLatBand(42), "T");
    assert.equal(utmLatBand(-33), "H");
    // The northernmost band X spans 72°-84°.
    assert.equal(utmLatBand(80), "X");
    assert.equal(utmLatBand(84), "X");
    // Outside the UTM latitude range yields no band.
    assert.equal(utmLatBand(85), "");
    assert.equal(utmLatBand(-81), "");
  });

  it("builds a zone designation from longitude and latitude", () => {
    assert.equal(utmZoneDesignation(12, 42), "33T");
    assert.equal(utmZoneDesignation(21, -33), "34H");
  });

  it("formats metric easting/northing labels", () => {
    assert.equal(formatEasting(500000), "500000mE");
    assert.equal(formatNorthing(4649000.4), "4649000mN");
  });

  it("picks a nice metric auto step scaled to the span", () => {
    // ~200 km across → 100 km lines keep it to ~2 lines? span/step>=4 needs
    // 50 km. A 500 km span comfortably fits 100 km lines.
    assert.equal(autoMetricStep(500000, 400000), 100000);
    // A 2 km view drops to a fine step.
    assert.equal(autoMetricStep(2000, 1500), 500);
    // Degenerate zero span still returns a valid (finest) step.
    assert.equal(autoMetricStep(0, 0), 100);
  });
});

describe("UTM settings project round-trip", () => {
  // getProjectState/applyProjectState read/write the module settings and only
  // touch the map when one is attached, so they run headless here.
  const noopApp = {} as GeoLibreAppAPI;

  it("persists and restores the UTM grid type and metre interval", () => {
    setGraticuleSettings({ gridType: "geographic" }); // reset to a known state
    setGraticuleSettings({ gridType: "utm", spacingMode: "fixed", spacingMeters: 50000 });

    const state = maplibreGraticulePlugin.getProjectState?.(noopApp) as
      | Record<string, unknown>
      | undefined;
    assert.equal(state?.gridType, "utm");
    assert.equal(state?.spacingMeters, 50000);

    // Round-trip through a fresh default state, then back to the saved one.
    setGraticuleSettings({ gridType: "geographic", spacingMode: "auto", spacingMeters: 10000 });
    maplibreGraticulePlugin.applyProjectState?.(noopApp, state);
    const restored = getGraticuleSettings();
    assert.equal(restored.gridType, "utm");
    assert.equal(restored.spacingMode, "fixed");
    assert.equal(restored.spacingMeters, 50000);

    setGraticuleSettings({ ...DEFAULT_GRATICULE_SETTINGS }); // leave defaults for other tests
  });
});
