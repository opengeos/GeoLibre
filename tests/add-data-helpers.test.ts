import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  appendQuery,
  createWmsTileUrl,
  fileNameFromPath,
  geoJsonToPointRows,
  inferDelimitedTextField,
  layerNameFromPath,
  parseOptionalNumber,
  parseRequiredNumber,
  parseVideoCorner,
  resolveDelimitedTextDelimiter,
  savedPostgresConnectionLabel,
} from "../apps/geolibre-desktop/src/components/layout/add-data/helpers";

describe("add-data path helpers", () => {
  it("extracts the file name from POSIX and Windows paths", () => {
    assert.equal(fileNameFromPath("/data/sub/route.gpx"), "route.gpx");
    assert.equal(fileNameFromPath("C:\\data\\route.gpx"), "route.gpx");
    assert.equal(fileNameFromPath("route.gpx"), "route.gpx");
  });

  it("derives a layer name by stripping the extension, with a fallback", () => {
    assert.equal(layerNameFromPath("/data/us_cities.csv", "Layer"), "us_cities");
    assert.equal(layerNameFromPath("/data/.hidden", "Layer"), "Layer");
  });
});

describe("appendQuery", () => {
  it("appends params with the right separator and encodes values", () => {
    assert.equal(
      appendQuery("https://x.test/wms", [["LAYERS", "a:b c"]]),
      "https://x.test/wms?LAYERS=a%3Ab%20c",
    );
    assert.equal(
      appendQuery("https://x.test/wms?foo=1", [["BAR", "2"]]),
      "https://x.test/wms?foo=1&BAR=2",
    );
    assert.equal(
      appendQuery("https://x.test/wms?", [["BAR", "2"]]),
      "https://x.test/wms?BAR=2",
    );
  });

  it("leaves the bbox placeholder unescaped", () => {
    assert.equal(
      appendQuery("https://x.test/wms", [["BBOX", "{bbox-epsg-3857}"]]),
      "https://x.test/wms?BBOX={bbox-epsg-3857}",
    );
  });
});

describe("createWmsTileUrl", () => {
  it("builds a GetMap request with the standard parameters", () => {
    const url = createWmsTileUrl({
      endpoint: "https://x.test/wms",
      layers: "topp:states",
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: 256,
    });
    assert.ok(url.startsWith("https://x.test/wms?SERVICE=WMS&REQUEST=GetMap"));
    assert.ok(url.includes("LAYERS=topp%3Astates"));
    assert.ok(url.includes("TRANSPARENT=TRUE"));
    assert.ok(url.includes("BBOX={bbox-epsg-3857}"));
    assert.ok(url.includes("WIDTH=256"));
  });

  it("marks the request opaque when transparency is off", () => {
    const url = createWmsTileUrl({
      endpoint: "https://x.test/wms",
      layers: "a",
      styles: "",
      format: "image/jpeg",
      transparent: false,
      tileSize: 512,
    });
    assert.ok(url.includes("TRANSPARENT=FALSE"));
    assert.ok(url.includes("HEIGHT=512"));
  });
});

describe("number parsing helpers", () => {
  it("parses required numbers and rejects non-numeric input", () => {
    assert.equal(parseRequiredNumber("42", "value"), 42);
    assert.throws(() => parseRequiredNumber("abc", "value"), /numeric value/);
  });

  it("treats blank optional numbers as undefined", () => {
    assert.equal(parseOptionalNumber("   ", "max features"), undefined);
    assert.equal(parseOptionalNumber("10", "max features"), 10);
    assert.throws(() => parseOptionalNumber("x", "max features"));
  });
});

describe("parseVideoCorner", () => {
  it("parses a longitude, latitude pair", () => {
    assert.deepEqual(parseVideoCorner("-122.5, 37.5", "top-left"), [
      -122.5, 37.5,
    ]);
  });

  it("rejects malformed or out-of-range corners", () => {
    assert.throws(() => parseVideoCorner("1", "top-left"), /longitude, latitude/);
    assert.throws(() => parseVideoCorner("200, 0", "top-left"), /longitude/);
    assert.throws(() => parseVideoCorner("0, 100", "top-left"), /latitude/);
  });
});

describe("resolveDelimitedTextDelimiter", () => {
  it("maps known delimiters and passes custom ones through", () => {
    assert.equal(resolveDelimitedTextDelimiter("comma", ""), ",");
    assert.equal(resolveDelimitedTextDelimiter("tab", ""), "\t");
    assert.equal(resolveDelimitedTextDelimiter("custom", "~"), "~");
  });
});

describe("inferDelimitedTextField", () => {
  const fields = ["City", "Longitude", "Latitude"];

  it("keeps the current field when it still exists (case-insensitive)", () => {
    assert.equal(inferDelimitedTextField(fields, "longitude", []), "Longitude");
  });

  it("falls back to the first matching candidate, then the first field", () => {
    assert.equal(
      inferDelimitedTextField(fields, "missing", ["lat", "latitude"]),
      "Latitude",
    );
    assert.equal(inferDelimitedTextField(fields, "missing", ["nope"]), "City");
  });
});

describe("savedPostgresConnectionLabel", () => {
  it("masks the password in a URL connection string", () => {
    assert.equal(
      savedPostgresConnectionLabel("postgres://user:secret@host:5432/db"),
      "postgres://user:****@host:5432/db",
    );
  });

  it("masks the password in a keyword connection string", () => {
    assert.equal(
      savedPostgresConnectionLabel("host=localhost password=secret dbname=db"),
      "host=localhost password=**** dbname=db",
    );
  });

  it("masks single-quoted passwords that contain spaces", () => {
    assert.equal(
      savedPostgresConnectionLabel("host=a password='my secret' dbname=b"),
      "host=a password=**** dbname=b",
    );
  });

  it("masks every password occurrence, not just the first", () => {
    assert.equal(
      savedPostgresConnectionLabel(
        "host=a password=one application_name=x password=two",
      ),
      "host=a password=**** application_name=x password=****",
    );
  });
});

describe("geoJsonToPointRows", () => {
  it("flattens point features to lng/lat rows with properties", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "A", height: 10 },
          geometry: { type: "Point", coordinates: [-122, 37] },
        },
        {
          type: "Feature",
          properties: null,
          geometry: { type: "Point", coordinates: [1, 2] },
        },
      ],
    };
    assert.deepEqual(geoJsonToPointRows(fc), [
      { name: "A", height: 10, lng: -122, lat: 37 },
      { lng: 1, lat: 2 },
    ]);
  });

  it("uses the first coordinate of nested geometries and skips empty ones", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [5, 6],
              [7, 8],
            ],
          },
        },
        {
          type: "Feature",
          properties: {},
          geometry: { type: "GeometryCollection", geometries: [] } as never,
        },
      ],
    };
    assert.deepEqual(geoJsonToPointRows(fc), [{ lng: 5, lat: 6 }]);
  });

  it("returns an empty array when there is no collection", () => {
    assert.deepEqual(geoJsonToPointRows(undefined), []);
  });

  it("lets geometry coordinates win over lng/lat properties of the same name", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          // Properties carry their own lng/lat that must NOT shadow the
          // geometry-derived placement coordinates.
          properties: { lng: 999, lat: -999, name: "Z" },
          geometry: { type: "Point", coordinates: [-122, 37] },
        },
      ],
    };
    assert.deepEqual(geoJsonToPointRows(fc), [
      { name: "Z", lng: -122, lat: 37 },
    ]);
  });
});
