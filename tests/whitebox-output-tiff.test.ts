import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTiff } from "../apps/geolibre-desktop/src/lib/scripting/binary-output";

/** A header only: the sniff never reads past the first four bytes. */
function header(...bytes: number[]): Uint8Array {
  return new Uint8Array([...bytes, 0x00, 0x00, 0x00, 0x00]);
}

describe("Whitebox binary output sniffing", () => {
  it("recognizes every TIFF flavour a raster tool can emit", () => {
    // Several raster tools (slope, aspect, hillshade) declare a generic
    // `file_out` yet write a GeoTIFF; without this they never reach the map.
    assert.equal(isTiff(header(0x49, 0x49, 0x2a, 0x00)), true, "little-endian TIFF");
    assert.equal(isTiff(header(0x4d, 0x4d, 0x00, 0x2a)), true, "big-endian TIFF");
    assert.equal(isTiff(header(0x49, 0x49, 0x2b, 0x00)), true, "little-endian BigTIFF");
    assert.equal(isTiff(header(0x4d, 0x4d, 0x00, 0x2b)), true, "big-endian BigTIFF");
  });

  it("leaves the genuinely file-shaped outputs alone", () => {
    assert.equal(isTiff(header(0x50, 0x41, 0x52, 0x31)), false, "GeoParquet");
    assert.equal(isTiff(header(0x66, 0x67, 0x62, 0x03)), false, "FlatGeobuf");
    assert.equal(isTiff(header(0x50, 0x4b, 0x03, 0x04)), false, "zipped Shapefile");
    assert.equal(isTiff(header(0x89, 0x50, 0x4e, 0x47)), false, "PNG");
    assert.equal(isTiff(new Uint8Array()), false, "empty output");
  });
});
