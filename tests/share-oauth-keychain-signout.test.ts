import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop runtime with a restored sign-in whose keychain delete fails at
// sign-out. Must be in place before the modules load, so they are imported
// dynamically below.
const ISSUER = "https://share.geolibre.app";
const ACCOUNT = `share.oauth.refreshToken.${ISSUER}`;
const keychain = new Map<string, string>([[ACCOUNT, "rt-live"]]);
const storage = new Map<string, string>();
let deleteFails = true;

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
      if (cmd === "secure_store_delete") {
        if (deleteFails) throw new Error("Platform secure storage failure");
        keychain.delete(args.account as string);
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  },
  location: { href: "tauri://localhost/", origin: "tauri://localhost" },
  setTimeout,
  clearTimeout,
  dispatchEvent: () => true,
  addEventListener: () => {},
};
console.error = () => {};

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { ShareOAuthError, configureShareOAuthReadiness, signOutOfShare, useShareOAuthStore } =
  await import("../apps/geolibre-desktop/src/lib/share-oauth");
const { setShareFetch } = await import("../apps/geolibre-desktop/src/lib/share-fetch");
const { queueCredentialChanges, useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

configureShareOAuthReadiness(Promise.resolve());
const revoked: string[] = [];
setShareFetch(async (input, init) => {
  if (String(input).endsWith("/oauth/revoke")) {
    revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
  }
  return new Response(null, { status: 200 });
});

describe("desktop sign-out when the keychain delete fails", () => {
  it("revokes, signs out locally, and reports that the token is still stored", async () => {
    await hydrateDesktopCredentials();
    assert.equal(useShareOAuthStore.getState().issuer, ISSUER);

    await assert.rejects(
      signOutOfShare(),
      (error: unknown) => error instanceof ShareOAuthError && error.code === "sign-out-incomplete",
    );
    assert.deepEqual(revoked, ["rt-live"], "the revoke is sent even though the delete failed");
    assert.equal(useShareOAuthStore.getState().issuer, null);
    assert.equal(keychain.get(ACCOUNT), "rt-live");
    assert.equal(useCredentialStorageStatus.getState().failedAccounts[ACCOUNT], true);

    deleteFails = false;
    await queueCredentialChanges({}, {});
    assert.equal(keychain.has(ACCOUNT), false);
    assert.equal(storage.has("geolibre.share.oauth.unsavedIssuers"), false);
  });
});
