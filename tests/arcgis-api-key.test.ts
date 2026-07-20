import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCesiumIonToken, getArcGISApiKey } from "@geolibre/core";

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

describe("getArcGISApiKey", () => {
  it("returns undefined when env is missing or empty", () => {
    assert.equal(getArcGISApiKey({}), undefined);
    assert.equal(getArcGISApiKey({ VITE_ARCGIS_API_KEY: "" }), undefined);
    assert.equal(getArcGISApiKey({ VITE_ARCGIS_API_KEY: "   " }), undefined);
    assert.equal(getArcGISApiKey({ ARCGIS_API_KEY: "  " }), undefined);
  });

  it("returns the trimmed VITE_ key when set", () => {
    assert.equal(getArcGISApiKey({ VITE_ARCGIS_API_KEY: "  arcgis.key.123  " }), "arcgis.key.123");
  });

  it("falls back to the bare ARCGIS_API_KEY", () => {
    assert.equal(getArcGISApiKey({ ARCGIS_API_KEY: "  bare-key  " }), "bare-key");
  });

  it("prefers VITE_ARCGIS_API_KEY over the bare name", () => {
    assert.equal(
      getArcGISApiKey({
        VITE_ARCGIS_API_KEY: "prefixed",
        ARCGIS_API_KEY: "bare",
      }),
      "prefixed",
    );
  });
});
