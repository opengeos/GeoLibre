import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patchMapLibreReadBuffer } from "../scripts/patch-maplibre-read-buffer.mjs";

describe("MapLibre read-buffer patch", () => {
  it("changes the Chromium-tracked READ usage hint", () => {
    const result = patchMapLibreReadBuffer("gl.bufferData(target, 4, gl.STREAM_READ)");
    assert.equal(result.bundle, "gl.bufferData(target, 4, gl.STREAM_DRAW)");
    assert.equal(result.changed, true);
  });

  it("is a no-op after the patch or an upstream fix", () => {
    const result = patchMapLibreReadBuffer("gl.bufferData(target, 4, gl.STREAM_DRAW)");
    assert.equal(result.changed, false);
  });

  it("does not alter an unexpected dependency shape", () => {
    const bundle = "gl.STREAM_READ; gl.STREAM_READ";
    const result = patchMapLibreReadBuffer(bundle);
    assert.equal(result.bundle, bundle);
    assert.equal(result.changed, false);
    assert.equal(result.occurrences, 2);
  });
});
