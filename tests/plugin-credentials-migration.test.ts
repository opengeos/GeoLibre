import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime with an in-memory keychain whose writes can fail.
const storage = new Map<string, string>();
const keychain = new Map<string, string>();
let failSets = false;

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "secure_store_get_many") {
        const accounts = args.accounts as string[];
        return Object.fromEntries(
          accounts.filter((a) => keychain.has(a)).map((a) => [a, keychain.get(a)]),
        );
      }
      if (cmd === "secure_store_set") {
        if (failSets) throw new Error("keychain locked");
        keychain.set(args.account as string, args.secret as string);
        return null;
      }
      if (cmd === "secure_store_delete") {
        keychain.delete(args.account as string);
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
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

const index = () => JSON.parse(storage.get("geolibre.pluginCredentials.accounts") ?? "[]");

describe("built-in plugin token migration on desktop", () => {
  it("moves legacy localStorage values into the keychain, legacy winning, and removes them", async () => {
    storage.set("geolibre:huggingface-token", " hf_legacy ");
    storage.set("geolibre.godsEyeView.apiKey.tomtom", "tt_new");
    storage.set(
      "geolibre.pluginCredentials.accounts",
      JSON.stringify(["plugin.gods-eye-view.tomtom"]),
    );
    keychain.set("plugin.gods-eye-view.tomtom", "tt_old");

    await hydrateDesktopCredentials();

    assert.equal(keychain.get("plugin.maplibre-gl-huggingface.token"), "hf_legacy");
    assert.equal(keychain.get("plugin.gods-eye-view.tomtom"), "tt_new");
    assert.equal(storage.has("geolibre:huggingface-token"), false);
    assert.equal(storage.has("geolibre.godsEyeView.apiKey.tomtom"), false);
    assert.deepEqual(index().sort(), [
      "plugin.gods-eye-view.tomtom",
      "plugin.maplibre-gl-huggingface.token",
    ]);
    assert.equal(pluginCredentialHost.get("token", "maplibre-gl-huggingface"), "hf_legacy");
    assert.ok(![...storage.values()].some((value) => value.includes("hf_legacy")));
  });

  it("keeps the legacy value and warns when the keychain write fails", async () => {
    failSets = true;
    storage.set("geolibre:mapillary-access-token", "MLY|legacy");

    await hydrateDesktopCredentials();

    assert.equal(pluginCredentialHost.get("access-token", "maplibre-gl-mapillary"), "MLY|legacy");
    assert.equal(storage.get("geolibre:mapillary-access-token"), "MLY|legacy");
    assert.notEqual(useCredentialStorageStatus.getState().error, null);
  });
});
