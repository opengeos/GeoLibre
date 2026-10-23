import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GEOGRAPHIC_WMS_CRS,
  describeWmsFailure,
  geographicTileToMercator,
  geographicWmsRequest,
  mercatorStrips,
} from "../apps/geolibre-desktop/src/lib/wms-geographic";

const HALF_WORLD = 20037508.342789244;

// The BBOX MapLibre substitutes for {bbox-epsg-3857} on tile z/x/y.
function tileBbox(z: number, x: number, y: number): string {
  const size = (2 * HALF_WORLD) / 2 ** z;
  const minX = -HALF_WORLD + x * size;
  const maxY = HALF_WORLD - y * size;
  return [minX, maxY - size, minX + size, maxY].join(",");
}

// Tile z17/70976/50477 covers part of Gioiosa Marea (Sicily); the Agenzia
// delle Entrate cadastral WMS offers EPSG:6706 there but not EPSG:3857.
const ENDPOINT = "https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php";
const WEST = 14.94140625;
const EAST = 14.94415283203125;
const SOUTH = 38.1734326790354;
const NORTH = 38.17559185481662;

function getMap(version: string, crs: string): string {
  const crsKey = version === "1.3.0" ? "CRS" : "SRS";
  return (
    `${ENDPOINT}?SERVICE=WMS&REQUEST=GetMap&VERSION=${version}&LAYERS=CP.CadastralParcel` +
    `&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=TRUE&${crsKey}=${crs}` +
    `&BBOX=${tileBbox(17, 70976, 50477)}&WIDTH=256&HEIGHT=256`
  );
}

function bboxOf(url: string): number[] {
  return (new URL(url).searchParams.get("BBOX") ?? "").split(",").map(Number);
}

