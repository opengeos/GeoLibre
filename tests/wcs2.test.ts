import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DOMParser } from "linkedom";
import {
  parseWcsCapabilities,
  parseWcsDescription,
  wcsCoverageUrl,
  wcsTiffBytes,
  WcsError,
} from "../apps/geolibre-desktop/src/lib/wcs";

const originalParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: DOMParser });
after(() => {
  if (originalParser) Object.defineProperty(globalThis, "DOMParser", originalParser);
  else Reflect.deleteProperty(globalThis, "DOMParser");
});

function fixture(name: string) {
  const bytes = readFileSync(new URL(`./fixtures/wcs2/${name}`, import.meta.url));
  return name.endsWith(".b64") ? Buffer.from(bytes.toString(), "base64") : bytes;
}

function description(provider = "usgs") {
  const name = provider === "usgs" ? "DEP3Elevation" : "ndvi";
  const service = parseWcsCapabilities(fixture(`${provider}-capabilities.xml`).toString()).find(
    (item) => item.name === name,
  )!;
  return parseWcsDescription(fixture(`${provider}-description.xml`).toString(), name, service);
}

test("discovers the real MapServer WCS 2.0.1 coverages", () => {
  const xml = readFileSync(
    new URL("./fixtures/wcs2/mapserver-capabilities.xml", import.meta.url),
    "utf8",
  );
  const coverages = parseWcsCapabilities(xml);
  assert.deepEqual(
    coverages.map((coverage) => coverage.name),
    ["ndvi", "fpar", "modis"],
  );
});

test("discovers the real USGS WCS 2.0.1 geographic extent", () => {
  const xml = readFileSync(
    new URL("./fixtures/wcs2/usgs-capabilities.xml", import.meta.url),
    "utf8",
  );
  const terrain = parseWcsCapabilities(xml).find((coverage) => coverage.name === "DEP3Elevation");
  assert.ok(terrain?.bounds);
  const [west, south, east, north] = terrain.bounds;
  assert.ok(west < -179 && east > 179);
  assert.ok(south < -14 && north > 83);
});

test("builds the public USGS numerical subset with repeated axes and a pixel cap", () => {
  const info = description();
  assert.deepEqual(info.axes, { x: "x", y: "y" });
  assert.deepEqual(info.gridAxes, { x: "x", y: "y" });
  const url = new URL(
    wcsCoverageUrl(
      "https://example.org/wcs?token=a%2Bb&ScaleFactor=50&subset=old&outputCRS=old",
      "DEP3Elevation",
      [-89.5, 40, -89.48, 40.02],
      64,
      32,
      info,
    ),
  );
  assert.equal(url.searchParams.get("VERSION"), "2.0.1");
  assert.equal(url.searchParams.get("COVERAGEID"), "DEP3Elevation");
  assert.deepEqual(url.searchParams.getAll("SUBSET"), ["x(-89.5,-89.48)", "y(40,40.02)"]);
  assert.equal(url.searchParams.get("SCALESIZE"), "x(64),y(32)");
  assert.equal(url.searchParams.get("SUBSETTINGCRS"), "http://www.opengis.net/def/crs/EPSG/0/4326");
  assert.equal(url.searchParams.get("token"), "a+b");
  for (const key of ["ScaleFactor", "subset", "outputCRS", "COVERAGE", "WIDTH", "BBOX"])
    assert.equal(url.searchParams.has(key), false);
  assert.equal(description("mapserver").nativeCrs, "EPSG:26915");
});

test("honors latitude-first coverage axes and independent, transposed grid axes", () => {
  const service = parseWcsCapabilities(fixture("usgs-capabilities.xml").toString())[0];
  const xml = fixture("usgs-description.xml")
    .toString()
    .replace(
      /<gml:Envelope\b[^>]*>[\s\S]*?<\/gml:Envelope>/,
      `
      <gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/4326"
        axisLabels="Lat Long" uomLabels="deg deg" srsDimension="2">
        <gml:lowerCorner>2 1</gml:lowerCorner><gml:upperCorner>4 3</gml:upperCorner>
      </gml:Envelope>`,
    )
    .replace(
      /<gml:domainSet>[\s\S]*?<\/gml:domainSet>/,
      `
      <gml:domainSet><gml:RectifiedGrid dimension="2" gml:id="latitude_first">
        <gml:limits><gml:GridEnvelope><gml:low>0 0</gml:low>
          <gml:high>39 79</gml:high></gml:GridEnvelope></gml:limits>
        <gml:axisLabels>row col</gml:axisLabels>
        <gml:origin><gml:Point gml:id="origin" srsName="http://www.opengis.net/def/crs/EPSG/0/4326">
          <gml:pos>3.975 1.0125</gml:pos></gml:Point></gml:origin>
        <gml:offsetVector srsName="EPSG:4326">-0.05 0</gml:offsetVector>
        <gml:offsetVector srsName="EPSG:4326">0 0.025</gml:offsetVector>
      </gml:RectifiedGrid></gml:domainSet>`,
    );
  // The original vectors point along envelope axis 0 then axis 1. With a
  // latitude-first envelope, row is north/south and col is east/west.
  const info = parseWcsDescription(xml, "DEP3Elevation", service);
  const url = new URL(
    wcsCoverageUrl("https://example.org/wcs", "DEP3Elevation", [1, 2, 3, 4], 80, 40, info),
  );
  assert.deepEqual(url.searchParams.getAll("SUBSET"), ["Long(1,3)", "Lat(2,4)"]);
  assert.equal(url.searchParams.get("SCALESIZE"), "col(80),row(40)");
});

