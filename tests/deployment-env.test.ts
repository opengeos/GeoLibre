import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readDeploymentEnv,
  readDeploymentEnvValue,
} from "../apps/geolibre-desktop/src/lib/deployment-env";

const KEY = "VITE_GEOLIBRE_SHARE_URL";

describe("readDeploymentEnvValue", () => {
  it("prefers the deployment env over the build env", () => {
    assert.equal(
      readDeploymentEnvValue(
        KEY,
        { [KEY]: "https://deploy.example" },
        { [KEY]: "https://build.example" },
      ),
      "https://deploy.example",
    );
  });

  it("falls through to the build env when the deployment omits the key", () => {
    assert.equal(
      readDeploymentEnvValue(KEY, {}, { [KEY]: "https://build.example" }),
      "https://build.example",
    );
  });

  // The entrypoint omits a key it has no value for, but a hand-written config or
  // a bare `-e VAR=` can still produce an empty string; that must not shadow the
  // build-time value.
  it("treats a blank deployment value as unset", () => {
    assert.equal(
      readDeploymentEnvValue(KEY, { [KEY]: "   " }, { [KEY]: "https://build.example" }),
      "https://build.example",
    );
  });

  it("returns undefined when neither source sets the key", () => {
    assert.equal(readDeploymentEnvValue(KEY, {}, {}), undefined);
    assert.equal(readDeploymentEnvValue(KEY, undefined, undefined), undefined);
  });
});

describe("readDeploymentEnv", () => {
  it("returns undefined without a window (node, SSR)", () => {
    assert.equal(typeof globalThis.window, "undefined");
    assert.equal(readDeploymentEnv(), undefined);
  });

  it("reads the record the Docker entrypoint writes onto window", () => {
    const win = { __GEOLIBRE_DEPLOYMENT_ENV__: { [KEY]: "https://maps.example.org" } };
    (globalThis as { window?: unknown }).window = win;
    try {
      assert.deepEqual(readDeploymentEnv(), { [KEY]: "https://maps.example.org" });
      assert.equal(readDeploymentEnvValue(KEY, undefined, {}), "https://maps.example.org");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
