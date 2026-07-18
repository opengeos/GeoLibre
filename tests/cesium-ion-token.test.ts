import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCesiumIonToken } from "@geolibre/core";

describe("getCesiumIonToken", () => {
  it("returns undefined when env is missing or empty", () => {
    assert.equal(getCesiumIonToken({}), undefined);
    assert.equal(getCesiumIonToken({ VITE_CESIUM_TOKEN: "" }), undefined);
    assert.equal(getCesiumIonToken({ VITE_CESIUM_TOKEN: "   " }), undefined);
    assert.equal(getCesiumIonToken({ CESIUM_TOKEN: "  " }), undefined);
  });

  it("returns the trimmed VITE_ token when set", () => {
    assert.equal(getCesiumIonToken({ VITE_CESIUM_TOKEN: "  ion.jwt.token  " }), "ion.jwt.token");
  });

  it("falls back to the bare CESIUM_TOKEN", () => {
    assert.equal(getCesiumIonToken({ CESIUM_TOKEN: "  bare-token  " }), "bare-token");
  });

  it("prefers VITE_CESIUM_TOKEN over the bare name", () => {
    assert.equal(
      getCesiumIonToken({
        VITE_CESIUM_TOKEN: "prefixed",
        CESIUM_TOKEN: "bare",
      }),
      "prefixed",
    );
  });

  it("falls back to the bare name when the VITE_ value is blank", () => {
    assert.equal(
      getCesiumIonToken({
        VITE_CESIUM_TOKEN: "   ",
        CESIUM_TOKEN: "bare",
      }),
      "bare",
    );
  });
});
