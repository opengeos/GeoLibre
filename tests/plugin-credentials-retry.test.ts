import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop runtime with a working keychain whose index write and delete can be
// made to fail on demand. Stubs must exist before the modules load.
const INDEX_KEY = "geolibre.pluginCredentials.accounts";
const storage = new Map<string, string>();
const keychain = new Map<string, string>();
let failIndexWrites = false;
let failKeychainDeletes = false;

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failIndexWrites && key === INDEX_KEY) throw new Error("quota");
      storage.set(key, value);
    },
    removeItem: (key: string) => void storage.delete(key),
  },
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "secure_store_get_many") return {};
      if (cmd === "secure_store_set") {
        keychain.set(args.account as string, args.secret as string);
        return null;
      }
      if (cmd === "secure_store_delete") {
        if (failKeychainDeletes) throw new Error("keychain busy");
        keychain.delete(args.account as string);
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
};

// Dynamic imports: the stubs above must exist before these load.
const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { pluginCredentialHost } =
  await import("../apps/geolibre-desktop/src/lib/plugin-credentials");
const { queueCredentialChanges } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

const settle = () => queueCredentialChanges({}, {});
const index = () => JSON.parse(storage.get(INDEX_KEY) ?? "[]") as string[];

describe("app.credentials retries on desktop", () => {
  it("repeating a save after a failed index write persists it instead of reporting success", async () => {
    await hydrateDesktopCredentials();

    failIndexWrites = true;
    assert.equal(pluginCredentialHost.set("k", "v", "p"), false);
    failIndexWrites = false;
    assert.equal(keychain.has("plugin.p.k"), false);

    assert.equal(pluginCredentialHost.set("k", "v", "p"), true);
    await settle();
    assert.equal(keychain.get("plugin.p.k"), "v");
    assert.deepEqual(index(), ["plugin.p.k"]);
  });

  it("keeps the index entry until the keychain delete succeeds, and a repeat retries it", async () => {
    failKeychainDeletes = true;
    pluginCredentialHost.set("k", "", "p");
    await settle();
    assert.equal(keychain.get("plugin.p.k"), "v", "failed delete leaves the secret");
    assert.deepEqual(index(), ["plugin.p.k"], "so the entry stays indexed");

    failKeychainDeletes = false;
    pluginCredentialHost.set("k", "", "p");
    await settle();
    assert.equal(keychain.has("plugin.p.k"), false);
    assert.deepEqual(index(), []);
  });
});
