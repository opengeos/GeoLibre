import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findNamedTileBasemap,
  NAMED_TILE_BASEMAPS,
} from "../apps/geolibre-desktop/src/lib/assistant/basemaps";

describe("findNamedTileBasemap", () => {
  it("matches by exact id", () => {
    const basemap = findNamedTileBasemap("google-satellite");
    assert.equal(basemap?.id, "google-satellite");
    assert.match(basemap?.url ?? "", /\{z\}/);
    assert.match(basemap?.url ?? "", /\{x\}/);
    assert.match(basemap?.url ?? "", /\{y\}/);
  });

  it("matches by label, case-insensitively and fuzzily", () => {
    assert.equal(findNamedTileBasemap("Google Satellite")?.id, "google-satellite");
    assert.equal(findNamedTileBasemap("google satellite")?.id, "google-satellite");
    assert.equal(findNamedTileBasemap("esri imagery")?.id, "esri-imagery");
    assert.equal(findNamedTileBasemap("openstreetmap")?.id, "osm");
  });

  it("returns null for unknown or empty references", () => {
    assert.equal(findNamedTileBasemap("nope-xyz"), null);
    assert.equal(findNamedTileBasemap("  "), null);
  });

  it("every registered basemap has a valid XYZ template", () => {
    for (const basemap of NAMED_TILE_BASEMAPS) {
      for (const placeholder of ["{z}", "{x}", "{y}"]) {
        assert.ok(
          basemap.url.includes(placeholder),
          `${basemap.id} missing ${placeholder}`,
        );
      }
      assert.ok(basemap.attribution.length > 0, `${basemap.id} missing attribution`);
    }
  });
});
