import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getGoogleMapsApiKey } from "@geolibre/core";

describe("getGoogleMapsApiKey", () => {
  it("returns undefined when env is missing or empty", () => {
    assert.equal(getGoogleMapsApiKey({}), undefined);
    assert.equal(getGoogleMapsApiKey({ VITE_GOOGLE_MAPS_API_KEY: "" }), undefined);
    assert.equal(getGoogleMapsApiKey({ VITE_GOOGLE_MAPS_API_KEY: "   " }), undefined);
    assert.equal(getGoogleMapsApiKey({ GOOGLE_MAPS_API_KEY: "  " }), undefined);
  });

  it("returns the trimmed VITE_ key when set", () => {
    assert.equal(getGoogleMapsApiKey({ VITE_GOOGLE_MAPS_API_KEY: "  abc123  " }), "abc123");
  });

  it("falls back to the bare GOOGLE_MAPS_API_KEY", () => {
    assert.equal(getGoogleMapsApiKey({ GOOGLE_MAPS_API_KEY: "  bare-key  " }), "bare-key");
  });

  it("prefers VITE_GOOGLE_MAPS_API_KEY over the bare name", () => {
    assert.equal(
      getGoogleMapsApiKey({
        VITE_GOOGLE_MAPS_API_KEY: "prefixed",
        GOOGLE_MAPS_API_KEY: "bare",
      }),
      "prefixed",
    );
  });

  it("falls back to the bare name when the VITE_ value is blank", () => {
    assert.equal(
      getGoogleMapsApiKey({
        VITE_GOOGLE_MAPS_API_KEY: "   ",
        GOOGLE_MAPS_API_KEY: "bare",
      }),
      "bare",
    );
  });
});
