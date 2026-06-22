import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLatLon } from "../apps/geolibre-desktop/src/lib/coordinates";

/** Assert a parsed coordinate is close to the expected lat/lon. */
function assertClose(
  actual: { lat: number; lon: number } | null,
  lat: number,
  lon: number,
  tolerance = 1e-4,
) {
  assert.ok(actual, "expected a parsed coordinate, got null");
  assert.ok(
    Math.abs(actual.lat - lat) <= tolerance,
    `lat ${actual.lat} not within ${tolerance} of ${lat}`,
  );
  assert.ok(
    Math.abs(actual.lon - lon) <= tolerance,
    `lon ${actual.lon} not within ${tolerance} of ${lon}`,
  );
}

describe("parseLatLon — decimal degrees", () => {
  it("parses a comma-separated lat,lon pair", () => {
    assertClose(parseLatLon("51.5074, -0.1278"), 51.5074, -0.1278);
  });

  it("parses a whitespace-separated pair", () => {
    assertClose(parseLatLon("35.475317 -97.514272"), 35.475317, -97.514272);
  });

  it("swaps when the first value is out of latitude range (lon,lat)", () => {
    assertClose(parseLatLon("-97.514272, 35.475317"), 35.475317, -97.514272);
  });

  it("honors hemisphere letters on bare decimals regardless of order", () => {
    assertClose(parseLatLon("0.1278W, 51.5074N"), 51.5074, -0.1278);
  });
});

describe("parseLatLon — DMS", () => {
  it("parses degrees/minutes/seconds with hemisphere letters", () => {
    // 51°30'26"N = 51.5072, 0°07'39"W = -0.1275
    assertClose(parseLatLon(`51°30'26"N, 0°07'39"W`), 51.5072, -0.1275);
  });

  it("parses DMS without a comma between the axes", () => {
    assertClose(parseLatLon(`51°30'26"N 0°07'39"W`), 51.5072, -0.1275);
  });
});

describe("parseLatLon — DDM", () => {
  it("parses degrees and decimal minutes", () => {
    // 51°30.44'N = 51.50733, 0°07.65'W = -0.1275
    assertClose(parseLatLon(`51°30.44'N, 0°07.65'W`), 51.50733, -0.1275);
  });
});

describe("parseLatLon — rejection", () => {
  it("returns null for empty input", () => {
    assert.equal(parseLatLon(""), null);
    assert.equal(parseLatLon("   "), null);
  });

  it("returns null for a single value", () => {
    assert.equal(parseLatLon("51.5074"), null);
  });

  it("returns null for out-of-range coordinates", () => {
    assert.equal(parseLatLon("200, 300"), null);
    assert.equal(parseLatLon(`95°00'00"N, 0°00'00"W`), null);
  });

  it("returns null when both halves name the same axis", () => {
    assert.equal(parseLatLon("51.5N, 0.1N"), null);
  });

  it("returns null for non-coordinate text", () => {
    assert.equal(parseLatLon("hello world"), null);
  });

  it("returns null for malformed minutes >= 60", () => {
    assert.equal(parseLatLon(`51°75'00"N, 0°00'00"W`), null);
  });

  it("returns null for malformed seconds >= 60", () => {
    assert.equal(parseLatLon(`51°30'75"N, 0°00'00"W`), null);
  });

  it("returns null for a leading minus that contradicts the hemisphere", () => {
    assert.equal(parseLatLon("-51.5N, 0.1W"), null);
  });

  it("returns null for decimal degrees with trailing minutes/seconds", () => {
    assert.equal(parseLatLon(`51.5 30 26N, 0 7 39W`), null);
  });
});
