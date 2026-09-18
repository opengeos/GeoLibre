import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGeographicCrs, projectedGeoJsonCrs } from "../apps/geolibre-desktop/src/lib/crs-utils";
import {
  countDelimitedTextRows,
  detectCoordinateFields,
  detectDelimitedTextDelimiter,
  firstDelimitedTextLine,
  hasCompleteHeaderLine,
  parseCoordinate,
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
} from "../apps/geolibre-desktop/src/lib/delimited-text";
import {
  MIN_REFRESH_INTERVAL_MS,
  createWfsGetFeatureUrl,
  getLayerRefreshConfig,
  isRefreshableLayer,
  setLayerRefreshConfig,
} from "../apps/geolibre-desktop/src/lib/layer-refresh";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";

function layer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-a",
    name: "Layer A",
    type: "geojson",
    source: { type: "geojson", url: "https://example.com/data.geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

describe("delimited text parsing", () => {
  it("handles quoted delimiters and duplicate field names", () => {
    const fields = parseDelimitedTextFields(
      'name,name,longitude,latitude\n"Raleigh, NC",capital,-78.638,35.779',
      ",",
    );

    assert.deepEqual(fields, ["name", "name_2", "longitude", "latitude"]);
  });

  it("creates point features and reports skipped coordinate rows", () => {
    const result = parseDelimitedTextLayer(
      [
        "name,longitude,latitude",
        "Valid,-78.638,35.779",
        "Bad longitude,200,35",
        "Bad latitude,-78,95",
      ].join("\n"),
      {
        delimiter: ",",
        longitudeField: "longitude",
        latitudeField: "latitude",
      },
    );

    assert.equal(result.totalRows, 3);
    assert.equal(result.skippedRows, 2);
    assert.equal(result.data.features.length, 1);
    assert.deepEqual(result.data.features[0].geometry.coordinates, [-78.638, 35.779]);
  });

  it("rejects files with no valid coordinates", () => {
    assert.throws(
      () =>
        parseDelimitedTextLayer("lon,lat\nbad,also-bad", {
          delimiter: ",",
          longitudeField: "lon",
          latitudeField: "lat",
        }),
      /No rows contained valid longitude and latitude values/,
    );
  });

  it("accepts comma decimal separators for coordinates", () => {
    const result = parseDelimitedTextLayer(
      ["name;longitude;latitude", "Amsterdam;4,90;52,37"].join("\n"),
      {
        delimiter: ";",
        longitudeField: "longitude",
        latitudeField: "latitude",
      },
    );

    assert.equal(result.data.features.length, 1);
    assert.deepEqual(result.data.features[0].geometry.coordinates, [4.9, 52.37]);
  });

  it("builds a non-spatial attribute table when both coordinate fields are blank", () => {
    const result = parseDelimitedTextLayer(
      ["code;name;chapter", "AVH;Avoine d'hiver;1.1", "BDP;Ble dur de printemps;1.1"].join("\n"),
      {
        delimiter: ";",
        longitudeField: "",
        latitudeField: "",
      },
    );

    assert.equal(result.isTable, true);
    assert.equal(result.totalRows, 2);
    assert.equal(result.skippedRows, 0);
    assert.equal(result.data.features.length, 2);
    assert.equal(result.data.features[0].geometry, null);
    assert.deepEqual(result.data.features[0].properties, {
      code: "AVH",
      name: "Avoine d'hiver",
      chapter: "1.1",
    });
    assert.deepEqual(result.fields, ["code", "name", "chapter"]);
  });

  it("rejects a mixed selection where only one coordinate field is blank", () => {
    assert.throws(
      () =>
        parseDelimitedTextLayer(["name,longitude,latitude", "Raleigh,-78.638,35.779"].join("\n"), {
          delimiter: ",",
          longitudeField: "longitude",
          latitudeField: "",
        }),
      /Select both a longitude and a latitude field/,
    );
    assert.throws(
      () =>
        parseDelimitedTextLayer(["name,longitude,latitude", "Raleigh,-78.638,35.779"].join("\n"), {
          delimiter: ",",
          longitudeField: "",
          latitudeField: "latitude",
        }),
      /Select both a longitude and a latitude field/,
    );
  });

  it("still builds point features (isTable false) when coordinates are provided", () => {
    const result = parseDelimitedTextLayer(
      ["name,longitude,latitude", "Raleigh,-78.638,35.779"].join("\n"),
      {
        delimiter: ",",
        longitudeField: "longitude",
        latitudeField: "latitude",
      },
    );

    assert.equal(result.isTable, false);
    assert.equal(result.data.features.length, 1);
  });

  it("keeps out-of-range coordinates when a projected source CRS is given", () => {
    // UTM zone 43N (EPSG:32643) easting/northing lie far outside the WGS84
    // +/-180 / +/-90 range; without a projected CRS every row would be skipped
    // (issue #1338). The caller reprojects these native coordinates to WGS84.
    const result = parseDelimitedTextLayer(
      ["id,x,y", "1,659319.6360799533,3005510.000378756"].join("\n"),
      {
        delimiter: ",",
        longitudeField: "x",
        latitudeField: "y",
        sourceCrs: "EPSG:32643",
      },
    );

    assert.equal(result.isTable, false);
    assert.equal(result.skippedRows, 0);
    assert.equal(result.data.features.length, 1);
    assert.deepEqual(
      (result.data.features[0].geometry as { coordinates: number[] }).coordinates,
      [659319.6360799533, 3005510.000378756],
    );
  });

  it("still rejects out-of-range coordinates for a WGS84 (blank) CRS", () => {
    assert.throws(
      () =>
        parseDelimitedTextLayer(["id,x,y", "1,659319.6,3005510.0"].join("\n"), {
          delimiter: ",",
          longitudeField: "x",
          latitudeField: "y",
        }),
      /No rows contained valid longitude and latitude values\./,
    );
  });
});

describe("isGeographicCrs", () => {
  it("treats a blank or missing CRS as WGS84", () => {
    assert.equal(isGeographicCrs(""), true);
    assert.equal(isGeographicCrs("   "), true);
    assert.equal(isGeographicCrs(undefined), true);
  });

  it("recognizes WGS84 aliases regardless of case or stray whitespace", () => {
    assert.equal(isGeographicCrs("EPSG:4326"), true);
    assert.equal(isGeographicCrs("epsg:4326"), true);
    assert.equal(isGeographicCrs("EPSG: 4326"), true);
    assert.equal(isGeographicCrs("OGC:CRS84"), true);
    assert.equal(isGeographicCrs("urn:ogc:def:crs:OGC:1.3:CRS84"), true);
  });

  it("treats a projected CRS as non-geographic", () => {
    assert.equal(isGeographicCrs("EPSG:32643"), false);
    assert.equal(isGeographicCrs("EPSG:3857"), false);
    assert.equal(isGeographicCrs("ESRI:102100"), false);
  });
});

describe("projectedGeoJsonCrs", () => {
  const withCrs = (name: string) => ({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name } },
    features: [],
  });

  it("normalizes the projected CRS to EPSG:<code> from the URN and short forms", () => {
    assert.equal(projectedGeoJsonCrs(withCrs("urn:ogc:def:crs:EPSG::26911")), "EPSG:26911");
    assert.equal(projectedGeoJsonCrs(withCrs("EPSG:3857")), "EPSG:3857");
    assert.equal(projectedGeoJsonCrs(withCrs("epsg:32617")), "EPSG:32617");
  });

  it("returns null for a WGS84/CRS84 member", () => {
    assert.equal(projectedGeoJsonCrs(withCrs("urn:ogc:def:crs:EPSG::4326")), null);
    assert.equal(projectedGeoJsonCrs(withCrs("EPSG:4326")), null);
    assert.equal(projectedGeoJsonCrs(withCrs("urn:ogc:def:crs:OGC:1.3:CRS84")), null);
  });

  it("returns null when the crs member is absent, malformed, or not an EPSG code", () => {
    assert.equal(projectedGeoJsonCrs({ type: "FeatureCollection", features: [] }), null);
    assert.equal(projectedGeoJsonCrs({ crs: { properties: {} } }), null);
    assert.equal(projectedGeoJsonCrs(withCrs("ESRI:102100")), null);
    assert.equal(projectedGeoJsonCrs(null), null);
    assert.equal(projectedGeoJsonCrs("not an object"), null);
  });
});

