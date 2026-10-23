import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";
import {
  findMssqlConnectionId,
  forgetMssqlConnection,
  isMssqlConnectionProfile,
  mssqlConnectionAccount,
  mssqlConnectionLabel,
  rememberMssqlConnection,
  readSavedMssqlConnections,
  savedMssqlSecret,
  MSSQL_CONNECTIONS_STORAGE_KEY,
  MAX_SAVED_MSSQL_CONNECTIONS,
  setKeychainMssqlSecrets,
  setMssqlKeychainWritable,
  type MssqlConnectionProfile,
  type RememberedMssqlConnections,
} from "../apps/geolibre-desktop/src/lib/saved-mssql-connections";

class Storage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
function profile(id: string, server = `sql${id}.example`): MssqlConnectionProfile {
  return {
    id,
    server,
    port: 1433,
    database: "gis",
    encrypt: true,
    trustServerCertificate: false,
    authMethod: "sql",
    username: "sa",
  };
}
describe("saved MSSQL connections", () => {
  it("upserts by id, caps MRU profiles, drops invalid entries, and matches server case-insensitively", () => {
    const prior = globalThis.window;
    const storage = new Storage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage, dispatchEvent() {} },
    });
    try {
      let latest: RememberedMssqlConnections | undefined;
      for (let n = 1; n <= MAX_SAVED_MSSQL_CONNECTIONS + 1; n++) {
        latest = rememberMssqlConnection(
          profile(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
          null,
        );
      }
      assert.deepEqual(
        latest?.evictedProfiles.map((item) => item.id),
        ["00000000-0000-4000-8000-000000000001"],
      );
      const first = profile("00000000-0000-4000-8000-000000000001");
      const updated = { ...first, server: "SQL1.EXAMPLE" };
      const refreshed = rememberMssqlConnection(updated, null);
      assert.deepEqual(
        refreshed.evictedProfiles.map((item) => item.id),
        ["00000000-0000-4000-8000-000000000002"],
      );
      assert.equal(readSavedMssqlConnections().length, MAX_SAVED_MSSQL_CONNECTIONS);
      assert.equal(readSavedMssqlConnections()[0].server, "SQL1.EXAMPLE");
      assert.equal(
        findMssqlConnectionId({ ...updated, server: updated.server.toLowerCase() }),
        first.id,
      );
      const data = JSON.parse(storage.getItem(MSSQL_CONNECTIONS_STORAGE_KEY) ?? "[]");
      data.push({ ...first, port: 0 });
      storage.setItem(MSSQL_CONNECTIONS_STORAGE_KEY, JSON.stringify(data));
      assert.equal(
        readSavedMssqlConnections().some((item) => item.port === 0),
        false,
      );
      assert.equal(isMssqlConnectionProfile({ ...first, id: "bad" }), false);
    } finally {
      if (prior) Object.defineProperty(globalThis, "window", { configurable: true, value: prior });
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("treats TLS flag changes as distinct saved profiles", () => {
    const prior = globalThis.window;
    const storage = new Storage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage, dispatchEvent() {} },
    });
    try {
      setKeychainMssqlSecrets({});
      const saved = profile("00000000-0000-4000-8000-000000000001");
      rememberMssqlConnection(saved, null);
      const { id: _id, ...candidate } = saved;
      assert.equal(findMssqlConnectionId({ ...candidate, encrypt: false }), undefined);
      assert.equal(
        findMssqlConnectionId({ ...candidate, trustServerCertificate: true }),
        undefined,
      );
    } finally {
      if (prior) Object.defineProperty(globalThis, "window", { configurable: true, value: prior });
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("never persists profile secrets in browser localStorage", () => {
    const prior = globalThis.window;
    const storage = new Storage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage, dispatchEvent() {} },
    });
    setKeychainMssqlSecrets({});
    try {
      const profileWithSecrets = {
        ...profile("00000000-0000-4000-8000-000000000001"),
        password: "password-leak",
        clientSecret: "client-secret-leak",
        accessToken: "token-leak",
      } as MssqlConnectionProfile;
      rememberMssqlConnection(profileWithSecrets, { password: "secret-value" });
      const stored = storage.getItem(MSSQL_CONNECTIONS_STORAGE_KEY) ?? "";
      assert.equal(stored.includes("password-leak"), false);
      assert.equal(stored.includes("client-secret-leak"), false);
      assert.equal(stored.includes("token-leak"), false);
      assert.equal(stored.includes("secret-value"), false);
      storage.setItem(MSSQL_CONNECTIONS_STORAGE_KEY, JSON.stringify([profileWithSecrets]));
      const restored = readSavedMssqlConnections()[0] as MssqlConnectionProfile &
        Record<string, unknown>;
      assert.equal("password" in restored, false);
      assert.equal("clientSecret" in restored, false);
      assert.equal("accessToken" in restored, false);
    } finally {
      if (prior) Object.defineProperty(globalThis, "window", { configurable: true, value: prior });
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
  it("forgets a profile, its in-memory secret, and its keychain account", async () => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
    const storage = new Storage();
    const commands: Array<[string, { account?: string }]> = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        dispatchEvent() {},
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: { account?: string }) => {
            commands.push([command, args]);
          },
        },
      },
    });
    const forgotten = profile("00000000-0000-4000-8000-000000000001");
    const retained = profile("00000000-0000-4000-8000-000000000002");
    setKeychainMssqlSecrets({
      [forgotten.id]: { password: "secret" },
      [retained.id]: { password: "keep" },
    });
    setMssqlKeychainWritable(false);
    storage.setItem(MSSQL_CONNECTIONS_STORAGE_KEY, JSON.stringify([forgotten, retained]));
    try {
      const profiles = forgetMssqlConnection(forgotten.id);
      assert.deepEqual(
        profiles.map((item) => item.id),
        [retained.id],
      );
      assert.deepEqual(
        readSavedMssqlConnections().map((item) => item.id),
        [retained.id],
      );
      assert.equal(savedMssqlSecret(forgotten.id), undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(
        commands.some(
          ([command, args]) =>
            command === "secure_store_delete" &&
            args.account === mssqlConnectionAccount(forgotten.id),
        ),
      );
    } finally {
      setKeychainMssqlSecrets({});
      setMssqlKeychainWritable(true);
      if (prior) Object.defineProperty(globalThis, "window", prior);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
  it("deletes the evicted keychain account when startup hydration was not writable", async () => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
    const storage = new Storage();
    const commands: Array<[string, { account?: string }]> = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        dispatchEvent() {},
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: { account?: string }) => {
            commands.push([command, args]);
          },
        },
      },
    });
    const savedProfiles = Array.from({ length: MAX_SAVED_MSSQL_CONNECTIONS }, (_, index) =>
      profile(`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`),
    );
    const evictedId = savedProfiles[savedProfiles.length - 1].id;
    storage.setItem(MSSQL_CONNECTIONS_STORAGE_KEY, JSON.stringify(savedProfiles));
    setKeychainMssqlSecrets({ [evictedId]: { password: "secret" } });
    setMssqlKeychainWritable(false);
    try {
      const result = rememberMssqlConnection(profile("00000000-0000-4000-8000-000000000011"), null);
      assert.deepEqual(
        result.evictedProfiles.map((item) => item.id),
        [evictedId],
      );
      assert.equal(savedMssqlSecret(evictedId), undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(
        commands.some(
          ([command, args]) =>
            command === "secure_store_delete" && args.account === mssqlConnectionAccount(evictedId),
        ),
      );
    } finally {
      setKeychainMssqlSecrets({});
      setMssqlKeychainWritable(true);
      if (prior) Object.defineProperty(globalThis, "window", prior);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("adds authentication and TLS differences to connection labels", () => {
    const translate = ((key: string) => `translated:${key}`) as unknown as TFunction;
    const sql = profile("00000000-0000-4000-8000-000000000001");
    assert.equal(
      mssqlConnectionLabel(sql, translate),
      "sa@sql00000000-0000-4000-8000-000000000001.example/gis",
    );
    assert.equal(
      mssqlConnectionLabel(
        { ...sql, authMethod: "windows", encrypt: false, trustServerCertificate: true },
        translate,
      ),
      "sa@sql00000000-0000-4000-8000-000000000001.example/gis — translated:addData.mssql.auth.windows, translated:addData.mssql.labelEncryptionDisabled, translated:addData.mssql.labelTrustCertificate",
    );
  });
});