function assertClose(actual: number[], expected: number[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${value}`));
}

test("geographicWmsRequest leaves Web Mercator requests alone", () => {
  assert.equal(geographicWmsRequest(getMap("1.1.1", "EPSG:3857")), null);
  assert.equal(geographicWmsRequest(getMap("1.3.0", "EPSG:3857")), null);
});

test("geographicWmsRequest converts the tile to lon,lat for WMS 1.1.1", () => {
  const request = geographicWmsRequest(getMap("1.1.1", "EPSG:6706"));
  assert.ok(request);
  assertClose(bboxOf(request.url), [WEST, SOUTH, EAST, NORTH]);
  assertClose(
    [request.west, request.south, request.east, request.north],
    [WEST, SOUTH, EAST, NORTH],
  );
  assert.equal(new URL(request.url).searchParams.get("SRS"), "EPSG:6706");
});

test("geographicWmsRequest puts latitude first for EPSG codes in WMS 1.3.0", () => {
  for (const crs of ["EPSG:4326", "EPSG:4258", "EPSG:6706"]) {
    const request = geographicWmsRequest(getMap("1.3.0", crs));
    assert.ok(request, crs);
    assertClose(bboxOf(request.url), [SOUTH, WEST, NORTH, EAST]);
  }
});

test("geographicWmsRequest keeps CRS:84 longitude first in WMS 1.3.0", () => {
  const request = geographicWmsRequest(getMap("1.3.0", "CRS:84"));
  assert.ok(request);
  assertClose(bboxOf(request.url), [WEST, SOUTH, EAST, NORTH]);
});

test("geographicWmsRequest ignores URLs it cannot read", () => {
  assert.equal(geographicWmsRequest("not a url"), null);
  assert.equal(geographicWmsRequest(`${ENDPOINT}?SRS=EPSG:4326&BBOX=1,2,3`), null);
  assert.equal(geographicWmsRequest(`${ENDPOINT}?SRS=EPSG:4326`), null);
});

test("mercatorStrips tile the target without gaps or overlaps", () => {
  const strips = mercatorStrips(35, 50, 256, 256);
  assert.equal(strips[0].targetY, 0);
  for (let index = 1; index < strips.length; index += 1) {
    const previous = strips[index - 1];
    assert.ok(Math.abs(previous.targetY + previous.targetHeight - strips[index].targetY) < 1e-9);
  }
  const last = strips.at(-1);
  assert.ok(last && Math.abs(last.targetY + last.targetHeight - 256) < 1e-9);
});

test("mercatorStrips stretch northern strips over a low-zoom tile", () => {
  // Web Mercator grows toward the pole, so equal latitude bands take more
  // pixels at the top of the tile than at the bottom.
  const strips = mercatorStrips(0, 66.51326044311186, 256, 256);
  assert.ok(strips[0].targetHeight > strips.at(-1)!.targetHeight);
});

test("mercatorStrips clamp latitudes beyond the Web Mercator limit", () => {
  for (const strip of mercatorStrips(-90, 90, 256, 256)) {
    assert.ok(Number.isFinite(strip.targetY) && Number.isFinite(strip.targetHeight));
  }
});

test("degenerate extents produce no request and no strips", () => {
  assert.equal(geographicWmsRequest(`${ENDPOINT}?SRS=EPSG:4326&BBOX=0,5,0,10`), null);
  assert.equal(geographicWmsRequest(`${ENDPOINT}?SRS=EPSG:4326&BBOX=0,10,5,5`), null);
  assert.deepEqual(mercatorStrips(40, 40, 256, 256), []);
});

test("geographicWmsRequest reads any 1.3.x version as latitude first", () => {
  const request = geographicWmsRequest(
    getMap("1.3.0", "EPSG:4326").replace("VERSION=1.3.0", "VERSION=1.3"),
  );
  assert.ok(request);
  assertClose(bboxOf(request.url), [SOUTH, WEST, NORTH, EAST]);
});

test("describeWmsFailure surfaces the server's exception text", () => {
  const body = new TextEncoder().encode(
    '<?xml version="1.0"?>\n<ServiceExceptionReport>\n  <ServiceException code="InvalidSRS">bad CRS</ServiceException>',
  ).buffer;
  assert.match(describeWmsFailure(body), /^WMS GetMap returned no image: .*InvalidSRS.*bad CRS/);
  assert.equal(describeWmsFailure(new ArrayBuffer(0)), "WMS GetMap returned no image");
});

test("geographicTileToMercator reports a non-image response with the server's text", async () => {
  // Under node there is no image decoder, so this exercises the same path a
  // WebView takes when the server answers with an XML exception.
  const request = geographicWmsRequest(getMap("1.1.1", "EPSG:6706"));
  assert.ok(request);
  const body = new TextEncoder().encode(
    "<ServiceExceptionReport>InvalidSRS</ServiceExceptionReport>",
  );
  await assert.rejects(
    geographicTileToMercator(body.buffer, request),
    /^Error: WMS GetMap returned no image: <ServiceExceptionReport>InvalidSRS/,
  );
});

test("geographicWmsRequest trims the CRS as Python does", () => {
  const request = geographicWmsRequest(getMap("1.1.1", "%20epsg:6706%20"));
  assert.ok(request);
  assertClose(bboxOf(request.url), [WEST, SOUTH, EAST, NORTH]);
});

test("GEOGRAPHIC_WMS_CRS matches Python's WMS_CRS minus EPSG:3857", () => {
  // The two allowlists live in different languages; a CRS Python writes that
  // the desktop does not know renders blank, so keep them equal by test.
  const source = readFileSync(
    new URL("../python/src/geolibre/project.py", import.meta.url),
    "utf8",
  );
  const literal = source.match(/^WMS_CRS = frozenset\(\{([^}]*)\}\)/m);
  assert.ok(literal, "WMS_CRS literal not found in project.py");
  const python = new Set([...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  python.delete("EPSG:3857");
  assert.deepEqual([...GEOGRAPHIC_WMS_CRS].sort(), [...python].sort());
});
