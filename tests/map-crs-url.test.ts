import assert from "node:assert/strict";
import { test } from "node:test";
import { mapCrsRequestFromSearch } from "../apps/geolibre-desktop/src/lib/map-crs-url";
import { mapCrsPreferencePatch } from "../packages/core/src/map-crs";

test("a link without a crs value asks for nothing", () => {
  for (const search of ["", "?lat=1&lon=2", "?crs=", "?crs=%20"]) {
    assert.equal(mapCrsRequestFromSearch(search), null, search);
  }
});

test("a link names an EPSG code or a preset id", () => {
  assert.deepEqual(mapCrsRequestFromSearch("?crs=EPSG:32632&lat=45"), {
    raw: "EPSG:32632",
    mapCrs: "EPSG:32632",
  });
  assert.equal(mapCrsRequestFromSearch("?crs=epsg%3A32632")?.mapCrs, "EPSG:32632");
  assert.equal(mapCrsRequestFromSearch("?crs=mars-north-polar")?.mapCrs, "mars-north-polar");
  // A preset's code is that preset, which carries a basemap.
  assert.equal(mapCrsRequestFromSearch("?crs=EPSG:3413")?.mapCrs, "earth-arctic");
});

test("a Web Mercator code asks for the default map, unlike a malformed value", () => {
  assert.equal(mapCrsRequestFromSearch("?crs=EPSG:3857")?.mapCrs, null);
  assert.deepEqual(mapCrsRequestFromSearch("?crs=utm32"), { raw: "utm32", mapCrs: undefined });
  assert.equal(mapCrsRequestFromSearch("?crs=32632")?.mapCrs, undefined);
});

test("the preference patch brings the body a CRS maps and leaves it for the default map", () => {
  assert.deepEqual(mapCrsPreferencePatch("mars-north-polar"), {
    mapCrs: "mars-north-polar",
    ellipsoidId: "mars",
  });
  assert.deepEqual(mapCrsPreferencePatch("EPSG:32632"), {
    mapCrs: "EPSG:32632",
    ellipsoidId: "earth",
  });
  assert.deepEqual(mapCrsPreferencePatch(null), { mapCrs: undefined });
});
