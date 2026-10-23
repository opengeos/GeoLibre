import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime with a working in-memory keychain. Must be in place
// before the modules load: the settings store reads localStorage on import.
const storage = new Map<string, string>([
  [
    "geolibre.desktopSettings",
    JSON.stringify({ shareToken: "glb_legacy", cesiumIonToken: "ion_legacy" }),
  ],
  ["geolibre.postgres.connectionStrings", JSON.stringify(["postgresql://a:pw@h/db"])],
]);
const keychain = new Map<string, string>();
let failDeletes = false;
let deleteGate: Promise<void> | null = null;
let failPendingJournalReads = false;
let failPendingJournalReadsAfterIndexWrite = false;
const deleteCalls: string[] = [];

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => {
      if (key === "geolibre.postgres.pendingDeletionIds" && failPendingJournalReads) {
        throw new Error("localStorage journal is unavailable");
      }
      return storage.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      storage.set(key, value);
      if (key === "geolibre.postgres.connectionIds" && failPendingJournalReadsAfterIndexWrite) {
        failPendingJournalReadsAfterIndexWrite = false;
        failPendingJournalReads = true;
      }
    },
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
        deleteCalls.push(args.account as string);
        await deleteGate;
        if (failDeletes) {
          throw new Error("Platform secure storage failure: item is locked");
        }
        keychain.delete(args.account as string);
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
};

console.error = () => {};

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { serializeDesktopSettingsForStorage, useDesktopSettingsStore } =
  await import("../apps/geolibre-desktop/src/hooks/useDesktopSettings");