describe("parseCoordinate", () => {
  it("parses dot and comma decimals identically", () => {
    assert.equal(parseCoordinate("-78.638"), -78.638);
    assert.equal(parseCoordinate("-78,638"), -78.638);
  });

  it("treats the right-most separator as the decimal point", () => {
    assert.equal(parseCoordinate("1.234,56"), 1234.56);
    assert.equal(parseCoordinate("1,234.56"), 1234.56);
  });

  it("treats a lone separator as the decimal point", () => {
    assert.equal(parseCoordinate("1,234"), 1.234);
    assert.equal(parseCoordinate("1.234"), 1.234);
  });

  it("returns NaN for empty or unparsable values", () => {
    assert.ok(Number.isNaN(parseCoordinate("")));
    assert.ok(Number.isNaN(parseCoordinate(undefined)));
    assert.ok(Number.isNaN(parseCoordinate("not-a-number")));
  });

  it("reads a bare comma as thousands grouping for projected coordinates", () => {
    // A UTM easting exported with a thousands separator and no decimal must not
    // be mistaken for a decimal (659.319); grouped mode strips the commas.
    assert.equal(parseCoordinate("659,319", { grouped: true }), 659319);
    assert.equal(parseCoordinate("1,234,567", { grouped: true }), 1234567);
    // Without grouped mode (WGS84) the historical decimal reading is preserved.
    assert.equal(parseCoordinate("659,319"), 659.319);
  });

  it("still reads a European decimal comma for projected coordinates", () => {
    // `659319,6` is not a valid thousands layout, so it stays a decimal even in
    // grouped mode; a mixed grouping+decimal value resolves the same way.
    assert.equal(parseCoordinate("659319,6", { grouped: true }), 659319.6);
    assert.equal(parseCoordinate("659319.6", { grouped: true }), 659319.6);
    assert.equal(parseCoordinate("1,234.56", { grouped: true }), 1234.56);
  });

  it("resolves the ambiguous small-magnitude grouped value as thousands (documented)", () => {
    // `45,123` could be 45123 (thousands) or 45.123 (European decimal); it is
    // indistinguishable from the string alone. Grouped mode deliberately chooses
    // the large-magnitude reading, which suits UTM/State-Plane coordinates. This
    // test pins that documented behavior so a future change to the heuristic is
    // a conscious one.
    assert.equal(parseCoordinate("45,123", { grouped: true }), 45123);
  });
});

