import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime whose keychain is unavailable (e.g. no Secret
// Service on Linux). Must be in place before the modules load.
const storage = new Map<string, string>([
  ["geolibre.desktopSettings", JSON.stringify({ shareToken: "glb_legacy" })],
  ["geolibre.postgres.connectionStrings", JSON.stringify(["postgresql://a:pw@h/db"])],
]);
const keychain = new Map<string, string>();
let keychainAvailable = false;
// When set, the next write signals `started` and waits for `release`.
let hold: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | null =
  null;
// Writes to these accounts fail even while the keychain is available.
const brokenAccounts = new Set<string>();
// Every command the stub received, in order.
const invoked: string[] = [];

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      invoked.push(cmd);
      if (!keychainAvailable) {
        throw new Error(
          "Platform secure storage failure: org.freedesktop.DBus.Error.ServiceUnknown",
        );
      }
      if (cmd === "secure_store_set") {
        if (brokenAccounts.has(args.account as string)) {
          throw new Error("Platform secure storage failure: item is corrupted");
        }
        const held = hold;
        hold = null;
        if (held) {
          held.started.resolve();
          await held.release.promise;
        }
        keychain.set(args.account as string, args.secret as string);
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
};

// The failure path logs by design; keep the test output readable.
console.error = () => {};

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { serializeDesktopSettingsForStorage, useDesktopSettingsStore } =
  await import("../apps/geolibre-desktop/src/hooks/useDesktopSettings");
const {
  forgetPostgresConnection,
  PostgresConnectionForgetError,
  readSavedPostgresConnections,
  rememberPostgresConnection,
} = await import("../apps/geolibre-desktop/src/lib/saved-postgres-connections");
const { queueCredentialChanges, useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

describe("desktop credential hydration without a keychain", () => {
  it("keeps legacy values for the session and reports the failure", async () => {
    await hydrateDesktopCredentials();
    // One read: a locked keyring prompts per read, so a cancel must not re-prompt.
    assert.deepEqual(invoked, ["secure_store_get_many"]);

    assert.match(useCredentialStorageStatus.getState().error ?? "", /ServiceUnknown/);
    const settings = useDesktopSettingsStore.getState().desktopSettings;
    assert.equal(settings.shareToken, "glb_legacy");
    assert.ok(serializeDesktopSettingsForStorage(settings).includes("glb_legacy"));
    assert.equal(
      storage.get("geolibre.postgres.connectionStrings"),
      JSON.stringify(["postgresql://a:pw@h/db"]),
    );
    assert.deepEqual(readSavedPostgresConnections(), ["postgresql://a:pw@h/db"]);
  });

  it("refuses to forget a connection while the keychain is unwritable", () => {
    assert.throws(
      () => forgetPostgresConnection("postgresql://a:pw@h/db"),
      PostgresConnectionForgetError,
    );
    assert.deepEqual(readSavedPostgresConnections(), ["postgresql://a:pw@h/db"]);
  });

  it("keeps new connections in memory only", async () => {
    rememberPostgresConnection("postgresql://b:new@h/db");
    await queueCredentialChanges({}, {});
    assert.deepEqual(readSavedPostgresConnections(), [
      "postgresql://b:new@h/db",
      "postgresql://a:pw@h/db",
    ]);
    assert.equal(storage.has("geolibre.postgres.connectionIds"), false);
    assert.equal(
      storage.get("geolibre.postgres.connectionStrings"),
      JSON.stringify(["postgresql://a:pw@h/db"]),
    );
    assert.equal(keychain.size, 0);
  });

  it("retries a failed write once the keychain is back", async () => {
    const storageBefore = new Map(storage);
    const revision = useCredentialStorageStatus.getState().revision;
    await queueCredentialChanges({}, { "settings.cesiumIonToken": "new" });
    assert.equal(useCredentialStorageStatus.getState().revision, revision + 1);
    assert.equal(keychain.size, 0);

    keychainAvailable = true;
    await queueCredentialChanges({}, {});
    assert.equal(keychain.get("settings.cesiumIonToken"), "new");
    assert.deepEqual(storage, storageBefore);
    // The startup read failed, so values stay session-only: keep the warning.
    assert.notEqual(useCredentialStorageStatus.getState().error, null);
  });

  it("keeps an account marked failed while a newer value is still queued", async () => {
    const account = "settings.mapboxAccessToken";
    const failed = () => useCredentialStorageStatus.getState().failedAccounts[account];
    keychainAvailable = false;
    await queueCredentialChanges({}, { [account]: "pk.old" });
    assert.equal(failed(), true);

    keychainAvailable = true;
    const first = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    const second = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    hold = first;
    const retry = queueCredentialChanges({}, {});
    let newer: Promise<void> = Promise.resolve();
    try {
      await first.started.promise;
      // A newer value arrives while the retry of pk.old is being written; its
      // own write is held too, so the state in between is observable.
      hold = second;
      newer = queueCredentialChanges({ [account]: "pk.old" }, { [account]: "pk.new" });
      first.release.resolve();
      await retry;
      await second.started.promise;
      assert.equal(keychain.get(account), "pk.old");
      assert.equal(failed(), true, "pk.new is not stored yet");
    } finally {
      first.release.resolve();
      second.release.resolve();
    }
    await newer;
    assert.equal(keychain.get(account), "pk.new");
    assert.equal(failed(), undefined);
  });

  it("keeps writing other accounts while one account keeps failing", async () => {
    const status = () => useCredentialStorageStatus.getState().failedAccounts;
    keychainAvailable = true;
    brokenAccounts.add("settings.arcgisApiKey");
    try {
      await queueCredentialChanges({}, { "settings.arcgisApiKey": "AAPT-stuck" });
      // Queued after the stuck account, so it is drained after it.
      await queueCredentialChanges({}, { "settings.shareToken": "glb_after" });
      assert.equal(keychain.get("settings.shareToken"), "glb_after");
      assert.equal(status()["settings.shareToken"], undefined);
      assert.equal(status()["settings.arcgisApiKey"], true);
      assert.equal(keychain.has("settings.arcgisApiKey"), false);
    } finally {
      brokenAccounts.clear();
    }
    await queueCredentialChanges({}, {});
    assert.equal(keychain.get("settings.arcgisApiKey"), "AAPT-stuck");
    assert.equal(status()["settings.arcgisApiKey"], undefined);
  });
});
