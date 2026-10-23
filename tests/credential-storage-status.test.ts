import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop runtime with a working keychain; writes to these accounts fail.
const failing = new Set<string>();
(globalThis as { window?: unknown }).window = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "secure_store_set" && failing.has(args.account as string)) {
        throw new Error("Platform secure storage failure: item is locked");
      }
      return null;
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
};

// The failure path logs by design; keep the test output readable.
console.error = () => {};

const { queueCredentialChanges, reportCredentialStorageError, useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

describe("credential storage warning", () => {
  it("stays until every failed write has been retried, then clears", async () => {
    failing.add("a").add("b");
    await queueCredentialChanges({}, { a: "1", b: "2" });
    assert.match(useCredentialStorageStatus.getState().error ?? "", /locked/);

    failing.delete("a");
    await queueCredentialChanges({}, {});
    assert.deepEqual(useCredentialStorageStatus.getState().failedAccounts, { b: true });
    assert.notEqual(useCredentialStorageStatus.getState().error, null);

    failing.delete("b");
    await queueCredentialChanges({}, {});
    assert.deepEqual(useCredentialStorageStatus.getState().failedAccounts, {});
    assert.equal(useCredentialStorageStatus.getState().error, null);
  });

  it("keeps a failure that no retry fixes for the rest of the session", async () => {
    reportCredentialStorageError(new Error("startup read failed"));
    failing.add("c");
    await queueCredentialChanges({}, { c: "1" });
    failing.delete("c");
    await queueCredentialChanges({}, {});
    assert.deepEqual(useCredentialStorageStatus.getState().failedAccounts, {});
    assert.notEqual(useCredentialStorageStatus.getState().error, null);
  });
});