test("refuses unsupported dimensions, rotated grids, absent scaling and nonnumeric output", () => {
  const service = parseWcsCapabilities(fixture("usgs-capabilities.xml").toString())[0];
  const xml = fixture("usgs-description.xml").toString();
  for (const altered of [
    xml.replace('axisLabels="x y"', 'axisLabels="x y time"'),
    xml.replace('dimension="2"', 'dimension="3"'),
    xml.replace('axisLabels="x y"', 'axisLabels="x x"'),
    xml.replace("0.999999990011909534 0</gml:offsetVector>", "1 1</gml:offsetVector>"),
  ])
    assert.throws(
      () => parseWcsDescription(altered, "DEP3Elevation", service),
      (error) => error instanceof WcsError && error.code === "grid",
    );
  assert.throws(
    () => parseWcsDescription(xml, "DEP3Elevation", { ...service, profiles: [] }),
    /grid/,
  );
  assert.throws(
    () =>
      parseWcsDescription(xml.replace("image/tiff", "image/png"), "DEP3Elevation", {
        ...service,
        formats: ["image/png"],
      }),
    /format/,
  );
  for (const size of [0, -1, 1.5, 4097, Infinity])
    assert.throws(
      () =>
        wcsCoverageUrl(
          "https://example.org",
          "DEP3Elevation",
          [1, 2, 3, 4],
          size,
          20,
          description(),
        ),
      /size/,
    );
});

test("extracts the real USGS multipart TIFF without changing its numerical bytes", () => {
  const bytes = wcsTiffBytes(fixture("usgs-getcoverage.mime.b64"));
  // Independent MIME extraction and Rasterio decoding established this hash,
  // 64x64 dimensions, EPSG:4326 and 4096 finite elevation pixels.
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "8c7ffe11405d8b1ba2875630defb69c8c672df04a6acd406fb50e5107a34947e",
  );
  const plain = fixture("mapserver-getcoverage.tif.b64");
  assert.equal(wcsTiffBytes(plain), plain);
});

test("rejects malformed, truncated, encoded and ambiguous multipart rasters", () => {
  const raw = fixture("usgs-getcoverage.mime.b64");
  assert.throws(() => wcsTiffBytes(raw.subarray(0, raw.length - 10)), /response/);
  const tiff = fixture("mapserver-getcoverage.tif.b64");
  const part = Buffer.concat([
    Buffer.from("--test\r\nContent-Type: image/tiff\r\n\r\n"),
    tiff,
    Buffer.from("\r\n"),
  ]);
  const end = Buffer.from("--test--\r\n");
  assert.deepEqual(wcsTiffBytes(Buffer.concat([part, end])), tiff);
  assert.throws(() => wcsTiffBytes(Buffer.concat([part, part, end])), /response/);
  assert.throws(
    () =>
      wcsTiffBytes(
        Buffer.from(
          "--test\nContent-Type: image/tiff\nContent-Transfer-Encoding: base64\n\nSUkqAA==\n--test--\n",
        ),
      ),
    /response/,
  );
});

test("preserves boundary-like bytes inside the TIFF payload", () => {
  const tiff = Buffer.concat([
    fixture("mapserver-getcoverage.tif.b64"),
    Buffer.from("\n--test--not-a-delimiter\n"),
  ]);
  const message = Buffer.concat([
    Buffer.from("--test\nContent-Type: image/tiff\n\n"),
    tiff,
    Buffer.from("\n--test--\n"),
  ]);
  assert.deepEqual(wcsTiffBytes(message), tiff);
});

