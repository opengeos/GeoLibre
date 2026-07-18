import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  MAX_RAT_SYMBOLOGY_CLASSES,
  categoricalBreaks,
  categoricalSymbologyFromRows,
  computeValueCounts,
  gdalAuxXmlUrl,
  parseGdalRat,
  pixelAreaSquareMeters,
  ratRowsToCsv,
  savedRasterAttributeTable,
  seedRatRows,
  type RasterAttributeTableRow,
} from "../apps/geolibre-desktop/src/lib/raster-attribute-table";
import {
  RASTER_MAX_STORED_CLASSES,
  savedRasterSymbology,
} from "../packages/plugins/src/plugins/raster-symbology";

function layerWith(metadata: Record<string, unknown>): GeoLibreLayer {
  return {
    id: "raster-1",
    name: "Landcover",
    type: "cog",
    source: { type: "raster" },
    visible: true,
    opacity: 1,
    style: {},
    metadata,
  } as GeoLibreLayer;
}

function row(
  value: number,
  count: number,
  extra: Partial<RasterAttributeTableRow> = {},
): RasterAttributeTableRow {
  return {
    value,
    count,
    label: extra.label ?? String(value),
    color: extra.color ?? "#336699",
  };
}

describe("computeValueCounts", () => {
  it("counts distinct values and skips nodata and NaN", () => {
    const values = Float32Array.from([1, 1, 2, 3, 3, 3, -9999, NaN, 2]);
    const counts = computeValueCounts(values, -9999);
    assert.ok(counts);
    assert.deepEqual(
      [...counts.entries()].sort((a, b) => a[0] - b[0]),
      [
        [1, 2],
        [2, 2],
        [3, 3],
      ],
    );
  });

  it("keeps the nodata value when the band declares none", () => {
    const counts = computeValueCounts(Float32Array.from([0, 0, 5]), null);
    assert.ok(counts);
    assert.equal(counts.get(0), 2);
    assert.equal(counts.get(5), 1);
  });

  it("returns null when the band exceeds the unique-value cap", () => {
    const values = Float32Array.from({ length: 100 }, (_, i) => i);
    assert.equal(computeValueCounts(values, null, 50), null);
  });
});

describe("MAX_RAT_SYMBOLOGY_CLASSES", () => {
  it("mirrors RASTER_MAX_STORED_CLASSES (kept a copy so the pure lib avoids a value import of @geolibre/plugins)", () => {
    assert.equal(MAX_RAT_SYMBOLOGY_CLASSES, RASTER_MAX_STORED_CLASSES);
  });
});

describe("gdalAuxXmlUrl", () => {
  it("appends .aux.xml to the path, keeping any query string", () => {
    assert.equal(gdalAuxXmlUrl("https://host/data/lc.tif"), "https://host/data/lc.tif.aux.xml");
    assert.equal(
      gdalAuxXmlUrl("https://host/data/lc.tif?X-Amz-Signature=abc&x=1"),
      "https://host/data/lc.tif.aux.xml?X-Amz-Signature=abc&x=1",
    );
  });

  it("returns null for an unparseable URL", () => {
    assert.equal(gdalAuxXmlUrl("not a url"), null);
  });
});

