import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DOMParser } from "linkedom";
import {
  assertWcsTiff,
  parseWcsCapabilities,
  parseWcsDescription,
  validWcsBounds,
  wcsCoverageUrl,
  wcsRequestUrl,
  WcsError,
  waitForWcsRequest,
} from "../apps/geolibre-desktop/src/lib/wcs";

const originalParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: DOMParser });
after(() => {
  if (originalParser) Object.defineProperty(globalThis, "DOMParser", originalParser);
  else Reflect.deleteProperty(globalThis, "DOMParser");
});

const capabilities = `<wcs:WCS_Capabilities xmlns:wcs="http://www.opengis.net/wcs" xmlns:gml="http://www.opengis.net/gml" version="1.0.0"><wcs:ContentMetadata><wcs:CoverageOfferingBrief><wcs:name>dem:terrain</wcs:name><wcs:label>Elevation</wcs:label><wcs:lonLatEnvelope><gml:pos>-90 39</gml:pos><gml:pos>-88 41</gml:pos></wcs:lonLatEnvelope></wcs:CoverageOfferingBrief></wcs:ContentMetadata></wcs:WCS_Capabilities>`;
const description = `<CoverageDescription version="1.0.0"><CoverageOffering><name>dem:terrain</name><supportedCRSs><requestResponseCRSs>EPSG:4326</requestResponseCRSs></supportedCRSs><supportedFormats><formats>PNG</formats><formats>GeoTIFF</formats></supportedFormats></CoverageOffering></CoverageDescription>`;
const code = (expected: string) => (error: unknown) =>
  error instanceof WcsError && error.code === expected;

test("normalizes pasted operations and ArcGIS URLs while retaining vendor parameters", () => {
  const url = new URL(
    wcsRequestUrl(
      "https://example.com/arcgis/rest/services/DEM/ImageServer?token=a%2Bb&request=GetCoverage&Service=WMS&WIDTH=200&subset=x&subset=y#fragment",
      "GetCapabilities",
    ),
  );
  assert.equal(url.pathname, "/arcgis/services/DEM/ImageServer/WCSServer");
  assert.equal(url.searchParams.get("token"), "a+b");
  assert.equal(url.searchParams.get("SERVICE"), "WCS");
  assert.equal(url.searchParams.get("REQUEST"), "GetCapabilities");
  assert.equal(url.searchParams.has("WIDTH"), false);
  assert.equal(url.searchParams.has("subset"), false);
  assert.equal(url.hash, "");
  for (const input of [
    "file:///tmp/a",
    "ftp://example.com",
    "https://user:pass@example.com",
    "bad",
  ])
    assert.throws(() => wcsRequestUrl(input, "GetCapabilities"), code("url"));
});

test("discovers namespaced coverages and geographic envelopes", () => {
  assert.deepEqual(parseWcsCapabilities(capabilities), [
    { name: "dem:terrain", title: "Elevation", bounds: [-90, 39, -88, 41] },
  ]);
  assert.throws(
    () => parseWcsCapabilities(capabilities.replace('version="1.0.0"', 'version="2.0.1"')),
    code("version"),
  );
  assert.throws(() => parseWcsCapabilities('<WCS_Capabilities version="1.0.0"/>'), code("empty"));
});

test("requires advertised numerical output and both input/output CRS support", () => {
  assert.deepEqual(parseWcsDescription(description, "dem:terrain"), {
    format: "GeoTIFF",
    crs: "EPSG:4326",
  });
  assert.throws(() => parseWcsDescription(description, "other"), code("empty"));
  assert.throws(
    () => parseWcsDescription(description.replace("GeoTIFF", "JPEG"), "dem:terrain"),
    code("format"),
  );
  assert.throws(
    () =>
      parseWcsDescription(
        description.replaceAll("requestResponseCRSs", "nativeCRSs"),
        "dem:terrain",
      ),
    code("crs"),
  );
  const separate = description.replace(
    "<requestResponseCRSs>EPSG:4326</requestResponseCRSs>",
    "<requestCRSs>EPSG:4326</requestCRSs><responseCRSs>EPSG:4326</responseCRSs>",
  );
  assert.equal(parseWcsDescription(separate, "dem:terrain").crs, "EPSG:4326");
  assert.throws(
    () =>
      parseWcsDescription(
        separate.replace("<responseCRSs>EPSG:4326", "<responseCRSs>EPSG:3857"),
        "dem:terrain",
      ),
    code("crs"),
  );
});

test("builds longitude-first bounded GetCoverage requests without losing identifiers", () => {
  const url = new URL(
    wcsCoverageUrl(
      "https://example.com/geoserver/wcs",
      "dem:terrain & sea",
      [-90, 39, -88, 41],
      200,
      100,
      { crs: "EPSG:4326", format: "GeoTIFF" },
    ),
  );
  assert.equal(url.searchParams.get("COVERAGE"), "dem:terrain & sea");
  assert.equal(url.searchParams.get("BBOX"), "-90,39,-88,41");
  assert.equal(url.searchParams.get("WIDTH"), "200");
  assert.equal(url.searchParams.get("HEIGHT"), "100");
  assert.equal(url.searchParams.get("RESPONSE_CRS"), "EPSG:4326");
  for (const dimensions of [0, -1, 1.5, 4097, NaN, Infinity])
    assert.throws(
      () =>
        wcsCoverageUrl(url.href, "dem", [-90, 39, -88, 41], dimensions, 100, {
          crs: "EPSG:4326",
          format: "GeoTIFF",
        }),
      code("size"),
    );
  for (const bounds of [
    [170, -20, -170, 20],
    [-181, 0, 1, 2],
    [0, 1, 0, 2],
    [0, 1, 2, 91],
    [NaN, 1, 2, 3],
  ])
    assert.equal(validWcsBounds(bounds), false);
});

test("surfaces WCS exception text and rejects HTTP-200 non-TIFF payloads", () => {
  const exception =
    "<ServiceExceptionReport><ServiceException>Invalid coverage</ServiceException></ServiceExceptionReport>";
  assert.throws(() => parseWcsCapabilities(exception), /Invalid coverage/);
  assert.throws(() => assertWcsTiff(new TextEncoder().encode(exception)), /Invalid coverage/);
  assert.throws(() => assertWcsTiff(new TextEncoder().encode("not a raster")), code("response"));
  for (const bytes of [
    [73, 73, 42, 0, 0, 0, 0, 0],
    [77, 77, 0, 42, 0, 0, 0, 0],
    [73, 73, 43, 0, 0, 0, 0, 0],
  ])
    assert.doesNotThrow(() => assertWcsTiff(new Uint8Array(bytes)));
});

test("native requests stop waiting on abort and observe late rejections", async () => {
  const controller = new AbortController();
  let fail!: (reason: Error) => void;
  const native = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const waiting = waitForWcsRequest(native, controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  fail(new Error("late native failure"));
  await Promise.resolve();
  assert.equal(await waitForWcsRequest(Promise.resolve(42), new AbortController().signal), 42);
  await assert.rejects(waitForWcsRequest(Promise.resolve(42), controller.signal), /cancelled/);
  await assert.rejects(
    waitForWcsRequest(Promise.reject(new Error("native error")), new AbortController().signal),
    /native error/,
  );
});
