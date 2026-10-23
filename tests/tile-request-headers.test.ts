import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ResourceType } from "maplibre-gl";
import {
  clearTileRequestHeaders,
  clearTileRequestHeadersWhere,
  isScopedTileUrlPrefix,
  setTileRequestHeaders,
  tileRequestHeadersFor,
  transformTileRequest,
} from "../packages/map/src/tile-request-headers";

// MapLibre declares these as a const enum of the same strings.
const TILE = "Tile" as ResourceType;
const SOURCE = "Source" as ResourceType;
const SPRITE_IMAGE = "SpriteImage" as ResourceType;

describe("tile request headers", () => {
  afterEach(() => clearTileRequestHeadersWhere(() => true));

  const abc = "https://demo.example.com/raster-tiles/abc/tiles/";
  const xyz = "https://other.example.com/raster-tiles/xyz/tiles/";

  it("adds an endpoint's headers to its tile and TileJSON requests only", () => {
    setTileRequestHeaders("abc", [abc], { "X-Api-Key": "key-abc" });
    setTileRequestHeaders("xyz", [xyz], { "X-Api-Key": "key-xyz" });
    assert.deepEqual(transformTileRequest(`${abc}3/2/1.png`, TILE), {
      url: `${abc}3/2/1.png`,
      headers: { "X-Api-Key": "key-abc" },
    });
    assert.deepEqual(tileRequestHeadersFor(`${xyz}0/0/0.png`), { "X-Api-Key": "key-xyz" });
    assert.ok(transformTileRequest(`${abc}tiles.json`, SOURCE));
    assert.equal(transformTileRequest(`${abc}sprite.png`, SPRITE_IMAGE), undefined);
  });

  it("leaves basemaps, lookalike hosts and other datasets alone", () => {
    setTileRequestHeaders("abc", [abc], { "X-Api-Key": "key-abc" });
    assert.equal(transformTileRequest("https://tiles.openfreemap.org/1/2/3.pbf", TILE), undefined);
    assert.equal(transformTileRequest("https://demo.example.com.evil.test/x", TILE), undefined);
    assert.equal(
      transformTileRequest("https://demo.example.com/raster-tiles/zzz/tiles/1/1/1.png", TILE),
      undefined,
    );
  });

  it("only takes prefixes that name one host and a path on it", () => {
    for (const scoped of [
      "https://host/",
      "https://host:8443/tiles/",
      "http://localhost:8002/mvt/node/",
    ]) {
      assert.equal(isScopedTileUrlPrefix(scoped), true, scoped);
    }
    // A placeholder in the host, a host with no path after it, or not HTTP(S).
    for (const unscoped of [
      "https://",
      "https://tiles",
      "https://host",
      "ftp://host/",
      "/tiles/",
    ]) {
      assert.equal(isScopedTileUrlPrefix(unscoped), false, unscoped);
      assert.throws(
        () => setTileRequestHeaders("loose", [unscoped], { Authorization: "Bearer a" }),
        /fixed host and path/,
      );
    }
    assert.equal(tileRequestHeadersFor("https://any.example.com/1/1/1.pbf"), undefined);
    // Clearing still works whatever the prefix.
    setTileRequestHeaders("loose", ["https://"], {});
  });

  it("keeps a host's headers from a look-alike host", () => {
    setTileRequestHeaders("host", ["https://host/"], { Authorization: "Bearer a" });
    assert.equal(tileRequestHeadersFor("https://host.evil.test/1/1/1.pbf"), undefined);
    assert.ok(tileRequestHeadersFor("https://host/1/1/1.pbf"));
  });

  it("prefers the longest matching prefix", () => {
    setTileRequestHeaders("server", ["https://demo.example.com/"], { Authorization: "Bearer a" });
    setTileRequestHeaders("dataset", [abc], { Authorization: "Bearer b" });
    assert.deepEqual(tileRequestHeadersFor(`${abc}1/1/1.png`), { Authorization: "Bearer b" });
    assert.deepEqual(tileRequestHeadersFor("https://demo.example.com/other/1/1/1.png"), {
      Authorization: "Bearer a",
    });
  });

  it("replaces, clears, and clears by owner", () => {
    setTileRequestHeaders("abc", [abc], { Authorization: "Bearer old" });
    setTileRequestHeaders("abc", [abc], { Authorization: "Bearer new" });
    assert.deepEqual(tileRequestHeadersFor(`${abc}1/1/1.png`), { Authorization: "Bearer new" });
    setTileRequestHeaders("abc", [abc], {});
    assert.equal(tileRequestHeadersFor(`${abc}1/1/1.png`), undefined);

    setTileRequestHeaders("geolens:abc", [abc], { "X-Api-Key": "a" });
    setTileRequestHeaders("plugin:xyz", [xyz], { "X-Api-Key": "x" });
    clearTileRequestHeadersWhere((key) => key.startsWith("geolens:"));
    assert.equal(tileRequestHeadersFor(`${abc}1/1/1.png`), undefined);
    assert.ok(tileRequestHeadersFor(`${xyz}1/1/1.png`));
    clearTileRequestHeaders("plugin:xyz");
    assert.equal(tileRequestHeadersFor(`${xyz}1/1/1.png`), undefined);
  });
});