// The row scanner slices fields out of the source string and streams rows
// instead of appending character by character into a fully materialized
// `string[][]`, which is what made a 146 MB CSV exhaust the renderer heap
// (GeoLibre#1854). These pin the scanner's behavior so that rewrite cannot
// silently regress on the awkward inputs the slicing has to special-case.
describe("delimited text row scanning", () => {
  function table(text: string, delimiter = ",") {
    return parseDelimitedTextLayer(text, {
      delimiter,
      longitudeField: "",
      latitudeField: "",
    });
  }

  it("keeps a newline inside a quoted field", () => {
    const result = table('name,note\nAlice,"line one\nline two"\nBob,plain');
    assert.equal(result.totalRows, 2);
    assert.equal(result.data.features[0].properties?.note, "line one\nline two");
    assert.equal(result.data.features[1].properties?.note, "plain");
  });

  it("unescapes doubled quotes and keeps a bare quote inside an unquoted field", () => {
    const result = table('name,note\n"say ""hi""",6" pipe');
    assert.equal(result.data.features[0].properties?.name, 'say "hi"');
    assert.equal(result.data.features[0].properties?.note, '6" pipe');
  });

  it("strips a leading BOM from the first header name", () => {
    const result = table("﻿name,note\nAlice,hello");
    assert.deepEqual(result.fields, ["name", "note"]);
    assert.equal(result.data.features[0].properties?.name, "Alice");
  });

  it("handles CRLF line endings and a final row with no trailing newline", () => {
    const result = table("name,note\r\nAlice,hello\r\nBob,bye");
    assert.equal(result.totalRows, 2);
    assert.equal(result.data.features[1].properties?.name, "Bob");
  });

  it("skips blank lines between rows", () => {
    const result = table("name,note\n\nAlice,hello\n \nBob,bye\n");
    assert.equal(result.totalRows, 2);
    assert.deepEqual(
      result.data.features.map((feature) => feature.properties?.name),
      ["Alice", "Bob"],
    );
  });

  it("splits on a multi-character delimiter", () => {
    const result = table("name||note\nAlice||hello", "||");
    assert.deepEqual(result.fields, ["name", "note"]);
    assert.equal(result.data.features[0].properties?.note, "hello");
  });

  it("pads short rows and drops columns past the header width", () => {
    const result = table("a,b,c\n1,2\n1,2,3,4");
    assert.equal(result.data.features[0].properties?.c, "");
    assert.deepEqual(result.data.features[1].properties, { a: "1", b: "2", c: "3" });
  });

  it("reads only the header row when just the fields are wanted", () => {
    // A whole file is passed here in practice, so this must not depend on the
    // rest of the text being well-formed.
    assert.deepEqual(parseDelimitedTextFields('name,note\n"unterminated', ","), ["name", "note"]);
  });
});

