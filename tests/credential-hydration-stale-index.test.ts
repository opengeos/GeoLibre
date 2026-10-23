import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The launch after a PostGIS save whose keychain write failed: the id index
// names two connections, but only one credential exists. Must be in place
// before the modules load, so they are imported dynamically below.
const KEPT = "0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
const LOST = "7d3f5a8e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const IDS_KEY = "geolibre.postgres.connectionIds";
const storage = new Map<string, string>([[IDS_KEY, JSON.stringify([LOST, KEPT])]]);
const keychain = new Map<string, string>([
  [`postgres.connection.${KEPT}`, "postgresql://a:pw@h/db"],
]);

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
console.error = () => {};

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { readSavedPostgresConnections, rememberPostgresConnection } =
  await import("../apps/geolibre-desktop/src/lib/saved-postgres-connections");
const { queueCredentialChanges, useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

describe("desktop PostGIS index with a missing credential", () => {
  it("drops the stale id, warns, and keeps saving connections", async () => {
    await hydrateDesktopCredentials();
    assert.deepEqual(readSavedPostgresConnections(), ["postgresql://a:pw@h/db"]);
    assert.deepEqual(JSON.parse(storage.get(IDS_KEY) ?? "null"), [KEPT]);
    assert.match(useCredentialStorageStatus.getState().error ?? "", /PostGIS/);

    rememberPostgresConnection("postgresql://b:pw@h/db");
    await queueCredentialChanges({}, {});
    const ids = JSON.parse(storage.get(IDS_KEY) ?? "null") as string[];
    assert.equal(ids.length, 2);
    assert.equal(ids[1], KEPT);
    assert.equal(keychain.get(`postgres.connection.${ids[0]}`), "postgresql://b:pw@h/db");
  });
});
