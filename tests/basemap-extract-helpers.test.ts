import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baseNameFromUrl,
  coordsFromBbox,
  DEFAULT_ARCHIVE_URL,
  EMPTY_COORDS,
  extractProgressPercent,
  fmtCoord,
  isBboxInvalid,
  isProtomapsCompatible,
  isZoomRangeInvalid,
  packageZoomErrorKey,
  parseBbox,
  PLANET_PROXY_PREFIX,
  seededArchiveUrl,
} from "../apps/geolibre-desktop/src/lib/basemap-extract";

describe("bounding box fields", () => {
  const box = { west: "-10", south: "20", east: "30", north: "40" };

  it("parses a complete, ordered box", () => {
    assert.deepEqual(parseBbox(box), [-10, 20, 30, 40]);
    assert.equal(isBboxInvalid(box), false);
  });

  it("rejects missing, non-numeric, out-of-range and degenerate boxes", () => {
    assert.equal(parseBbox(EMPTY_COORDS), null);
    assert.equal(parseBbox({ ...box, east: "" }), null);
    assert.equal(parseBbox({ ...box, west: "-" }), null);
    assert.equal(parseBbox({ ...box, west: "-181" }), null);
    assert.equal(parseBbox({ ...box, north: "91" }), null);
    assert.equal(parseBbox({ ...box, east: "-10" }), null);
    assert.equal(parseBbox({ ...box, north: "20" }), null);
  });

  it("flags a box as invalid only once every field is filled in", () => {
    assert.equal(isBboxInvalid(EMPTY_COORDS), false);
    assert.equal(isBboxInvalid({ ...box, east: "" }), false);
    assert.equal(isBboxInvalid({ ...box, east: "-20" }), true);
  });

  it("formats a view box to six decimals, clamped to the valid range", () => {
    assert.equal(fmtCoord(1.23456789), "1.234568");
    assert.equal(fmtCoord(2.5), "2.5");
    assert.deepEqual(coordsFromBbox([-200, -95.1, 12.3456789, 100]), {
      west: "-180",
      south: "-90",
      east: "12.345679",
      north: "90",
    });
  });
});

describe("zoom validation", () => {
  it("accepts an integer range within 0 to 30", () => {
    assert.equal(isZoomRangeInvalid("0", "15"), false);
    assert.equal(isZoomRangeInvalid("30", "30"), false);
  });

  it("rejects empty, fractional, out-of-range and reversed ranges", () => {
    assert.equal(isZoomRangeInvalid("", "15"), true);
    assert.equal(isZoomRangeInvalid("0", ""), true);
    assert.equal(isZoomRangeInvalid("1.5", "15"), true);
    assert.equal(isZoomRangeInvalid("-1", "15"), true);
    assert.equal(isZoomRangeInvalid("0", "31"), true);
    assert.equal(isZoomRangeInvalid("10", "9"), true);
  });

  it("explains a package that starts past the map's maximum zoom", () => {
    assert.equal(packageZoomErrorKey(16, 18), null);
    // A package with no recorded zoom is not rejected.
    assert.equal(packageZoomErrorKey(Number.NaN, 18), null);
    assert.equal(packageZoomErrorKey(18, 18), null);
    assert.equal(packageZoomErrorKey(19, 18), "basemapExtract.errorPackageZoom");
    // 24 caps a looser preference; past it no setting can show the package.
    assert.equal(packageZoomErrorKey(24, 30), null);
    assert.equal(packageZoomErrorKey(25, 30), "basemapExtract.errorPackageZoomUnsupported");
    assert.equal(packageZoomErrorKey(19, 18, true), "basemapExtract.errorSavedPackageZoom");
    assert.equal(
      packageZoomErrorKey(25, 30, true),
      "basemapExtract.errorSavedPackageZoomUnsupported",
    );
  });
});

describe("archive URL", () => {
  it("seeds the latest planet build unless a custom host was remembered", () => {
    assert.equal(seededArchiveUrl(null), DEFAULT_ARCHIVE_URL);
    assert.equal(seededArchiveUrl(""), DEFAULT_ARCHIVE_URL);
    assert.equal(seededArchiveUrl(`${PLANET_PROXY_PREFIX}20240101.pmtiles`), DEFAULT_ARCHIVE_URL);
    assert.equal(
      seededArchiveUrl("https://example.com/region.pmtiles"),
      "https://example.com/region.pmtiles",
    );
  });

  it("names the output after the archive file", () => {
    assert.equal(baseNameFromUrl("https://host/a/planet.pmtiles"), "planet");
    assert.equal(baseNameFromUrl("https://host/a/Region.PMTILES?x=1"), "Region");
    assert.equal(baseNameFromUrl("https://host/"), "basemap");
    assert.equal(baseNameFromUrl("https://host/.pmtiles"), "basemap");
    assert.equal(baseNameFromUrl("not a url"), "basemap");
  });

  it("reports download progress as a whole percentage", () => {
    assert.equal(extractProgressPercent(null), 0);
    assert.equal(extractProgressPercent({ dataBytesTotal: 0, dataBytesReceived: 0 }), 0);
    assert.equal(extractProgressPercent({ dataBytesTotal: 3, dataBytesReceived: 1 }), 33);
    assert.equal(extractProgressPercent({ dataBytesTotal: 4, dataBytesReceived: 4 }), 100);
  });
});

describe("Protomaps schema check", () => {
  it("needs earth or water plus a second schema layer", () => {
    assert.equal(isProtomapsCompatible(["earth", "water"]), true);
    assert.equal(isProtomapsCompatible(["water", "roads"]), true);
    assert.equal(isProtomapsCompatible(["earth"]), false);
    assert.equal(isProtomapsCompatible(["roads", "places", "landcover"]), false);
    assert.equal(isProtomapsCompatible(["buildings", "transportation"]), false);
  });

  it("rejects generic layer names whose fields lack a Protomaps kind", () => {
    assert.equal(
      isProtomapsCompatible(["earth", "roads"], { roads: ["kind", "name"], earth: [] }),
      true,
    );
    assert.equal(isProtomapsCompatible(["earth", "roads"], { roads: ["class", "name"] }), false);
    assert.equal(isProtomapsCompatible(["water", "places"], { places: ["name"] }), false);
  });
});
