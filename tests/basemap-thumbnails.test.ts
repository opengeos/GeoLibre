import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BasemapDefinition } from "maplibre-gl-basemap-control";
import {
  rasterPreviewUrl,
  styleUrlOf,
} from "../packages/plugins/src/plugins/basemap-thumbnails";

function raster(tiles: string[]): BasemapDefinition {
  return {
    id: "osm",
    name: "OSM",
    provider: "osm",
    type: "raster",
    source: { type: "raster", tiles },
  };
}

function style(url: string): BasemapDefinition {
  return {
    id: "positron",
    name: "Positron",
    provider: "openfreemap",
    type: "style",
    source: { type: "style", url },
  };
}

describe("basemap preview urls", () => {
  it("fills z/x/y/s on a raster template", () => {
    assert.equal(
      rasterPreviewUrl(raster(["https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"])),
      "https://a.tile.openstreetmap.org/2/1/1.png",
    );
  });

  it("skips rasters that still need a key", () => {
    assert.equal(
      rasterPreviewUrl(raster(["https://tiles.example/{z}/{x}/{y}.png?key={api-key}"])),
      null,
    );
  });

  it("keeps a keyless style url and skips keyed ones", () => {
    assert.equal(
      styleUrlOf(style("https://tiles.openfreemap.org/styles/positron")),
      "https://tiles.openfreemap.org/styles/positron",
    );
    assert.equal(styleUrlOf(style("https://api.maptiler.com/maps/basic/style.json?key={key}")), null);
  });

  it("ignores the other source kind", () => {
    assert.equal(rasterPreviewUrl(style("https://tiles.openfreemap.org/styles/positron")), null);
    assert.equal(
      styleUrlOf(raster(["https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"])),
      null,
    );
  });
});
