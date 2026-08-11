/**
 * Tests for the multiband GeoTIFF spectral profile reader (issue #1818).
 *
 * Exercised against a stub image rather than a real COG: what needs pinning is
 * the pixel indexing (rows run north-to-south, so the y axis inverts against
 * the bounding box), the nodata handling, and the choices about when there is
 * no profile worth charting.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readProfileFromImage,
  type ImageLike,
} from "../packages/plugins/src/plugins/cog-spectral-profile";

interface StubOptions {
  bands?: number;
  bbox?: [number, number, number, number];
  width?: number;
  height?: number;
  nodata?: number | null;
  directory?: Record<string, unknown>;
  geoKeys?: Record<string, unknown>;
  /** Values returned per band; defaults to band index + 1. */
  valueFor?: (band: number, column: number, row: number) => number;
  onRead?: (window: number[]) => void;
}

/** A geotiff.js image stub in EPSG:4326 (no geokeys, so no reprojection). */
function stubImage(options: StubOptions = {}): ImageLike {
  const {
    bands = 7,
    bbox = [-10, -10, 10, 10],
    width = 100,
    height = 100,
    nodata = null,
    directory = {},
    geoKeys,
    valueFor = (band) => band + 1,
    onRead,
  } = options;
  return {
    getBoundingBox: () => bbox,
    getWidth: () => width,
    getHeight: () => height,
    getSamplesPerPixel: () => bands,
    getGeoKeys: () => geoKeys,
    getGDALNoData: () => nodata,
    getFileDirectory: () => directory,
    readRasters: async ({ window }) => {
      onRead?.(window);
      const [column, row] = window;
      return Array.from({ length: bands }, (_, band) => [valueFor(band, column, row)]);
    },
  };
}