describe("parseGdalRat", () => {
  const PAM = `<PAMDataset>
  <PAMRasterBand band="1">
    <GDALRasterAttributeTable tableType="thematic">
      <FieldDefn index="0"><Name>Value</Name><Type>0</Type><Usage>5</Usage></FieldDefn>
      <FieldDefn index="1"><Name>Count</Name><Type>0</Type><Usage>1</Usage></FieldDefn>
      <FieldDefn index="2"><Name>Class_name</Name><Type>2</Type><Usage>2</Usage></FieldDefn>
      <FieldDefn index="3"><Name>Red</Name><Type>0</Type><Usage>6</Usage></FieldDefn>
      <FieldDefn index="4"><Name>Green</Name><Type>0</Type><Usage>7</Usage></FieldDefn>
      <FieldDefn index="5"><Name>Blue</Name><Type>0</Type><Usage>8</Usage></FieldDefn>
      <Row index="0"><F>1</F><F>120</F><F>Water &amp; wetlands</F><F>0</F><F>0</F><F>255</F></Row>
      <Row index="1"><F>2</F><F>80</F><F>Forest</F><F>0</F><F>128</F><F>0</F></Row>
    </GDALRasterAttributeTable>
  </PAMRasterBand>
</PAMDataset>`;

  it("reads value, count, label and color columns by usage", () => {
    const entries = parseGdalRat(PAM, 1);
    assert.ok(entries);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      value: 1,
      count: 120,
      label: "Water & wetlands",
      color: "#0000ff",
    });
    assert.deepEqual(entries[1], {
      value: 2,
      count: 80,
      label: "Forest",
      color: "#008000",
    });
  });

  it("returns null for a band without a RAT", () => {
    assert.equal(parseGdalRat(PAM, 2), null);
    assert.equal(parseGdalRat("<PAMDataset></PAMDataset>", 1), null);
  });

  it("falls back to field names when usages are generic", () => {
    const xml = `<PAMDataset><PAMRasterBand band="1">
      <GDALRasterAttributeTable>
        <FieldDefn index="0"><Name>VALUE</Name><Usage>0</Usage></FieldDefn>
        <FieldDefn index="1"><Name>LABEL</Name><Usage>0</Usage></FieldDefn>
        <Row index="0"><F>7</F><F>Urban</F></Row>
      </GDALRasterAttributeTable>
    </PAMRasterBand></PAMDataset>`;
    const entries = parseGdalRat(xml, 1);
    assert.ok(entries);
    assert.equal(entries[0].value, 7);
    assert.equal(entries[0].label, "Urban");
    assert.equal(entries[0].color, undefined);
  });

  it("keeps column positions across self-closing empty cells", () => {
    // GDAL serializes an empty string cell as <F />; skipping it would shift
    // every later column of the row one place left.
    const xml = `<PAMDataset><PAMRasterBand band="1">
      <GDALRasterAttributeTable>
        <FieldDefn index="0"><Name>Value</Name><Usage>5</Usage></FieldDefn>
        <FieldDefn index="1"><Name>Class_name</Name><Usage>2</Usage></FieldDefn>
        <FieldDefn index="2"><Name>Red</Name><Usage>6</Usage></FieldDefn>
        <FieldDefn index="3"><Name>Green</Name><Usage>7</Usage></FieldDefn>
        <FieldDefn index="4"><Name>Blue</Name><Usage>8</Usage></FieldDefn>
        <Row index="0"><F>3</F><F /><F>10</F><F>20</F><F>30</F></Row>
      </GDALRasterAttributeTable>
    </PAMRasterBand></PAMDataset>`;
    const entries = parseGdalRat(xml, 1);
    assert.ok(entries);
    assert.equal(entries[0].value, 3);
    assert.equal(entries[0].label, undefined);
    assert.equal(entries[0].color, "#0a141e");
  });

  it("returns null when no field identifies the value column", () => {
    const xml = `<PAMDataset><PAMRasterBand band="1">
      <GDALRasterAttributeTable>
        <FieldDefn index="0"><Name>Whatever</Name><Usage>0</Usage></FieldDefn>
        <Row index="0"><F>7</F></Row>
      </GDALRasterAttributeTable>
    </PAMRasterBand></PAMDataset>`;
    assert.equal(parseGdalRat(xml, 1), null);
  });

  it("derives row values from Row0Min/BinSize linear binning", () => {
    const xml = `<PAMDataset><PAMRasterBand band="1">
      <GDALRasterAttributeTable Row0Min="10" BinSize="5">
        <FieldDefn index="0"><Name>Class_name</Name><Usage>2</Usage></FieldDefn>
        <Row index="0"><F>Low</F></Row>
        <Row index="1"><F>High</F></Row>
      </GDALRasterAttributeTable>
    </PAMRasterBand></PAMDataset>`;
    const entries = parseGdalRat(xml, 1);
    assert.ok(entries);
    assert.deepEqual(
      entries.map((e) => [e.value, e.label]),
      [
        [10, "Low"],
        [15, "High"],
      ],
    );
  });
});

