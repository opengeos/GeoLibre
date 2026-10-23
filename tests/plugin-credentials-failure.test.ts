import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime whose keychain read fails (locked or unavailable).
const storage = new Map<string, string>([
  ["geolibre.pluginCredentials.accounts", JSON.stringify(["plugin.ext-plugin.api-key"])],
  ["geolibre:mapillary-access-token", "MLY|legacy"],
]);
const invoked: string[] = [];

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string) => {
      invoked.push(cmd);
      throw new Error("keychain locked");
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
};

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { pluginCredentialHost } =
  await import("../apps/geolibre-desktop/src/lib/plugin-credentials");
const { useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

describe("app.credentials when the keychain is unavailable", () => {
  it("keeps values in memory, never writes plaintext, and raises the warning", async () => {
    await hydrateDesktopCredentials();
    const readCalls = invoked.length;

    assert.equal(pluginCredentialHost.set("api-key", "hf_new", "ext-plugin"), false);
    assert.equal(pluginCredentialHost.get("api-key", "ext-plugin"), "hf_new");
    assert.equal(invoked.length, readCalls, "no further keychain commands after the failed read");
    assert.ok(![...storage.values()].some((value) => value.includes("hf_new")));
    assert.notEqual(useCredentialStorageStatus.getState().error, null);
  });

  it("keeps a legacy built-in token usable and in place when the keychain read fails", () => {
    assert.equal(pluginCredentialHost.get("access-token", "maplibre-gl-mapillary"), "MLY|legacy");
    assert.equal(storage.get("geolibre:mapillary-access-token"), "MLY|legacy");
  });
});
