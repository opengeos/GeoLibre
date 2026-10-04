import assert from "node:assert/strict";
import { describe, it } from "node:test";

// A failed startup read may never have reached the native command (an IPC
// transport error), so it must not stand in for the seal: the backstop before
// an external plugin loads still has to close reads (issue #2858).
const invoked: string[] = [];

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string) => {
      invoked.push(cmd);
      if (cmd === "secure_store_get_many") throw new Error("IPC transport failed");
      if (cmd === "secure_store_seal") return null;
      throw new Error(`unexpected command ${cmd}`);
    },
  },
};

const { readSecureCredentials, sealSecureCredentialReads } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

describe("credential read seal after a failed read", () => {
  it("still seals reads explicitly when the one read failed", async () => {
    await assert.rejects(readSecureCredentials(["share.refresh"]), /IPC transport failed/);
    await sealSecureCredentialReads();
    assert.deepEqual(invoked, ["secure_store_get_many", "secure_store_seal"]);
  });

  it("does not seal again once the seal succeeded", async () => {
    await sealSecureCredentialReads();
    assert.deepEqual(invoked, ["secure_store_get_many", "secure_store_seal"]);
  });
});
