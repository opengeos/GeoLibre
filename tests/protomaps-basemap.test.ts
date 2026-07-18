import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getProtomapsApiKey, getProtomapsStyleUrl, PROTOMAPS_BASEMAPS } from "@geolibre/core";

describe("getProtomapsApiKey", () => {
  it("returns undefined when env is missing or empty", () => {
    assert.equal(getProtomapsApiKey({}), undefined);
    assert.equal(getProtomapsApiKey({ VITE_PROTOMAPS_API_KEY: "" }), undefined);
    assert.equal(getProtomapsApiKey({ VITE_PROTOMAPS_API_KEY: "   " }), undefined);
  });

  it("returns the trimmed key when set", () => {
    assert.equal(getProtomapsApiKey({ VITE_PROTOMAPS_API_KEY: "  abc123  " }), "abc123");
  });
});

describe("getProtomapsStyleUrl", () => {
  it("returns undefined when no API key is configured", () => {
    assert.equal(getProtomapsStyleUrl("light", {}), undefined);
  });

  it("builds the v5 style URL with the encoded key", () => {
    assert.equal(
      getProtomapsStyleUrl("dark", { VITE_PROTOMAPS_API_KEY: "k e/y" }),
      "https://api.protomaps.com/styles/v5/dark/en.json?key=k%20e%2Fy",
    );
  });

  it("encodes the flavor path segment", () => {
    assert.equal(
      getProtomapsStyleUrl("a/b?c", { VITE_PROTOMAPS_API_KEY: "key" }),
      "https://api.protomaps.com/styles/v5/a%2Fb%3Fc/en.json?key=key",
    );
  });

  it("resolves a URL for every advertised flavor", () => {
    for (const basemap of PROTOMAPS_BASEMAPS) {
      const url = getProtomapsStyleUrl(basemap.flavor, {
        VITE_PROTOMAPS_API_KEY: "key",
      });
      assert.equal(url, `https://api.protomaps.com/styles/v5/${basemap.flavor}/en.json?key=key`);
    }
  });
});

describe("PROTOMAPS_BASEMAPS", () => {
  it("offers the five Protomaps v5 flavors", () => {
    assert.deepEqual(
      PROTOMAPS_BASEMAPS.map((b) => b.flavor),
      ["light", "dark", "white", "grayscale", "black"],
    );
  });
});
