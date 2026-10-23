import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  policyEnvOverlay,
  readDeploymentEnv,
  readDeploymentEnvValue,
  setDeploymentPolicy,
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

describe("deployment policy overlay", () => {
  it("maps each policy field to its env key", () => {
    assert.deepEqual(policyEnvOverlay(null), {});
    assert.deepEqual(
      policyEnvOverlay({
        version: 1,
        sharing: { shareUrl: "off", collabUrl: "https://c.example" },
        geolens: { url: "same-origin" },
        branding: { appName: "Acme" },
        services: { builtins: false, catalog: [] },
        ai: { enabled: true },
      }),
      {
        VITE_GEOLIBRE_SHARE_URL: "off",
        VITE_GEOLIBRE_COLLAB_URL: "https://c.example",
        VITE_GEOLENS_DEFAULT_URL: "same-origin",
        VITE_GEOLIBRE_APP_NAME: "Acme",
        VITE_GEOLIBRE_SERVICES: '{"services":[]}',
        VITE_GEOLIBRE_BUILTIN_SERVICES: "off",
        VITE_GEOLIBRE_AI_URL: "/ai",
      },
    );
    assert.equal(
      policyEnvOverlay({ version: 1, services: { builtins: true } }).VITE_GEOLIBRE_BUILTIN_SERVICES,
      "on",
    );
  });

  it("contributes nothing for fields a string cannot express", () => {
    assert.deepEqual(
      policyEnvOverlay({
        version: 1,
        ai: { enabled: false, model: "m" },
        capabilities: [],
      }),
      {},
    );
  });

  it("ranks policy over runtime env over build env", () => {
    const runtime = { [KEY]: "https://runtime.example" };
    (globalThis as { window?: unknown }).window = {
      __GEOLIBRE_DEPLOYMENT_ENV__: runtime,
    };
    try {
      const build = { [KEY]: "https://build.example" };
      assert.equal(readDeploymentEnv(), runtime, "no policy: window record untouched");
      assert.equal(readDeploymentEnvValue(KEY, undefined, build), "https://runtime.example");
      setDeploymentPolicy({
        version: 1,
        sharing: { shareUrl: "https://policy.example" },
      });
      assert.equal(readDeploymentEnvValue(KEY, undefined, build), "https://policy.example");
      setDeploymentPolicy({ version: 1, branding: { appName: "x" } });
      assert.equal(readDeploymentEnvValue(KEY, undefined, build), "https://runtime.example");
    } finally {
      setDeploymentPolicy(null);
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