describe("delimited text row counting and header slicing", () => {
  it("counts data rows, ignoring the header, blank lines, and quoted newlines", () => {
    assert.equal(countDelimitedTextRows('name,note\nAlice,"a\nb"\n\nBob,c\n', ","), 2);
  });

  it("counts nothing for a header-only file or a blank delimiter", () => {
    assert.equal(countDelimitedTextRows("name,note\n", ","), 0);
    assert.equal(countDelimitedTextRows("name,note\nAlice,hello", ""), 0);
  });

  it("returns the header line without its terminator, skipping a BOM", () => {
    assert.equal(firstDelimitedTextLine("a,b\r\n1,2"), "a,b");
    assert.equal(firstDelimitedTextLine("﻿a,b\n1,2"), "a,b");
    assert.equal(firstDelimitedTextLine("a,b"), "a,b");
  });

  it("skips a leading separator-only line, as the row parsers do", () => {
    // The row parsers call a row blank when every field trims to nothing, so
    // `,,,` is a blank row to them. The header scan cannot split on a delimiter
    // it has not detected yet, so it rules out every candidate delimiter to
    // reach the same answer.
    assert.equal(
      firstDelimitedTextLine(",,,\nname,longitude,latitude\nA,1,2"),
      "name,longitude,latitude",
    );
    assert.equal(firstDelimitedTextLine(";;\n\na;b;c"), "a;b;c");
    assert.equal(firstDelimitedTextLine("|||\nx|y"), "x|y");
    assert.deepEqual(parseDelimitedTextFields(",,,\nname,longitude,latitude\nA,1,2", ","), [
      "name",
      "longitude",
      "latitude",
    ]);
    // A line of separators with real content is still the header.
    assert.equal(firstDelimitedTextLine(",,a,,\nb,c"), ",,a,,");
  });

  it("reports whether a prefix holds the header's own terminator", () => {
    assert.equal(hasCompleteHeaderLine("a,b\n1,2"), true);
    assert.equal(hasCompleteHeaderLine("a,b\r\n1,2"), true);
    assert.equal(hasCompleteHeaderLine("a,b\r1,2"), true);
    // Cut mid-header: the prefix ends before any terminator.
    assert.equal(hasCompleteHeaderLine("a,b,c"), false);
    // The trap this exists for: the blank line supplies a line break, but the
    // header after it is still unterminated, so a plain newline test would
    // wrongly call this prefix complete.
    assert.equal(hasCompleteHeaderLine("\n\na,b,c"), false);
    assert.equal(hasCompleteHeaderLine("\n\na,b,c\n1,2,3"), true);
    assert.equal(hasCompleteHeaderLine(""), false);
    assert.equal(hasCompleteHeaderLine("\n \n"), false);
  });

  it("ends the header at a bare CR, so a classic-Mac file is not one long line", () => {
    const bareCr = "name,longitude,latitude\rA,-78.6,35.7\rB,-80.1,36.2\r";
    assert.equal(firstDelimitedTextLine(bareCr), "name,longitude,latitude");
    // The delimiter guess is scored on column count, so feeding it the whole
    // file as the "header" is what makes this worth pinning.
    assert.equal(detectDelimitedTextDelimiter("a;b;c\r1;2;3\r"), ";");
    assert.equal(countDelimitedTextRows(bareCr, ","), 2);
  });

  it("skips blank lines before the header, matching the row parsers", () => {
    // Taking the first physical line would report these as empty files and
    // hand delimiter detection a blank line to guess from.
    assert.equal(firstDelimitedTextLine("\na,b\n1,2"), "a,b");
    assert.equal(firstDelimitedTextLine("\r\n  \r\na;b\r\n1;2"), "a;b");
    assert.equal(firstDelimitedTextLine("﻿\n\na,b"), "a,b");
    assert.equal(firstDelimitedTextLine("\n \n\t\n"), "");
    assert.equal(firstDelimitedTextLine(""), "");
  });
});

