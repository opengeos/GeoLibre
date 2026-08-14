import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetadataSummary } from "maplibre-gl-raster";
import { rasterInfoFromSummary } from "../apps/geolibre-desktop/src/lib/raster-info";

function summaryWith(overrides: {
  crs?: Partial<MetadataSummary["crs"]>;
  image?: Partial<MetadataSummary["image"]>;
  overviews?: MetadataSummary["overviews"];
}): MetadataSummary {
  return {
    image: {
      width: 8192,
      height: 4096,
      bandCount: 3,
      dtype: "uint8",
      photometric: "RGB",
      compression: "Deflate",
      predictor: null,
      planarConfig: "chunky (interleaved)",
      tileWidth: 512,
      tileHeight: 512,
      nodata: null,
      ...overrides.image,
    },
    crs: {
      code: 32643,
      label: "EPSG:32643",
      citation: "WGS 84 / UTM zone 43N",
      bbox: [736000, 1802000, 736409.6, 1802204.8],
      pixelScale: [0.05, 0.05],
      ...overrides.crs,
    },
    overviews: overrides.overviews ?? [],
    bands: [],
    gdalItems: [],
    rawGdalXml: null,
  };
}

describe("rasterInfoFromSummary", () => {
  it("reports the CRS, pixel size, and storage details a raster layer omits", () => {
    const info = rasterInfoFromSummary(
      summaryWith({
        overviews: [
          { width: 4096, height: 2048, tileWidth: 512, tileHeight: 512, tileCount: { x: 8, y: 4 } },
          { width: 2048, height: 1024, tileWidth: 512, tileHeight: 512, tileCount: { x: 4, y: 2 } },
        ],
      }),
    );

    assert.deepEqual(info, {
      crs: "EPSG:32643",
      epsg: 32643,
      crsCitation: "WGS 84 / UTM zone 43N",
      pixelSize: [0.05, 0.05],
      extent: [736000, 1802000, 736409.6, 1802204.8],
      width: 8192,
      height: 4096,
      bandCount: 3,
      dataType: "uint8",
      nodata: null,
      compression: "Deflate",
      tileSize: [512, 512],
      overviewCount: 2,
    });
  });

  it("reports the pixel size as positive magnitudes", () => {
    // GDAL prints the y size negative (north-up geotransforms count rows
    // downward); ModelPixelScale itself is unsigned, but a file written with a
    // signed scale must not surface as a negative pixel size.
    const info = rasterInfoFromSummary(summaryWith({ crs: { pixelScale: [30, -30] } }));

    assert.deepEqual(info.pixelSize, [30, 30]);
  });

  it("omits the pixel size and citation a file does not carry", () => {
    const info = rasterInfoFromSummary(summaryWith({ crs: { pixelScale: null, citation: null } }));

    assert.equal("pixelSize" in info, false);
    assert.equal("crsCitation" in info, false);
    assert.equal(info.crs, "EPSG:32643");
  });

  it('reports a NaN nodata as "nan" so it is not serialized as null', () => {
    // JSON.stringify(NaN) is `null`, which in the metadata dialog would be
    // indistinguishable from a file that declares no nodata at all.
    const info = rasterInfoFromSummary(summaryWith({ image: { nodata: Number.NaN } }));

    assert.equal(info.nodata, "nan");
    assert.equal(rasterInfoFromSummary(summaryWith({ image: { nodata: 0 } })).nodata, 0);
    assert.equal(rasterInfoFromSummary(summaryWith({})).nodata, null);
  });

  it("keeps a user-defined CRS label with no EPSG code", () => {
    const info = rasterInfoFromSummary(
      summaryWith({ crs: { code: null, label: "User-defined: World_Mollweide" } }),
    );

    assert.equal(info.crs, "User-defined: World_Mollweide");
    assert.equal(info.epsg, null);
  });
});
