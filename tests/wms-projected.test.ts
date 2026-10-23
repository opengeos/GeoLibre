import assert from "node:assert/strict";
import test from "node:test";
import proj4 from "proj4";
import {
  canReprojectWmsCrs,
  projectedWmsRequest,
  reprojectableWmsCodes,
  reprojectableWmsCrs,
  sourcePixelMap,
  warpToMercator,
} from "../apps/geolibre-desktop/src/lib/wms-projected";

const HALF_WORLD = 20037508.342789244;
const ENDPOINT = "https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php";
// EPSG:25832 (ETRS89 / UTM 32N), easting first; EPSG:6707 (RDN2008 / UTM 32N
// (N-E)) is the same projection with the axes swapped.
const UTM32N = "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs";

// The BBOX MapLibre substitutes for {bbox-epsg-3857} on tile z/x/y.
function tileBbox(z: number, x: number, y: number): number[] {
  const size = (2 * HALF_WORLD) / 2 ** z;
  const minX = -HALF_WORLD + x * size;
  const maxY = HALF_WORLD - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

// Tile z17/69387/46913 covers part of Desenzano del Garda (Lombardy).
const TILE = tileBbox(17, 69387, 46913);

function getMap(version: string, crs: string, bbox = TILE): string {
  const key = version === "1.3.0" ? "CRS" : "SRS";
  return `${ENDPOINT}?SERVICE=WMS&REQUEST=GetMap&VERSION=${version}&LAYERS=CP.CadastralParcel&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=TRUE&${key}=${crs}&WIDTH=256&HEIGHT=256&BBOX=${bbox.join(",")}`;
}

function bboxOf(url: string): number[] {
  return new URL(url).searchParams.get("BBOX")!.split(",").map(Number);
}

function lonLat(x: number, y: number): [number, number] {
  return [
    (x / HALF_WORLD) * 180,
    (Math.atan(Math.sinh((y / HALF_WORLD) * Math.PI)) * 180) / Math.PI,
  ];
}

function tileCornersInUtm(): number[][] {
  const [minX, minY, maxX, maxY] = TILE;
  return [
    [minX, minY],
    [minX, maxY],
    [maxX, minY],
    [maxX, maxY],
  ].map(([x, y]) => proj4("EPSG:4326", UTM32N, lonLat(x, y)));
}

test("projectedWmsRequest asks for an extent in the layer's CRS that covers the tile", async () => {
  const request = await projectedWmsRequest(getMap("1.1.1", "EPSG:25832"));
  assert.ok(request);
  const [minE, minN, maxE, maxN] = bboxOf(request.url);
  assert.deepEqual([minE, minN, maxE, maxN], request.extent);
  for (const [easting, northing] of tileCornersInUtm()) {
    assert.ok(easting >= minE - 1e-6 && easting <= maxE + 1e-6, `${easting}`);
    assert.ok(northing >= minN - 1e-6 && northing <= maxN + 1e-6, `${northing}`);
  }
  // A z17 tile is about 214 m across at this latitude; the rotated UTM
  // envelope is a little larger, never a different place.
  assert.ok(maxE - minE > 200 && maxE - minE < 240, `${maxE - minE}`);
  assert.ok(minE > 600_000 && minE < 650_000 && minN > 5_000_000 && minN < 5_100_000);
});

test("the requested image keeps about the tile's resolution", async () => {
  const request = await projectedWmsRequest(getMap("1.1.1", "EPSG:25832"));
  assert.ok(request);
  const params = new URL(request.url).searchParams;
  assert.equal(Number(params.get("WIDTH")), request.width);
  assert.equal(Number(params.get("HEIGHT")), request.height);
  assert.ok(request.width >= 256 && request.width <= 300, `${request.width}`);
  assert.ok(request.height >= 256 && request.height <= 300, `${request.height}`);
  assert.equal(request.tileSize, 256);
});

test("WMS 1.3.0 puts northing first for a CRS whose EPSG axis order is north-east", async () => {
  const eastFirst = await projectedWmsRequest(getMap("1.3.0", "EPSG:25832"));
  const northFirst = await projectedWmsRequest(getMap("1.3.0", "EPSG:6707"));
  const oldVersion = await projectedWmsRequest(getMap("1.1.1", "EPSG:6707"));
  assert.ok(eastFirst && northFirst && oldVersion);
  const [minE, minN, maxE, maxN] = eastFirst.extent;
  assert.deepEqual(bboxOf(eastFirst.url), [minE, minN, maxE, maxN]);
  assert.deepEqual(bboxOf(northFirst.url), [minN, minE, maxN, maxE]);
  // WMS 1.1.1 is always x,y.
  assert.deepEqual(bboxOf(oldVersion.url), [minE, minN, maxE, maxN]);
});

test("canReprojectWmsCrs accepts only CRSs the tile protocol can draw", async () => {
  for (const crs of [
    "EPSG:3857",
    "EPSG:900913",
    "CRS:84",
    "EPSG:6706",
    "epsg:25832",
    "EPSG:3003",
  ]) {
    assert.equal(await canReprojectWmsCrs(crs), true, crs);
  }
  // EPSG:6244 is in the EPSG tables but its +proj=col_urban has no proj4js
  // implementation; Vienna's WMS inherits it from a parent layer (#3007).
  for (const crs of ["EPSG:999999", "EPSG:1", "EPSG:6244"]) {
    assert.equal(await canReprojectWmsCrs(crs), false, crs);
  }
});

test("reprojectableWmsCodes keeps the supported codes when one check rejects", async () => {
  const check = async (code: string) => {
    if (code === "EPSG:6244") throw new Error("Could not get projection name");
    return code !== "EPSG:999999";
  };
  assert.deepEqual(
    await reprojectableWmsCodes(["EPSG:3857", "EPSG:6244", "EPSG:999999", "CRS:84"], check),
    ["EPSG:3857", "CRS:84"],
  );
  // The real check, over the Vienna mix from #3007.
  assert.deepEqual(await reprojectableWmsCodes(["EPSG:6244", "EPSG:3857", "CRS:84"]), [
    "EPSG:3857",
    "CRS:84",
  ]);
});

test("reprojectableWmsCrs falls back to Web Mercator for a CRS it cannot draw", async () => {
  assert.equal(await reprojectableWmsCrs("EPSG:25832"), "EPSG:25832");
  assert.equal(await reprojectableWmsCrs("EPSG:999999"), undefined);
  assert.equal(await reprojectableWmsCrs(undefined), undefined);
});

test("projectedWmsRequest leaves Web Mercator, geographic and unknown CRSs alone", async () => {
  for (const crs of ["EPSG:3857", "EPSG:4326", "EPSG:6706", "EPSG:99999", "EPSG:foo"]) {
    assert.equal(await projectedWmsRequest(getMap("1.1.1", crs)), null, crs);
  }
  assert.equal(await projectedWmsRequest("not a url"), null);
  assert.equal(await projectedWmsRequest(getMap("1.1.1", "EPSG:25832", [1, 1, 1, 1])), null);
});

test("a geographic EPSG code outside the strip path is warped in degrees", async () => {
  // EPSG:4269 (NAD83): latitude first in WMS 1.3.0, longitude first in 1.1.1.
  const [lon0, lat0] = lonLat(TILE[0], TILE[1]);
  const [lon1, lat1] = lonLat(TILE[2], TILE[3]);
  const newVersion = await projectedWmsRequest(getMap("1.3.0", "EPSG:4269"));
  assert.ok(newVersion);
  const [minLon, minLat, maxLon, maxLat] = newVersion.extent;
  for (const [actual, expected] of [
    [minLon, lon0],
    [minLat, lat0],
    [maxLon, lon1],
    [maxLat, lat1],
  ]) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ${expected}`);
  }
  assert.deepEqual(bboxOf(newVersion.url), [minLat, minLon, maxLat, maxLon]);
  const oldVersion = await projectedWmsRequest(getMap("1.1.1", "EPSG:4269"));
  assert.ok(oldVersion);
  assert.deepEqual(bboxOf(oldVersion.url), [minLon, minLat, maxLon, maxLat]);
});

test("sourcePixelMap matches a direct reprojection of every sampled pixel", async () => {
  const request = await projectedWmsRequest(getMap("1.1.1", "EPSG:25832"));
  assert.ok(request);
  const map = sourcePixelMap(request);
  const [minX, minY, maxX, maxY] = TILE;
  const [minE, minN, maxE, maxN] = request.extent;
  let worst = 0;
  for (const [i, j] of [
    [0, 0],
    [255, 0],
    [0, 255],
    [255, 255],
    [128, 128],
    [37, 201],
  ]) {
    const x = minX + ((i + 0.5) / 256) * (maxX - minX);
    const y = maxY - ((j + 0.5) / 256) * (maxY - minY);
    const [easting, northing] = proj4("EPSG:4326", UTM32N, lonLat(x, y));
    const u = ((easting - minE) / (maxE - minE)) * request.width - 0.5;
    const v = ((maxN - northing) / (maxN - minN)) * request.height - 0.5;
    const index = (j * 256 + i) * 2;
    worst = Math.max(worst, Math.abs(map[index] - u), Math.abs(map[index + 1] - v));
  }
  assert.ok(worst < 0.05, `grid interpolation error ${worst} px`);
});

test("sourcePixelMap scales with the size of the image the server returned", async () => {
  const request = await projectedWmsRequest(getMap("1.1.1", "EPSG:25832"));
  assert.ok(request);
  const full = sourcePixelMap(request);
  const width = Math.round(request.width / 2);
  const height = Math.round(request.height / 2);
  const capped = sourcePixelMap({ ...request, width, height });
  for (let i = 0; i < full.length; i += 2 * 257) {
    // Same position as a fraction of the image, whatever its size.
    assert.ok(Math.abs((full[i] + 0.5) / request.width - (capped[i] + 0.5) / width) < 1e-4);
    assert.ok(
      Math.abs((full[i + 1] + 0.5) / request.height - (capped[i + 1] + 0.5) / height) < 1e-4,
    );
  }
});

test("warpToMercator samples the nearest source pixel and leaves outside pixels transparent", () => {
  // A 4x4 source whose red channel is its column and green channel its row.
  const source = new Uint8ClampedArray(4 * 4 * 4);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      source.set([column, row, 0, 255], (row * 4 + column) * 4);
    }
  }
  // Output pixel 0 reads source (2.4, 1.6), pixel 1 reads (-3, 0), outside.
  const map = new Float32Array([2.4, 1.6, -3, 0, 0, 0, 3, 3]);
  const out = warpToMercator(source, 4, 4, map, 2);
  assert.deepEqual([...out.slice(0, 4)], [2, 2, 0, 255]);
  assert.deepEqual([...out.slice(4, 8)], [0, 0, 0, 0]);
  assert.deepEqual([...out.slice(8, 12)], [0, 0, 0, 255]);
  assert.deepEqual([...out.slice(12, 16)], [3, 3, 0, 255]);
});
