import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The launch after a quit that interrupted a refresh-token save: the keychain
// still holds the previous (already consumed) token and the issuer is marked
// unsaved. Must be in place before the modules load.
const ISSUER = "https://share.geolibre.app";
const ACCOUNT = `share.oauth.refreshToken.${ISSUER}`;
const MARKER = "geolibre.share.oauth.unsavedIssuers";
const keychain = new Map<string, string>([[ACCOUNT, "rt-consumed"]]);
const storage = new Map<string, string>([[MARKER, JSON.stringify([ISSUER])]]);
const requests: string[] = [];

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

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { configureShareOAuthReadiness, getShareAccessToken, useShareOAuthStore } =
  await import("../apps/geolibre-desktop/src/lib/share-oauth");
const { setShareFetch } = await import("../apps/geolibre-desktop/src/lib/share-fetch");

configureShareOAuthReadiness(Promise.resolve());
setShareFetch(async (input) => {
  requests.push(String(input));
  return new Response(null, { status: 500 });
});

describe("desktop share sign-in after an interrupted save", () => {
  it("discards the possibly consumed token and starts signed out", async () => {
    await hydrateDesktopCredentials();
    assert.equal(useShareOAuthStore.getState().issuer, null);
    assert.equal(keychain.has(ACCOUNT), false);
    assert.equal(storage.has(MARKER), false);
    assert.equal(await getShareAccessToken(), null);
    assert.deepEqual(requests, [], "the stale token is never presented to the server");
  });
});
