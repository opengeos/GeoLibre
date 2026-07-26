import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CogSourceSpec, MosaicSourceSpec } from "maplibre-gl-time-slider";
import {
  isPixelIdentifiableSourceType,
  pickMosaicAsset,
  resolvePixelReadUrl,
} from "../packages/plugins/src/plugins/time-slider-pixel-identify";

describe("isPixelIdentifiableSourceType", () => {
  it("accepts the source types that carry readable source values", () => {
    assert.equal(isPixelIdentifiableSourceType("cog"), true);
    assert.equal(isPixelIdentifiableSourceType("mosaic"), true);
  });

  it("rejects pre-rendered tile sources and vector sources", () => {
    // xyz/wms are pictures with no source values to recover; a geojson source
    // identifies as vector features through the normal map query instead.
    assert.equal(isPixelIdentifiableSourceType("xyz"), false);
    assert.equal(isPixelIdentifiableSourceType("wms"), false);
    assert.equal(isPixelIdentifiableSourceType("geojson"), false);
    assert.equal(isPixelIdentifiableSourceType("custom"), false);
    assert.equal(isPixelIdentifiableSourceType(undefined), false);
  });
});

describe("resolvePixelReadUrl", () => {
  const cog = (url: string): CogSourceSpec => ({ type: "cog", id: "c", url });
  const mosaic = (url: string): MosaicSourceSpec => ({ type: "mosaic", id: "m", url });

  it("reads a COG source straight from its resolved URL", async () => {
    assert.equal(
      await resolvePixelReadUrl(cog("https://x/2000.tif"), "https://x/2000.tif", [0, 0]),
      "https://x/2000.tif",
    );
  });

  it("reads a GeoTIFF URL directly even when the spec claims to be a mosaic", async () => {
    // The library renders a COG through its mosaic adapter on the gpu/wasm
    // engines and rewrites the reported spec to `type: 'mosaic'` — the dock's
    // COG form defaults to gpu, so this is the ordinary case, not an edge one.
    // Fetching the `.tif` as a manifest would fail every read.
    assert.equal(
      await resolvePixelReadUrl(mosaic("https://x/{date:YYYY}.tif"), "https://x/2000.tif", [0, 0]),
      "https://x/2000.tif",
    );
    // Query strings and fragments must not hide the extension.
    assert.equal(
      await resolvePixelReadUrl(mosaic("https://x/a.tiff?v=1"), "https://x/a.tiff?v=1", [0, 0]),
      "https://x/a.tiff?v=1",
    );
  });
});

describe("pickMosaicAsset", () => {
  const asset = (url: string, bbox: [number, number, number, number]) => ({ url, bbox });

  it("returns the asset whose bbox contains the point", () => {
    const assets = [
      asset("a.tif", [0, 0, 10, 10]),
      asset("b.tif", [10, 10, 20, 20]),
      asset("c.tif", [20, 20, 30, 30]),
    ];
    assert.equal(pickMosaicAsset(assets, [15, 15]), "b.tif");
  });

  it("returns null when no asset covers the point", () => {
    const assets = [asset("a.tif", [0, 0, 10, 10])];
    assert.equal(pickMosaicAsset(assets, [50, 50]), null);
  });

  it("returns null for an empty mosaic", () => {
    assert.equal(pickMosaicAsset([], [0, 0]), null);
  });

  it("prefers the smallest of several overlapping assets", () => {
    // Seams overlap, and a coarse asset covering the whole mosaic would
    // otherwise win by being first. The tighter bbox is the nearer scene.
    const assets = [
      asset("coarse.tif", [0, 0, 100, 100]),
      asset("fine.tif", [40, 40, 50, 50]),
      asset("medium.tif", [20, 20, 60, 60]),
    ];
    assert.equal(pickMosaicAsset(assets, [45, 45]), "fine.tif");
  });

  it("treats bbox edges as inside so a click on a seam still reads", () => {
    const assets = [asset("a.tif", [0, 0, 10, 10])];
    assert.equal(pickMosaicAsset(assets, [10, 10]), "a.tif");
    assert.equal(pickMosaicAsset(assets, [0, 0]), "a.tif");
  });
});
