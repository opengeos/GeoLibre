import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime with a working in-memory keychain. Must be in place
// before the modules load.
const storage = new Map<string, string>([
  ["geolibre.pluginCredentials.accounts", JSON.stringify(["plugin.ext-plugin.api-key"])],
]);
const keychain = new Map<string, string>([["plugin.ext-plugin.api-key", "ext_secret"]]);

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

import type { GeoLibreAppAPI, GeoLibrePlugin } from "../packages/plugins/src/types";

// Dynamic imports: the Tauri/localStorage stubs above must exist before these load.
const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { pluginCredentialHost } =
  await import("../apps/geolibre-desktop/src/lib/plugin-credentials");
const { queueCredentialChanges } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");
const { PluginManager } = await import("../packages/plugins/src/plugin-manager");

// Resolves once every queued keychain write has drained.
const settle = () => queueCredentialChanges({}, {});
const index = () => JSON.parse(storage.get("geolibre.pluginCredentials.accounts") ?? "[]");

describe("app.credentials on desktop", () => {
  it("loads indexed values at startup and stores changes in the keychain under the plugin id", async () => {
    await hydrateDesktopCredentials();

    let scoped: GeoLibreAppAPI | undefined;
    const manager = new PluginManager();
    manager.register({
      id: "ext-plugin",
      name: "Ext",
      version: "1.0.0",
      activate: (api) => void (scoped = api),
      deactivate: () => undefined,
    } as GeoLibrePlugin);
    manager.activate("ext-plugin", {
      credentials: pluginCredentialHost,
    } as unknown as GeoLibreAppAPI);
    const credentials = scoped?.credentials;
    assert.ok(credentials);

    assert.equal(credentials.get("api-key"), "ext_secret");
    assert.equal(credentials.location(), "keychain");

    assert.equal(credentials.set("api-key", "ext_rotated"), true);
    assert.equal(credentials.set("other", "second"), true);
    await settle();
    assert.equal(keychain.get("plugin.ext-plugin.api-key"), "ext_rotated");
    assert.equal(keychain.get("plugin.ext-plugin.other"), "second");
    assert.deepEqual(index().sort(), ["plugin.ext-plugin.api-key", "plugin.ext-plugin.other"]);
    assert.ok(![...storage.values()].some((value) => value.includes("ext_rotated")));

    assert.equal(credentials.set("api-key", ""), true);
    await settle();
    assert.equal(keychain.has("plugin.ext-plugin.api-key"), false);
    assert.deepEqual(index(), ["plugin.ext-plugin.other"]);
    assert.equal(credentials.get("api-key"), "");

    assert.throws(() => credentials.get("a.b"), TypeError);
    assert.throws(() => credentials.set("", "x"), TypeError);
  });

  it("rejects calls that bypass the plugin-scoped app", () => {
    assert.throws(() => pluginCredentialHost.get("api-key"), /app API a plugin receives/);
  });
});
