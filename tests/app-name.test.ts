import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_NAME_ENV_KEY,
  APP_NAME_MAX_LENGTH,
  readConfiguredAppName,
  resolveAppName,
} from "../apps/geolibre-desktop/src/lib/app-name";

describe("readConfiguredAppName", () => {
  it("returns undefined when no env sets a name", () => {
    assert.equal(readConfiguredAppName({}, {}), undefined);
  });

  it("prefers the deployment env over the build env", () => {
    assert.equal(
      readConfiguredAppName({ [APP_NAME_ENV_KEY]: "Acme Maps" }, { [APP_NAME_ENV_KEY]: "Built" }),
      "Acme Maps",
    );
  });

  it("falls back to the build env", () => {
    assert.equal(readConfiguredAppName({}, { [APP_NAME_ENV_KEY]: "Built" }), "Built");
  });

  it("collapses whitespace and treats a blank value as unset", () => {
    assert.equal(
      readConfiguredAppName({ [APP_NAME_ENV_KEY]: "  City\n  of   Knoxville " }, {}),
      "City of Knoxville",
    );
    assert.equal(readConfiguredAppName({ [APP_NAME_ENV_KEY]: " \n " }, {}), undefined);
  });

  it("caps the length without splitting a surrogate pair", () => {
    const long = "🗺".repeat(APP_NAME_MAX_LENGTH + 10);
    const name = readConfiguredAppName({ [APP_NAME_ENV_KEY]: long }, {});
    assert.equal(Array.from(name ?? "").length, APP_NAME_MAX_LENGTH);
    assert.equal(name, "🗺".repeat(APP_NAME_MAX_LENGTH));
  });
});

describe("resolveAppName", () => {
  it("keeps the product default when nothing is configured", () => {
    assert.equal(resolveAppName("GeoLibre Desktop", {}, {}), "GeoLibre Desktop");
  });

  it("replaces the default with the configured name", () => {
    assert.equal(resolveAppName("GeoLibre", { [APP_NAME_ENV_KEY]: "Acme Maps" }, {}), "Acme Maps");
  });
});
