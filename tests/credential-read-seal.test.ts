import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime with nothing saved yet. The credential store answers
// one read per page load (issue #2858), so startup hydration must make exactly
// that read, even with few or no accounts to ask for, or reads would stay open
// for external plugins. Must be in place before the modules load.
const storage = new Map<string, string>();
const invoked: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      invoked.push({ cmd, args });
      if (cmd === "secure_store_get_many") return {};
      throw new Error(`unexpected command ${cmd}`);
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
};

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { sealSecureCredentialReads, useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");
const { applyTemporaryDesktopSettings } =
  await import("../apps/geolibre-desktop/src/hooks/useDesktopSettings");

describe("one-shot credential read", () => {
  it("makes the one startup read in a session that reads no settings accounts", async () => {
    // A shared-settings session (?settings=...) reads no settings accounts.
    applyTemporaryDesktopSettings({});
    await hydrateDesktopCredentials();
    assert.equal(useCredentialStorageStatus.getState().error, null);
    assert.deepEqual(
      invoked.map(({ cmd }) => cmd),
      ["secure_store_get_many"],
    );
    const accounts = invoked[0].args?.accounts as string[];
    assert.ok(!accounts.some((account) => account.startsWith("settings.")));
  });

  it("does not ask the store to seal again once the read was made", async () => {
    await sealSecureCredentialReads();
    assert.equal(invoked.length, 1);
  });
});