describe("delimited text auto-detection", () => {
  it("detects the delimiter that yields the most columns", () => {
    assert.equal(detectDelimitedTextDelimiter("a;b;c\n1;2;3"), ";");
    assert.equal(detectDelimitedTextDelimiter("a\tb\tc\n1\t2\t3"), "\t");
    assert.equal(detectDelimitedTextDelimiter("a,b,c\n1,2,3"), ",");
    assert.equal(detectDelimitedTextDelimiter("a|b|c\n1|2|3"), "|");
  });

  it("falls back to a comma for single-column files", () => {
    assert.equal(detectDelimitedTextDelimiter("name\nAlice\nBob"), ",");
  });

  it("matches common longitude/latitude column names", () => {
    assert.deepEqual(detectCoordinateFields(["name", "Lon", "Lat"]), {
      longitudeField: "Lon",
      latitudeField: "Lat",
    });
    assert.deepEqual(detectCoordinateFields(["X", "Y", "value"]), {
      longitudeField: "X",
      latitudeField: "Y",
    });
  });

  it("prefers a specific name over a generic one regardless of order", () => {
    assert.deepEqual(detectCoordinateFields(["x", "y", "longitude", "latitude"]), {
      longitudeField: "longitude",
      latitudeField: "latitude",
    });
  });

  it("returns null when coordinate columns are missing", () => {
    assert.equal(detectCoordinateFields(["name", "value", "category"]), null);
  });
});

describe("layer refresh helpers", () => {
  it("builds WFS 2.x GetFeature URLs with count and typeNames", () => {
    const url = createWfsGetFeatureUrl({
      endpoint: "https://example.com/wfs?token=abc",
      typeName: "workspace:layer",
      version: "2.0.0",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      maxFeatures: "50",
    });

    assert.equal(
      url,
      "https://example.com/wfs?token=abc&service=WFS&request=GetFeature&version=2.0.0&typeNames=workspace%3Alayer&outputFormat=application%2Fjson&srsName=EPSG%3A4326&count=50",
    );
  });

  it("clamps persisted refresh intervals and omits disabled config", () => {
    const source = layer({
      metadata: { refresh: { enabled: true, intervalMs: 50 } },
    });

    assert.deepEqual(getLayerRefreshConfig(source), {
      enabled: true,
      intervalMs: MIN_REFRESH_INTERVAL_MS,
    });
    assert.deepEqual(setLayerRefreshConfig(source, { enabled: false, intervalMs: 0 }), {
      connection: {
        layerId: "layer-a",
        interval: null,
        lastSyncedAt: null,
        lastError: null,
        onFailure: "keep-last",
      },
      metadata: {},
    });
  });

  it("restores refresh cadence from a persisted connection record", () => {
    const source = layer({
      connection: {
        layerId: "layer-a",
        interval: 300,
        lastSyncedAt: "2026-08-01T12:00:00.000Z",
        lastError: null,
        onFailure: "keep-last",
      },
    });
    assert.deepEqual(getLayerRefreshConfig(source), {
      enabled: true,
      intervalMs: 300_000,
    });
    assert.deepEqual(
      getLayerRefreshConfig({
        ...source,
        connection: { ...source.connection!, interval: Number.MAX_VALUE },
      }),
      { enabled: false, intervalMs: 0 },
    );
    assert.deepEqual(
      getLayerRefreshConfig({
        ...source,
        connection: { ...source.connection!, interval: null },
      }),
      { enabled: false, intervalMs: 0 },
    );
  });

  it("only treats HTTP GeoJSON and WFS sources as refreshable", () => {
    assert.equal(isRefreshableLayer(layer()), true);
    assert.equal(
      isRefreshableLayer(
        layer({
          source: { type: "geojson", url: "/local/data.geojson" },
          sourcePath: "/local/data.geojson",
        }),
      ),
      false,
    );
    assert.equal(
      isRefreshableLayer(
        layer({
          metadata: { externalNativeLayer: true },
        }),
      ),
      false,
    );
  });
});
