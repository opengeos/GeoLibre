import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGeographicCrs, projectedGeoJsonCrs } from "../apps/geolibre-desktop/src/lib/crs-utils";
import {
  detectCoordinateFields,
  detectDelimitedTextDelimiter,
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
      metadata: {},
    });
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
