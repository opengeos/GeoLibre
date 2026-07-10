import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_GRATICULE_SETTINGS,
  formatLat,
  formatLon,
  formatUtmEasting,
  formatUtmNorthing,
  normalizeGraticuleSettings,
  utmLatBand,
  utmZoneFromLon,
} from "../packages/plugins/src/plugins/maplibre-graticule";

describe("normalizeGraticuleSettings", () => {
  it("returns the defaults for undefined/empty input", () => {
    assert.deepEqual(normalizeGraticuleSettings(undefined), DEFAULT_GRATICULE_SETTINGS);
    assert.deepEqual(normalizeGraticuleSettings({}), DEFAULT_GRATICULE_SETTINGS);
  });

  it("coerces enum-like fields to their valid values", () => {
    const result = normalizeGraticuleSettings({
      spacingMode: "nonsense",
      labelFormat: "nonsense",
      labelEdges: "nonsense",
    });
    assert.equal(result.spacingMode, "auto");
    assert.equal(result.labelFormat, "dd");
    assert.equal(result.labelEdges, "left-bottom");

    const fixed = normalizeGraticuleSettings({
      spacingMode: "fixed",
      labelFormat: "dms",
      labelEdges: "all",
    });
    assert.equal(fixed.spacingMode, "fixed");
    assert.equal(fixed.labelFormat, "dms");
    assert.equal(fixed.labelEdges, "all");
  });

  it("defaults and coerces the UTM grid-system fields", () => {
    assert.equal(
      normalizeGraticuleSettings(undefined).gridSystem,
      "geographic",
    );
    assert.equal(normalizeGraticuleSettings({ gridSystem: "utm" }).gridSystem, "utm");
    assert.equal(
      normalizeGraticuleSettings({ gridSystem: "nonsense" }).gridSystem,
      "geographic",
    );
    // spacingMeters clamps into [1, 1_000_000] and falls back to the default.
    assert.equal(normalizeGraticuleSettings({ spacingMeters: 0 }).spacingMeters, 1);
    assert.equal(
      normalizeGraticuleSettings({ spacingMeters: 9_999_999 }).spacingMeters,
      1_000_000,
    );
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

describe("UTM helpers", () => {
  it("maps longitudes to their UTM zone (1-60)", () => {
    assert.equal(utmZoneFromLon(-180), 1);
    assert.equal(utmZoneFromLon(-123), 10); // San Francisco
    assert.equal(utmZoneFromLon(0), 31);
    assert.equal(utmZoneFromLon(6), 32);
    assert.equal(utmZoneFromLon(44.8), 38); // Tbilisi
    assert.equal(utmZoneFromLon(179.9), 60);
  });

  it("wraps out-of-range longitudes into a valid zone", () => {
    assert.equal(utmZoneFromLon(200), utmZoneFromLon(-160));
    assert.equal(utmZoneFromLon(-181), 60);
    assert.equal(utmZoneFromLon(360), 31);
  });

  it("returns the MGRS latitude band letter, skipping I and O", () => {
    assert.equal(utmLatBand(0), "N");
    assert.equal(utmLatBand(41.7), "T"); // Georgia -> 38T
    assert.equal(utmLatBand(-80), "C");
    assert.equal(utmLatBand(83), "X"); // final band spans 72-84
    assert.equal(utmLatBand(-8), "M");
    // No band exists outside the UTM latitude range.
    assert.equal(utmLatBand(-80.1), "");
    assert.equal(utmLatBand(84.1), "");
  });

  it("formats easting/northing edge labels in metres", () => {
    assert.equal(formatUtmEasting(500000), "500000mE");
    assert.equal(formatUtmNorthing(4649000), "4649000mN");
    // Sub-metre precision is rounded away.
    assert.equal(formatUtmEasting(500000.4), "500000mE");
    assert.equal(formatUtmNorthing(4648999.6), "4649000mN");
  });
});
