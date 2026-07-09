import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isGooglePhotorealisticTilesetUrl,
  resolveThreeDTilesRequestHeaders,
} from "../packages/core/src/three-d-tiles";

// Shared 3D-Tiles header resolution: Google Photorealistic tiles keep their
// X-GOOG-API-KEY out of the store and have it re-injected at render time. Both
// the MapLibre and Cesium render paths must resolve it the same way.

const GOOGLE = "https://tile.googleapis.com/v1/3dtiles/root.json";

describe("resolveThreeDTilesRequestHeaders", () => {
  it("passes non-Google tileset headers through unchanged", () => {
    const headers = { Authorization: "Bearer x" };
    assert.equal(
      resolveThreeDTilesRequestHeaders("https://example.com/tileset.json", headers),
      headers,
    );
  });

  it("re-injects the Google key from the fallback when the store stripped it", () => {
    // The store record carries no key (stripped for sharing); the resolver
    // rebuilds the header from the runtime-env fallback.
    assert.deepEqual(resolveThreeDTilesRequestHeaders(GOOGLE, undefined, "env-key"), {
      "X-GOOG-API-KEY": "env-key",
    });
  });

  it("prefers an explicit key already present in the headers", () => {
    assert.deepEqual(
      resolveThreeDTilesRequestHeaders(
        GOOGLE,
        { "X-GOOG-API-KEY": "header-key" },
        "env-key",
      ),
      { "X-GOOG-API-KEY": "header-key" },
    );
  });

  it("ignores a masked placeholder key and falls back", () => {
    assert.deepEqual(
      resolveThreeDTilesRequestHeaders(GOOGLE, { "X-GOOG-API-KEY": "********" }, "env-key"),
      { "X-GOOG-API-KEY": "env-key" },
    );
  });

  it("detects the Google Photorealistic tileset url", () => {
    assert.equal(isGooglePhotorealisticTilesetUrl(GOOGLE), true);
    assert.equal(
      isGooglePhotorealisticTilesetUrl("https://tile.googleapis.com/other"),
      false,
    );
    assert.equal(isGooglePhotorealisticTilesetUrl("not a url"), false);
  });
});