describe("pixelAreaSquareMeters", () => {
  it("multiplies the resolution for a projected raster in meters", () => {
    const area = pixelAreaSquareMeters({
      resX: 30,
      resY: 30,
      originY: 4_000_000,
      height: 100,
      geoKeys: { GTModelTypeGeoKey: 1 },
    });
    assert.equal(area, 900);
  });

  it("returns null for projected units that are not meters", () => {
    const area = pixelAreaSquareMeters({
      resX: 30,
      resY: 30,
      originY: 0,
      height: 100,
      geoKeys: { GTModelTypeGeoKey: 1, ProjLinearUnitsGeoKey: 9002 },
    });
    assert.equal(area, null);
  });

  it("scales degrees by the center latitude for a geographic raster", () => {
    const area = pixelAreaSquareMeters({
      resX: 0.01,
      resY: 0.01,
      originY: 0.5,
      height: 100,
      geoKeys: { GTModelTypeGeoKey: 2 },
    });
    // Center latitude 0: one 0.01 degree pixel is about 1.11 km on each side.
    assert.ok(area !== null);
    assert.ok(Math.abs(area - 0.01 * 111320 * 0.01 * 111132) < 1);
  });

  it("uses the flipY flag for a south-up geographic raster", () => {
    // South-up: originY is the southern edge, so the center is half a span
    // NORTH of it. North-up and south-up rasters covering the same extent
    // must agree on the pixel area.
    const northUp = pixelAreaSquareMeters({
      resX: 0.01,
      resY: 0.01,
      originY: 46,
      height: 200,
      geoKeys: { GTModelTypeGeoKey: 2 },
    });
    const southUp = pixelAreaSquareMeters({
      resX: 0.01,
      resY: 0.01,
      originY: 44,
      height: 200,
      flipY: true,
      geoKeys: { GTModelTypeGeoKey: 2 },
    });
    assert.ok(northUp !== null && southUp !== null);
    assert.ok(Math.abs(northUp - southUp) < 1e-9);
  });

  it("returns null when the model type is unknown", () => {
    assert.equal(
      pixelAreaSquareMeters({
        resX: 1,
        resY: 1,
        originY: 0,
        height: 1,
        geoKeys: {},
      }),
      null,
    );
  });
});