const {
  forgetPostgresConnection,
  postgresConnectionAccount,
  readSavedPostgresConnections,
  rememberPostgresConnection,
  PostgresConnectionForgetError,
} = await import("../apps/geolibre-desktop/src/lib/saved-postgres-connections");
const { queueCredentialChanges, useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

const connectionIds = () =>
  JSON.parse(storage.get("geolibre.postgres.connectionIds") ?? "null") as string[];

const pendingIds = () =>
  JSON.parse(storage.get("geolibre.postgres.pendingDeletionIds") ?? "[]") as string[];
const idFor = (connection: string) =>
  connectionIds().find((id) => keychain.get(postgresConnectionAccount(id)) === connection)!;
describe("desktop credential hydration", () => {
  it("migrates legacy plaintext credentials into the keychain", async () => {
    await hydrateDesktopCredentials();

    assert.equal(useCredentialStorageStatus.getState().error, null);
    assert.equal(keychain.get("settings.shareToken"), "glb_legacy");
    assert.equal(keychain.get("settings.cesiumIonToken"), "ion_legacy");
    const [firstId] = connectionIds();
    assert.equal(keychain.get(`postgres.connection.${firstId}`), "postgresql://a:pw@h/db");

    const settings = useDesktopSettingsStore.getState().desktopSettings;
    assert.equal(settings.shareToken, "glb_legacy");
    const serialized = serializeDesktopSettingsForStorage(settings);
    assert.ok(!serialized.includes("glb_legacy"));
    assert.ok(!serialized.includes("ion_legacy"));

    assert.equal(storage.has("geolibre.postgres.connectionStrings"), false);
    assert.deepEqual(readSavedPostgresConnections(), ["postgresql://a:pw@h/db"]);
  });

  it("reorders saved connections without rewriting their credentials", async () => {
    const [firstId] = connectionIds();
    rememberPostgresConnection("postgresql://b:pw@h/db");
    await queueCredentialChanges({}, {});
    const [secondId, stillFirstId] = connectionIds();
    assert.equal(stillFirstId, firstId);
    assert.equal(keychain.get(`postgres.connection.${secondId}`), "postgresql://b:pw@h/db");

    const before = new Map(keychain);
    rememberPostgresConnection("postgresql://a:pw@h/db");
    await queueCredentialChanges({}, {});
    assert.deepEqual(connectionIds(), [firstId, secondId]);
    assert.deepEqual(keychain, before);
    assert.deepEqual(readSavedPostgresConnections(), [
      "postgresql://a:pw@h/db",
      "postgresql://b:pw@h/db",
    ]);
    assert.ok(![...storage.values()].some((value) => value.includes(":pw@")));
  });
  it("forgets a connection after the keychain confirms deletion", async () => {
    const b = "postgresql://b:pw@h/db";
    const bId = idFor(b);

    const result = forgetPostgresConnection(b);

    assert.deepEqual(result.connections, ["postgresql://a:pw@h/db"]);
    assert.equal(await result.credentialDeleted, true);
    assert.equal(keychain.has(postgresConnectionAccount(bId)), false);
    assert.deepEqual(pendingIds(), []);
    assert.ok(!connectionIds().includes(bId));

    await hydrateDesktopCredentials();
    assert.deepEqual(readSavedPostgresConnections(), ["postgresql://a:pw@h/db"]);
  });

  it("keeps a failed deletion queued and finishes it after a restart", async () => {
    const c = "postgresql://c:pw@h/db";
    rememberPostgresConnection(c);
    await queueCredentialChanges({}, {});
    const cId = idFor(c);
    failDeletes = true;

    const result = forgetPostgresConnection(c);

    assert.equal(await result.credentialDeleted, false);
    assert.equal(keychain.get(postgresConnectionAccount(cId)), c);
    assert.deepEqual(pendingIds(), [cId]);
    assert.ok(!readSavedPostgresConnections().includes(c));

    await hydrateDesktopCredentials();
    assert.ok(!readSavedPostgresConnections().includes(c));
    assert.deepEqual(pendingIds(), [cId]);

    failDeletes = false;
    await hydrateDesktopCredentials();
    assert.equal(keychain.has(postgresConnectionAccount(cId)), false);
    assert.deepEqual(pendingIds(), []);
  });

  it("re-saving a connection whose deletion is pending keeps the new credential", async () => {
    const d = "postgresql://d:pw@h/db";
    rememberPostgresConnection(d);
    await queueCredentialChanges({}, {});
    const oldId = idFor(d);
    failDeletes = true;
    const result = forgetPostgresConnection(d);
    assert.equal(await result.credentialDeleted, false);

    rememberPostgresConnection(d);
    await queueCredentialChanges({}, {});
    const newId = idFor(d);
    assert.notEqual(newId, oldId);
    assert.equal(keychain.get(postgresConnectionAccount(newId)), d);

    failDeletes = false;
    await hydrateDesktopCredentials();
    assert.equal(keychain.has(postgresConnectionAccount(oldId)), false);
    assert.equal(keychain.get(postgresConnectionAccount(newId)), d);
    assert.ok(readSavedPostgresConnections().includes(d));
  });

  it("a forget cannot be overtaken by its connection's queued save", async () => {
    const e = "postgresql://e:pw@h/db";
    rememberPostgresConnection(e);
    const result = forgetPostgresConnection(e);

    assert.equal(await result.credentialDeleted, true);
    await queueCredentialChanges({}, {});
    assert.ok(![...keychain.values()].includes(e));
  });

  it("an interrupted forget keeps the connection and its credential", async () => {
    const a = "postgresql://a:pw@h/db";
    const aId = idFor(a);
    const originalSet = storage.set;
    storage.set = (key, value) => {
      if (key === "geolibre.postgres.connectionIds") {
        throw new Error("localStorage is unavailable");
      }
      return originalSet.call(storage, key, value);
    };
    try {
      assert.throws(() => forgetPostgresConnection(a), PostgresConnectionForgetError);
    } finally {
      storage.set = originalSet;
    }

    assert.ok(pendingIds().includes(aId));
    await hydrateDesktopCredentials();
    assert.ok(readSavedPostgresConnections().includes(a));
    assert.equal(keychain.get(postgresConnectionAccount(aId)), a);
    assert.deepEqual(pendingIds(), []);
  });
  it("reports the selected deletion's native acknowledgement when journal reads fail", async () => {
    const confirmed = "postgresql://journal-confirmed:pw@h/db";
    rememberPostgresConnection(confirmed);
    await queueCredentialChanges({}, {});
    const confirmedId = idFor(confirmed);
    const confirmedDeleteStart = deleteCalls.length;
    failPendingJournalReadsAfterIndexWrite = true;
    let confirmedDeleted = false;
    try {
      const confirmedResult = forgetPostgresConnection(confirmed);
      confirmedDeleted = await confirmedResult.credentialDeleted;
    } finally {
      failPendingJournalReads = false;
      failPendingJournalReadsAfterIndexWrite = false;
    }
    assert.equal(confirmedDeleted, true);
    assert.ok(
      deleteCalls.slice(confirmedDeleteStart).includes(postgresConnectionAccount(confirmedId)),
    );
    assert.equal(keychain.has(postgresConnectionAccount(confirmedId)), false);
    assert.deepEqual(pendingIds(), [confirmedId]);

    const refused = "postgresql://journal-refused:pw@h/db";
    rememberPostgresConnection(refused);
    await queueCredentialChanges({}, {});
    const refusedId = idFor(refused);
    const refusedDeleteStart = deleteCalls.length;
    failDeletes = true;
    failPendingJournalReadsAfterIndexWrite = true;
    let refusedDeleted = true;
    try {
      const refusedResult = forgetPostgresConnection(refused);
      refusedDeleted = await refusedResult.credentialDeleted;
    } finally {
      failPendingJournalReads = false;
      failPendingJournalReadsAfterIndexWrite = false;
      failDeletes = false;
    }
    assert.equal(refusedDeleted, false);
    assert.ok(deleteCalls.slice(refusedDeleteStart).includes(postgresConnectionAccount(refusedId)));
    assert.equal(keychain.get(postgresConnectionAccount(refusedId)), refused);
    assert.deepEqual(pendingIds(), [confirmedId, refusedId]);

    await hydrateDesktopCredentials();
    assert.equal(keychain.has(postgresConnectionAccount(confirmedId)), false);
    assert.equal(keychain.has(postgresConnectionAccount(refusedId)), false);
    assert.deepEqual(pendingIds(), []);
  });

  it("preserves a corrupt deletion journal until it can be restored", async () => {
    const pending = "postgresql://journal-pending:pw@h/db";
    rememberPostgresConnection(pending);
    await queueCredentialChanges({}, {});
    const pendingId = idFor(pending);
    failDeletes = true;
    try {
      const pendingResult = forgetPostgresConnection(pending);
      assert.equal(await pendingResult.credentialDeleted, false);
    } finally {
      failDeletes = false;
    }

    const saved = "postgresql://journal-saved:pw@h/db";
    rememberPostgresConnection(saved);
    await queueCredentialChanges({}, {});
    const savedId = idFor(saved);
    for (const corruptJournal of ["{", "{}", "[42]"]) {
      storage.set("geolibre.postgres.pendingDeletionIds", corruptJournal);

      const revisionBeforeForget = useCredentialStorageStatus.getState().revision;
      assert.throws(() => forgetPostgresConnection(saved), PostgresConnectionForgetError);
      assert.ok(useCredentialStorageStatus.getState().revision > revisionBeforeForget);
      assert.ok(connectionIds().includes(savedId));
      assert.equal(keychain.get(postgresConnectionAccount(savedId)), saved);
      assert.equal(storage.get("geolibre.postgres.pendingDeletionIds"), corruptJournal);

      const revisionBeforeResume = useCredentialStorageStatus.getState().revision;
      await hydrateDesktopCredentials();
      assert.ok(useCredentialStorageStatus.getState().revision > revisionBeforeResume);
      assert.ok(connectionIds().includes(savedId));
      assert.equal(keychain.get(postgresConnectionAccount(savedId)), saved);
      assert.equal(storage.get("geolibre.postgres.pendingDeletionIds"), corruptJournal);
    }

    const corruptJournal = storage.get("geolibre.postgres.pendingDeletionIds");
    const revisionBeforeUnreadableForget = useCredentialStorageStatus.getState().revision;
    failPendingJournalReads = true;
    try {
      assert.throws(() => forgetPostgresConnection(saved), PostgresConnectionForgetError);
      assert.ok(useCredentialStorageStatus.getState().revision > revisionBeforeUnreadableForget);
      assert.ok(connectionIds().includes(savedId));
      assert.equal(keychain.get(postgresConnectionAccount(savedId)), saved);
      assert.equal(storage.get("geolibre.postgres.pendingDeletionIds"), corruptJournal);

      const revisionBeforeUnreadableResume = useCredentialStorageStatus.getState().revision;
      await hydrateDesktopCredentials();
      assert.ok(useCredentialStorageStatus.getState().revision > revisionBeforeUnreadableResume);
      assert.ok(connectionIds().includes(savedId));
      assert.equal(keychain.get(postgresConnectionAccount(savedId)), saved);
      assert.equal(storage.get("geolibre.postgres.pendingDeletionIds"), corruptJournal);
    } finally {
      failPendingJournalReads = false;
    }

    storage.set("geolibre.postgres.pendingDeletionIds", JSON.stringify([pendingId]));
    await hydrateDesktopCredentials();
    assert.equal(keychain.has(postgresConnectionAccount(pendingId)), false);
    assert.ok(connectionIds().includes(savedId));
    assert.equal(keychain.get(postgresConnectionAccount(savedId)), saved);
    assert.deepEqual(pendingIds(), []);
  });

  it("shares an in-flight deletion across rapid forgets", async () => {
    const first = "postgresql://rapid-first:pw@h/db";
    const second = "postgresql://rapid-second:pw@h/db";
    rememberPostgresConnection(first);
    rememberPostgresConnection(second);
    await queueCredentialChanges({}, {});
    const firstAccount = postgresConnectionAccount(idFor(first));
    const secondAccount = postgresConnectionAccount(idFor(second));
    const start = deleteCalls.length;
    let release!: () => void;
    deleteGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const firstResult = forgetPostgresConnection(first);
      const secondResult = forgetPostgresConnection(second);
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      assert.deepEqual(
        await Promise.all([firstResult.credentialDeleted, secondResult.credentialDeleted]),
        [true, true],
      );
      assert.deepEqual(deleteCalls.slice(start), [firstAccount, secondAccount]);
      assert.equal(keychain.has(firstAccount), false);
      assert.equal(keychain.has(secondAccount), false);
      assert.deepEqual(pendingIds(), []);
    } finally {
      release();
      deleteGate = null;
    }
  });
});