describe("readProfileFromImage", () => {
  it("returns one value per band", async () => {
    const profile = await readProfileFromImage(stubImage({ bands: 7 }), 0, 0);
    assert.ok(profile);
    assert.equal(profile.values.length, 7);
    assert.deepEqual(profile.values, [1, 2, 3, 4, 5, 6, 7]);
  });

  it("charts against band number when the file declares no wavelengths", async () => {
    const profile = await readProfileFromImage(stubImage({ bands: 4 }), 0, 0);
    assert.ok(profile);
    assert.equal(profile.axis.name, "band");
    assert.deepEqual(profile.axis.values, [1, 2, 3, 4]);
    assert.equal(profile.axis.size, 4);
  });

  it("charts against wavelength when the file declares them", async () => {
    const profile = await readProfileFromImage(
      stubImage({ bands: 3, directory: { wavelength: [443, 560, 665] } }),
      0,
      0,
    );
    assert.ok(profile);
    assert.equal(profile.axis.name, "wavelength");
    assert.deepEqual(profile.axis.values, [443, 560, 665]);
    assert.equal(profile.axis.units, "nm");
  });

  it("charts against wavelengths written into GDAL_METADATA", async () => {
    // Where GDAL and rasterio actually put them, and so where a real Landsat or
    // Sentinel stack carries them — the flat directory field is the ENVI shape.
    const profile = await readProfileFromImage(
      stubImage({
        bands: 3,
        directory: {
          GDAL_METADATA:
            "<GDALMetadata>" +
            '<Item name="wavelength" sample="0" role="wavelength">443</Item>' +
            '<Item name="wavelength" sample="1" role="wavelength">560</Item>' +
            '<Item name="wavelength" sample="2" role="wavelength">665</Item>' +
            "</GDALMetadata>",
        },
      }),
      0,
      0,
    );
    assert.ok(profile);
    assert.equal(profile.axis.name, "wavelength");
    assert.deepEqual(profile.axis.values, [443, 560, 665]);
  });

  it("orders GDAL_METADATA wavelengths by sample, not by document order", async () => {
    const profile = await readProfileFromImage(
      stubImage({
        bands: 3,
        directory: {
          GDAL_METADATA:
            '<Item name="wavelength" sample="2">665</Item>' +
            '<Item name="wavelength" sample="0">443</Item>' +
            '<Item name="wavelength" sample="1">560</Item>',
        },
      }),
      0,
      0,
    );
    assert.ok(profile);
    assert.deepEqual(profile.axis.values, [443, 560, 665]);
  });

  it("ignores a GDAL_METADATA list that does not cover every band", async () => {
    // A partial list would put the bands it does cover at the wrong place on
    // the axis, which is worse than plotting against band number.
    const profile = await readProfileFromImage(
      stubImage({
        bands: 4,
        directory: {
          GDAL_METADATA:
            '<Item name="wavelength" sample="0">443</Item>' +
            '<Item name="wavelength" sample="1">560</Item>',
        },
      }),
      0,
      0,
    );
    assert.ok(profile);
    assert.equal(profile.axis.name, "band");
  });

  it("ignores a dataset-level wavelength that names no band", async () => {
    const profile = await readProfileFromImage(
      stubImage({
        bands: 2,
        directory: { GDAL_METADATA: '<Item name="wavelength">443</Item>' },
      }),
      0,
      0,
    );
    assert.ok(profile);
    assert.equal(profile.axis.name, "band");
  });

  it("reads a loosely formatted ENVI wavelength list", async () => {
    // Leading whitespace would otherwise split into an empty first element,
    // fail the band-count match, and drop a perfectly good list.
    const profile = await readProfileFromImage(
      stubImage({ bands: 3, directory: { wavelength: " 443, 560, 665 " } }),
      0,
      0,
    );
    assert.ok(profile);
    assert.deepEqual(profile.axis.values, [443, 560, 665]);
  });

  it("ignores a wavelength list that does not match the band count", async () => {
    // A mismatched list is more likely stale metadata than a shorter spectrum;
    // plotting against it would mislabel every point.
    const profile = await readProfileFromImage(
      stubImage({ bands: 5, directory: { wavelength: [443, 560] } }),
      0,
      0,
    );
    assert.ok(profile);
    assert.equal(profile.axis.name, "band");
  });

  it("inverts the y axis, because raster rows run north to south", async () => {
    let seen: number[] = [];
    // A point near the *north* edge must read a row near 0, not near height.
    await readProfileFromImage(
      stubImage({ bbox: [-10, -10, 10, 10], width: 100, height: 100, onRead: (w) => (seen = w) }),
      0,
      9.9,
    );
    assert.ok(seen[1] < 5, `expected a top row for a northern point, got ${seen[1]}`);

    await readProfileFromImage(
      stubImage({ bbox: [-10, -10, 10, 10], width: 100, height: 100, onRead: (w) => (seen = w) }),
      0,
      -9.9,
    );
    assert.ok(seen[1] > 95, `expected a bottom row for a southern point, got ${seen[1]}`);
  });

  it("reads a single-pixel window rather than the whole scene", async () => {
    let seen: number[] = [];
    await readProfileFromImage(stubImage({ onRead: (w) => (seen = w) }), 0, 0);
    assert.equal(seen[2] - seen[0], 1, "window should be one column wide");
    assert.equal(seen[3] - seen[1], 1, "window should be one row tall");
  });

  it("has no profile for a single-band raster", async () => {
    // Identify's existing value readout already covers this case.
    assert.equal(await readProfileFromImage(stubImage({ bands: 1 }), 0, 0), null);
  });

  it("has no profile for a click outside the raster", async () => {
    const image = stubImage({ bbox: [-10, -10, 10, 10] });
    assert.equal(await readProfileFromImage(image, 40, 0), null);
    assert.equal(await readProfileFromImage(image, 0, 40), null);
  });

  it("nulls nodata bands but keeps the rest of the spectrum", async () => {
    const profile = await readProfileFromImage(
      stubImage({ bands: 4, nodata: 3, valueFor: (band) => band + 1 }),
      0,
      0,
    );
    assert.ok(profile);
    assert.deepEqual(profile.values, [1, 2, null, 4]);
  });

  it("has no profile when every band is nodata", async () => {
    // A flat line of nulls says nothing; better to report nothing to chart.
    const profile = await readProfileFromImage(
      stubImage({ bands: 4, nodata: 0, valueFor: () => 0 }),
      0,
      0,
    );
    assert.equal(profile, null);
  });

  it("rejects a wavelength list containing a junk entry", async () => {
    // Filtering the bad entry out would leave a list that still matches the band
    // count, shifting every following wavelength onto the wrong band.
    const profile = await readProfileFromImage(
      stubImage({ bands: 3, directory: { wavelength: [443, "n/a", 560, 665] } }),
      0,
      0,
    );
    assert.ok(profile);
    assert.equal(profile.axis.name, "band", "a junk entry must invalidate the whole list");
  });

  it("still reads a file with no CRS metadata as geographic", async () => {
    const profile = await readProfileFromImage(stubImage({ geoKeys: undefined }), 0, 0);
    assert.ok(profile, "a file without geokeys keeps the geographic fallback");
  });

  it("survives a metadata accessor that throws", async () => {
    // getBoundingBox throws when the image carries no affine transform.
    const image: ImageLike = {
      ...stubImage(),
      getBoundingBox: () => {
        throw new Error("no affine transformation");
      },
    };
    await assert.rejects(async () => {
      await readProfileFromImage(image, 0, 0);
    }, /affine/);
  });

  it("survives a read failure without throwing", async () => {
    const image: ImageLike = {
      ...stubImage(),
      readRasters: async () => {
        throw new Error("range request failed");
      },
    };
    assert.equal(await readProfileFromImage(image, 0, 0), null);
  });
});
