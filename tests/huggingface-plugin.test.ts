import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  layerFileName,
  rasterFileName,
  repaintPreservingScroll,
} from "../packages/plugins/src/plugins/maplibre-huggingface";

describe("layerFileName", () => {
  it("slugs a layer name into a .geojson filename", () => {
    assert.equal(layerFileName("Knox County Parks"), "Knox-County-Parks.geojson");
  });

  it("strips path separators, so a name cannot redirect the commit path", () => {
    assert.equal(layerFileName("a/b/c"), "a-b-c.geojson");
    assert.equal(layerFileName("../../etc/passwd"), "etc-passwd.geojson");
  });

  it("strips leading and trailing dots rather than escaping them", () => {
    assert.equal(layerFileName("..hidden.."), "hidden.geojson");
  });

  it("collapses runs of replacement characters", () => {
    assert.equal(layerFileName("a   ---   b"), "a-b.geojson");
  });

  it("falls back when a name slugs away to nothing", () => {
    assert.equal(layerFileName("///"), "layer.geojson");
    assert.equal(layerFileName("   "), "layer.geojson");
  });

  it("bounds the length, so one long name cannot dominate a path", () => {
    assert.ok(layerFileName("x".repeat(500)).length <= 80 + ".geojson".length);
  });
});

describe("rasterFileName", () => {
  it("keeps the name the file was opened under", () => {
    assert.equal(rasterFileName("dem.tif", "Elevation"), "dem.tif");
  });

  it("takes only the basename of a full path", () => {
    assert.equal(rasterFileName("/home/me/data/dem.tif", "Elevation"), "dem.tif");
    assert.equal(rasterFileName("C:\\data\\dem.tif", "Elevation"), "dem.tif");
  });

  it("slugs an unsafe original name while keeping its extension", () => {
    assert.equal(rasterFileName("my dem (2024).tif", "Elevation"), "my-dem-2024.tif");
  });

  it("falls back to the layer name when the original has no extension", () => {
    // A name that lost its extension would upload a file the Hub cannot type.
    assert.equal(rasterFileName("dem", "Elevation Model"), "Elevation-Model.tif");
  });

  it("does not double the extension when the layer is named after its file", () => {
    // A raster layer very often carries its own filename as its display name
    // (a processing-tool output, say), so the fallback has to honour an
    // extension already present rather than appending one.
    assert.equal(rasterFileName("", "clip_output.tif"), "clip_output.tif");
    assert.equal(rasterFileName("", "Knox DEM (2024).tif"), "Knox-DEM-2024.tif");
  });

  it("falls back when there is no original name at all", () => {
    assert.equal(rasterFileName("", "Elevation"), "Elevation.tif");
    assert.equal(rasterFileName("", ""), "raster.tif");
  });

  it("preserves a non-tif raster extension", () => {
    assert.equal(rasterFileName("scene.tiff", "S"), "scene.tiff");
  });
});

describe("repaintPreservingScroll", () => {
  /** Stands in for a scroll container; only `scrollTop` is touched. */
  function fakeList(scrollTop: number) {
    return { scrollTop } as unknown as HTMLElement;
  }

  it("keeps the user's place when the repaint resets the offset", () => {
    // What `replaceChildren` does: the container is momentarily empty, so the
    // browser clamps scrollTop to 0. Pressing Add in a long file listing used
    // to jump back to the top for exactly this reason.
    const list = fakeList(700);
    repaintPreservingScroll(list, () => {
      list.scrollTop = 0;
    });
    assert.equal(list.scrollTop, 700);
  });

  it("still runs the repaint", () => {
    let painted = 0;
    const list = fakeList(0);
    repaintPreservingScroll(list, () => {
      painted += 1;
    });
    assert.equal(painted, 1);
  });

  it("leaves a list that was already at the top alone", () => {
    const list = fakeList(0);
    repaintPreservingScroll(list, () => {
      list.scrollTop = 0;
    });
    assert.equal(list.scrollTop, 0);
  });

  it("restores after the paint, not before, so the paint cannot win", () => {
    const seen: number[] = [];
    const list = fakeList(120);
    repaintPreservingScroll(list, () => {
      seen.push(list.scrollTop);
      list.scrollTop = 0;
    });
    assert.deepEqual(seen, [120]);
    assert.equal(list.scrollTop, 120);
  });
});
