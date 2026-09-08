import assert from "node:assert/strict";
import test from "node:test";
import {
  coordinateTargetFromSearch,
  coordinateTargetFromGeoUri,
} from "../apps/geolibre-desktop/src/lib/coordinate-url";

test("web coordinates preserve axis order, fractional zoom and zero values", () => {
  assert.deepEqual(coordinateTargetFromSearch("?lat=40.7128&lon=-74.006&zoom=12.5"), {
    center: [-74.006, 40.7128],
    zoom: 12.5,
  });
  assert.deepEqual(coordinateTargetFromSearch("?0/0/0"), { center: [0, 0], zoom: 0 });
  assert.deepEqual(coordinateTargetFromSearch("?lat=-90&lon=180"), {
    center: [180, -90],
    zoom: 14,
  });
});

test("invalid web coordinates do not claim startup", () => {
  for (const query of [
    "",
    "?zoom=12",
    "?lat=1",
    "?lat=&lon=1",
    "?lat=91&lon=0",
    "?lat=0&lon=-181",
    "?lat=NaN&lon=0",
    "?lat=0x10&lon=0",
    "?lat=0&lon=0&zoom=Infinity",
    "?lat=0&lon=0&zoom=-1",
    "?lat=0&lon=0&zoom=25",
    "?12/40/no",
    "?https://example.org/project.json",
  ]) {
    assert.equal(coordinateTargetFromSearch(query), null, query);
  }
});

test("geo URIs support direct coordinates, zoom, and labeled coordinate queries", () => {
  assert.deepEqual(coordinateTargetFromGeoUri("geo:40.7128,-74.006"), {
    center: [-74.006, 40.7128],
    zoom: 14,
  });
  assert.deepEqual(coordinateTargetFromGeoUri("geo:0,0?q=40.7128,-74.006(New%20York)&z=12"), {
    center: [-74.006, 40.7128],
    zoom: 12,
  });
  assert.deepEqual(coordinateTargetFromGeoUri("geo:0,0?z=0"), { center: [0, 0], zoom: 0 });
});

test("geo URIs reject addresses and malformed or out-of-range numbers", () => {
  for (const uri of [
    "https://example.org",
    "geo:0,0?q=New+York",
    "geo:0,0?q=",
    "geo:91,0",
    "geo:0,181",
    "geo:,0",
    "geo:NaN,0",
    "geo:1,2,altitude",
    "geo:1,2,3,4",
    "geo:0,0?q=1,2,3",
    "geo:1,2?z=25",
  ]) {
    assert.equal(coordinateTargetFromGeoUri(uri), null, uri);
  }
});

test("direct geo URI altitude is validated but does not control map zoom", () => {
  assert.deepEqual(coordinateTargetFromGeoUri("geo:37.786971,-122.399677,15"), {
    center: [-122.399677, 37.786971],
    zoom: 14,
  });
  assert.deepEqual(coordinateTargetFromGeoUri("geo:1,2,-10?z=12"), { center: [2, 1], zoom: 12 });
});