test("accepts CRS84 and lets the CRS extension transform other declared native CRSes", () => {
  const service = parseWcsCapabilities(fixture("usgs-capabilities.xml").toString())[0];
  const xml = fixture("usgs-description.xml").toString();
  const crs84 = xml.replaceAll(
    "http://www.opengis.net/def/crs/EPSG/0/3857",
    "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
  );
  const native = parseWcsDescription(crs84, "DEP3Elevation", {
    ...service,
    profiles: service.profiles?.filter((profile) => !profile.includes("extension_crs/")),
  });
  assert.equal(native.crs, "EPSG:4326");
  const url = new URL(
    wcsCoverageUrl("https://example.org/wcs", "DEP3Elevation", [1, 2, 3, 4], 64, 32, native),
  );
  assert.equal(url.searchParams.has("SUBSETTINGCRS"), false);
  const custom = xml.replaceAll(
    "http://www.opengis.net/def/crs/EPSG/0/3857",
    "https://example.org/crs/local-grid",
  );
  assert.equal(
    parseWcsDescription(custom, "DEP3Elevation", service).nativeCrs,
    "https://example.org/crs/local-grid",
  );
  assert.throws(
    () =>
      parseWcsDescription(custom, "DEP3Elevation", {
        ...service,
        profiles: service.profiles?.filter((profile) => !profile.includes("extension_crs/")),
      }),
    /crs/,
  );
});

test("keeps the advertised CRS84 URI when the CRS extension is used", () => {
  const service = parseWcsCapabilities(fixture("usgs-capabilities.xml").toString())[0];
  const uri = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
  const info = parseWcsDescription(fixture("usgs-description.xml").toString(), "DEP3Elevation", {
    ...service,
    crses: [uri],
  });
  const url = new URL(
    wcsCoverageUrl("https://example.org/wcs", "DEP3Elevation", [1, 2, 3, 4], 64, 32, info),
  );
  assert.equal(info.crs, "EPSG:4326");
  assert.equal(url.searchParams.get("SUBSETTINGCRS"), uri);
  assert.equal(url.searchParams.get("OUTPUTCRS"), uri);
});

test("prefers an advertised EPSG URI over its CRS84 projection alias", () => {
  const service = parseWcsCapabilities(fixture("usgs-capabilities.xml").toString())[0];
  const uri = "urn:ogc:def:crs:EPSG::4326";
  const info = parseWcsDescription(fixture("usgs-description.xml").toString(), "DEP3Elevation", {
    ...service,
    crses: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84", uri],
  });
  const url = new URL(
    wcsCoverageUrl("https://example.org/wcs", "DEP3Elevation", [1, 2, 3, 4], 64, 32, info),
  );
  assert.equal(url.searchParams.get("SUBSETTINGCRS"), uri);
  assert.equal(url.searchParams.get("OUTPUTCRS"), uri);
});

test("uses the GeoTIFF MIME type for a native format label", () => {
  const service = parseWcsCapabilities(fixture("usgs-capabilities.xml").toString())[0];
  const xml = fixture("usgs-description.xml").toString().replace("image/tiff", "GeoTIFF");
  const info = parseWcsDescription(xml, "DEP3Elevation", { ...service, formats: [] });
  const url = new URL(
    wcsCoverageUrl("https://example.org/wcs", "DEP3Elevation", [1, 2, 3, 4], 64, 32, info),
  );
  assert.equal(url.searchParams.get("FORMAT"), "image/tiff");
});

test("reports a CRS mismatch separately from an unsupported grid", () => {
  const service = parseWcsCapabilities(fixture("usgs-capabilities.xml").toString())[0];
  const info = parseWcsDescription(fixture("usgs-description.xml").toString(), "DEP3Elevation", {
    ...service,
    profiles: service.profiles?.filter((profile) => !profile.includes("extension_crs/")),
  });
  assert.throws(
    () =>
      wcsCoverageUrl("https://example.org/wcs", "DEP3Elevation", [1, 2, 3, 4], 64, 32, {
        ...info,
        crs: "EPSG:4326",
      }),
    (error) => error instanceof WcsError && error.code === "crs",
  );
});

for (const newline of ["\n", "\r\n"]) {
  test(`preserves a TIFF ending in CR with ${newline.length === 1 ? "LF" : "CRLF"} multipart framing`, () => {
    const raster = Buffer.concat([fixture("mapserver-getcoverage.tif.b64"), Buffer.from([13])]);
    const message = Buffer.concat([
      Buffer.from(`--test${newline}Content-Type: image/tiff${newline}${newline}`),
      raster,
      Buffer.from(`${newline}--test--${newline}`),
    ]);
    assert.deepEqual(wcsTiffBytes(message), raster);
  });
}