describe("seedRatRows", () => {
  it("prefers RAT labels/colors, then palette colors, then the ramp", () => {
    const counts = new Map([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
    const rows = seedRatRows(counts, {
      rat: [{ value: 1, label: "Water", color: "#0000ff" }],
      palette: new Map([[2, "#00ff00"]]),
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], {
      value: 1,
      count: 10,
      label: "Water",
      color: "#0000ff",
    });
    assert.equal(rows[1].color, "#00ff00");
    assert.equal(rows[1].label, "2");
    assert.match(rows[2].color, /^#[0-9a-f]{6}$/);
  });
});

describe("savedRasterAttributeTable", () => {
  it("round-trips a well-formed record", () => {
    const record = {
      band: 1,
      rows: [row(2, 5), row(1, 3)],
      pixelAreaM2: 900,
    };
    const saved = savedRasterAttributeTable(layerWith({ rasterAttributeTable: record }));
    assert.ok(saved);
    assert.equal(saved.band, 1);
    assert.equal(saved.pixelAreaM2, 900);
    // Rows come back sorted ascending by value.
    assert.deepEqual(
      saved.rows.map((r) => r.value),
      [1, 2],
    );
  });

  it("drops malformed rows and rejects empty tables", () => {
    const saved = savedRasterAttributeTable(
      layerWith({
        rasterAttributeTable: {
          band: 1,
          rows: [
            row(1, 4),
            { value: "x", count: 1, label: "bad", color: "#fff" },
            { value: 2, count: -1, label: "bad", color: "#ffffff" },
            { value: 3, count: 1, label: "bad", color: "not-a-color" },
            { value: 4, count: Number.NaN, label: "bad", color: "#ffffff" },
            { value: 5, count: Infinity, label: "bad", color: "#ffffff" },
          ],
          pixelAreaM2: null,
        },
      }),
    );
    assert.ok(saved);
    assert.equal(saved.rows.length, 1);
    assert.equal(
      savedRasterAttributeTable(layerWith({ rasterAttributeTable: { band: 1, rows: [] } })),
      null,
    );
    assert.equal(savedRasterAttributeTable(layerWith({})), null);
  });
});

describe("categoricalBreaks", () => {
  it("places edges at midpoints with half-gap padding", () => {
    assert.deepEqual(categoricalBreaks([1, 2, 4]), [0.5, 1.5, 3, 4.5]);
  });

  it("pads a single value by half", () => {
    assert.deepEqual(categoricalBreaks([7]), [6.5, 7.5]);
  });
});

describe("categoricalSymbologyFromRows", () => {
  it("builds a manual classified symbology with one class per row", () => {
    const rows = [
      row(1, 10, { color: "#ff0000" }),
      row(2, 20, { color: "#00ff00" }),
      row(4, 5, { color: "#0000ff" }),
    ];
    const result = categoricalSymbologyFromRows(rows);
    assert.ok(result);
    assert.equal(result.symbology.classified, true);
    assert.equal(result.symbology.method, "manual");
    assert.equal(result.symbology.classCount, 3);
    assert.deepEqual(result.symbology.customColors, ["#ff0000", "#00ff00", "#0000ff"]);
    assert.deepEqual(result.symbology.breaks, [0.5, 1.5, 3, 4.5]);
    assert.deepEqual(result.rescale, [[0.5, 4.5]]);
  });

  it("splits a single class in two so the symbology stays valid", () => {
    const result = categoricalSymbologyFromRows([row(5, 9, { color: "#123456" })]);
    assert.ok(result);
    assert.equal(result.symbology.classCount, 2);
    assert.deepEqual(result.symbology.customColors, ["#123456", "#123456"]);
    assert.equal(result.symbology.breaks.length, 3);
  });

  it("rejects empty and oversized tables", () => {
    assert.equal(categoricalSymbologyFromRows([]), null);
    const many = Array.from({ length: MAX_RAT_SYMBOLOGY_CLASSES + 1 }, (_, i) => row(i, 1));
    assert.equal(categoricalSymbologyFromRows(many), null);
  });

  it("produces a symbology savedRasterSymbology accepts beyond 12 classes", () => {
    // A 16-class landcover: more classes than the UI's authoring cap, which
    // the stored-symbology validation must still accept (RASTER_MAX_STORED_CLASSES).
    const rows = Array.from({ length: 16 }, (_, i) =>
      row(i + 1, 10, { color: i % 2 ? "#112233" : "#445566" }),
    );
    const result = categoricalSymbologyFromRows(rows);
    assert.ok(result);
    const saved = savedRasterSymbology(layerWith({ rasterSymbology: result.symbology }));
    assert.ok(saved, "stored categorical symbology must validate");
    assert.equal(saved.classCount, 16);
    assert.equal(saved.breaks.length, 17);
    assert.equal(saved.customColors?.length, 16);
  });
});

describe("ratRowsToCsv", () => {
  it("writes header, percents and areas with RFC 4180 quoting", () => {
    const csv = ratRowsToCsv(
      [row(1, 75, { label: 'Water, "deep"' }), row(2, 25, { label: "Forest" })],
      100,
    );
    const lines = csv.split("\n");
    assert.equal(lines[0], "value,count,percent,area_m2,color,label");
    assert.equal(lines[1], '1,75,75.00,7500.0,#336699,"Water, ""deep"""');
    assert.equal(lines[2], "2,25,25.00,2500.0,#336699,Forest");
  });

  it("omits the area column when the pixel area is unknown", () => {
    const csv = ratRowsToCsv([row(1, 1)], null);
    assert.equal(csv.split("\n")[0], "value,count,percent,color,label");
  });

  it("neutralizes spreadsheet formulas in labels", () => {
    const csv = ratRowsToCsv([row(1, 1, { label: '=HYPERLINK("http://evil")' })], null);
    const label = csv.split("\n")[1].split(",").slice(4).join(",");
    assert.equal(label, '"\'=HYPERLINK(""http://evil"")"');
  });
});
