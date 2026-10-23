import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Web build: no Tauri runtime, so values live in localStorage.
const storage = new Map<string, string>();
let failWrites = false;
let failLegacyRemoval = false;

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("quota");
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      if (failLegacyRemoval && key.startsWith("geolibre:")) throw new Error("denied");
      storage.delete(key);
    },
  },
};

const { pluginCredentialHost } =
  await import("../apps/geolibre-desktop/src/lib/plugin-credentials");

describe("app.credentials on the web build", () => {
  it("stores per plugin in localStorage and deletes on an empty value", () => {
    assert.equal(pluginCredentialHost.location(), "browser");
    assert.equal(pluginCredentialHost.set("token", "a", "plugin-a"), true);
    assert.equal(pluginCredentialHost.set("token", "b", "plugin-b"), true);
    assert.equal(storage.get("geolibre.pluginCredential.plugin-a.token"), "a");
    assert.equal(pluginCredentialHost.get("token", "plugin-a"), "a");
    assert.equal(pluginCredentialHost.get("token", "plugin-b"), "b");

    assert.equal(pluginCredentialHost.set("token", "", "plugin-a"), true);
    assert.equal(storage.has("geolibre.pluginCredential.plugin-a.token"), false);
    assert.equal(pluginCredentialHost.get("token", "plugin-a"), "");
  });

  it("keeps the value for the session when localStorage rejects the write", () => {
    failWrites = true;
    assert.equal(pluginCredentialHost.set("token", "kept", "plugin-c"), false);
    assert.equal(pluginCredentialHost.get("token", "plugin-c"), "kept");
    failWrites = false;
    assert.equal(pluginCredentialHost.set("token", "saved", "plugin-c"), true);
    assert.equal(pluginCredentialHost.get("token", "plugin-c"), "saved");
  });

  it("moves a built-in plugin's pre-app.credentials key on first read", () => {
    storage.set("geolibre:huggingface-token", " hf_web ");
    assert.equal(pluginCredentialHost.get("token", "maplibre-gl-huggingface"), "hf_web");
    assert.equal(storage.get("geolibre.pluginCredential.maplibre-gl-huggingface.token"), "hf_web");
    assert.equal(storage.has("geolibre:huggingface-token"), false);
  });

  it("does not resurrect a legacy key after the token is cleared", () => {
    storage.set("geolibre.godsEyeView.apiKey.tomtom", "old");
    assert.equal(pluginCredentialHost.set("tomtom", "", "gods-eye-view"), true);
    assert.equal(pluginCredentialHost.get("tomtom", "gods-eye-view"), "");
  });

  it("keeps a cleared token cleared when the legacy key cannot be removed", () => {
    storage.set("geolibre:mapillary-access-token", "old");
    failLegacyRemoval = true;
    assert.equal(pluginCredentialHost.set("access-token", "", "maplibre-gl-mapillary"), false);
    failLegacyRemoval = false;
    assert.equal(pluginCredentialHost.get("access-token", "maplibre-gl-mapillary"), "");
  });
});
