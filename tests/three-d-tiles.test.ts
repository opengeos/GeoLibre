import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  googleMapsApiKeyHeaderValue,
  isGooglePhotorealisticTilesetUrl,
  nonEmptyRecord,
  persistedThreeDTilesRequestHeaders,
  resolveThreeDTilesRequestHeaders,
  stripGoogleMapsApiKeyHeader,
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
      resolveThreeDTilesRequestHeaders(GOOGLE, { "X-GOOG-API-KEY": "header-key" }, "env-key"),
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
    assert.equal(isGooglePhotorealisticTilesetUrl("https://tile.googleapis.com/other"), false);
    assert.equal(isGooglePhotorealisticTilesetUrl("not a url"), false);
  });
});

// The persistence + header helpers were duplicated in the MapLibre plugin until
// they were centralized here (issue #1142). The plugin now imports them, so the
// tests live with the shared implementation both render paths depend on.

describe("persistedThreeDTilesRequestHeaders", () => {
  it("passes non-Google tileset headers through unchanged", () => {
    const headers = { Authorization: "Bearer x" };
    assert.equal(
      persistedThreeDTilesRequestHeaders("https://example.com/tileset.json", headers),
      headers,
    );
  });

  it("strips the Google key so it never persists in a shared project", () => {
    assert.deepEqual(
      persistedThreeDTilesRequestHeaders(GOOGLE, {
        "X-GOOG-API-KEY": "secret",
        Authorization: "Bearer x",
      }),
      { Authorization: "Bearer x" },
    );
  });

  it("collapses to undefined when only the key header was present", () => {
    assert.equal(
      persistedThreeDTilesRequestHeaders(GOOGLE, { "X-GOOG-API-KEY": "secret" }),
      undefined,
    );
  });
});

describe("stripGoogleMapsApiKeyHeader", () => {
  it("removes the key header case-insensitively and keeps the rest", () => {
    assert.deepEqual(stripGoogleMapsApiKeyHeader({ "x-goog-api-key": "secret", Accept: "json" }), {
      Accept: "json",
    });
  });

  it("returns undefined for empty or missing input", () => {
    assert.equal(stripGoogleMapsApiKeyHeader(undefined), undefined);
    assert.equal(stripGoogleMapsApiKeyHeader({ "X-GOOG-API-KEY": "secret" }), undefined);
  });
});

describe("googleMapsApiKeyHeaderValue", () => {
  it("returns the real key value, case-insensitively", () => {
    assert.equal(googleMapsApiKeyHeaderValue({ "x-goog-api-key": " key " }), "key");
  });

  it("ignores a masked placeholder and missing values", () => {
    assert.equal(googleMapsApiKeyHeaderValue({ "X-GOOG-API-KEY": "****" }), undefined);
    assert.equal(googleMapsApiKeyHeaderValue({ Accept: "json" }), undefined);
    assert.equal(googleMapsApiKeyHeaderValue(undefined), undefined);
  });
});

describe("nonEmptyRecord", () => {
  it("passes a non-empty record through and collapses an empty one", () => {
    const record = { a: "1" };
    assert.equal(nonEmptyRecord(record), record);
    assert.equal(nonEmptyRecord({}), undefined);
    assert.equal(nonEmptyRecord(undefined), undefined);
  });
});
