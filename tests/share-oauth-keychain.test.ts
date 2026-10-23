import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime with an in-memory keychain whose writes can be made
// to fail or to stay in flight. Must be in place before the modules load, so
// they are imported dynamically below.
const ISSUER = "https://share.geolibre.app";
const ACCOUNT = `share.oauth.refreshToken.${ISSUER}`;
const MARKER = "geolibre.share.oauth.unsavedIssuers";
const keychain = new Map<string, string>([[ACCOUNT, "rt-0"]]);
const storage = new Map<string, string>();

let setMode: "ok" | "fail" | "hold" = "ok";
// In "hold" mode a write signals `writeStarted` and waits for `release`.
const writeStarted = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let markerWritable = true;
// When set, the next delete signals `started` and waits for `release`.
let deleteHold: {
  started: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
} | null = null;

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === MARKER && !markerWritable) throw new Error("QuotaExceededError");
      storage.set(key, value);
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
        if (setMode === "fail") throw new Error("Platform secure storage failure");
        if (setMode === "hold") {
          writeStarted.resolve();
          await release.promise;
        }
        keychain.set(args.account as string, args.secret as string);
        return null;
      }
      if (cmd === "secure_store_delete") {
        const held = deleteHold;
        deleteHold = null;
        if (held) {
          held.started.resolve();
          await held.release.promise;
        }
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
const { configureShareOAuthReadiness, getShareAccessToken, signOutOfShare, useShareOAuthStore } =
  await import("../apps/geolibre-desktop/src/lib/share-oauth");
const { setShareFetch } = await import("../apps/geolibre-desktop/src/lib/share-fetch");
const { queueCredentialChanges, useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

configureShareOAuthReadiness(Promise.resolve());
// Every refresh rotates: rt-0 → rt-1 → rt-2 …; access tokens expire inside
// the refresh buffer so each getShareAccessToken() call refreshes.
const presented: string[] = [];
const revoked: string[] = [];
setShareFetch(async (input, init) => {
  const body = new URLSearchParams(String(init?.body));
  if (String(input).endsWith("/oauth/token")) {
    presented.push(body.get("refresh_token") ?? "");
    const n = presented.length;
    return Response.json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 1 });
  }
  if (String(input).endsWith("/oauth/revoke")) revoked.push(body.get("token") ?? "");
  return new Response(null, { status: 200 });
});

const marker = () => JSON.parse(storage.get(MARKER) ?? "[]") as string[];
const settled = () => queueCredentialChanges({}, {});

describe("desktop share sign-in in the OS keychain", () => {
  it("restores a saved sign-in at startup", async () => {
    await hydrateDesktopCredentials();
    assert.equal(useShareOAuthStore.getState().issuer, ISSUER);
  });

  it("marks the issuer unsaved while a rotated token is being written", async () => {
    setMode = "hold";
    try {
      assert.equal(await getShareAccessToken(), "at-1");
      assert.deepEqual(presented, ["rt-0"]);
      await writeStarted.promise;
      // Quitting now would leave the consumed rt-0 stored, but marked unsaved.
      assert.equal(keychain.get(ACCOUNT), "rt-0");
      assert.deepEqual(marker(), [ISSUER]);
    } finally {
      setMode = "ok";
      release.resolve();
    }
    await settled();
    assert.equal(keychain.get(ACCOUNT), "rt-1");
    assert.deepEqual(marker(), []);
  });

  it("keeps the issuer unsaved after a failed write until a retry succeeds", async () => {
    setMode = "fail";
    assert.equal(await getShareAccessToken(), "at-2");
    await settled();
    assert.equal(keychain.get(ACCOUNT), "rt-1");
    assert.deepEqual(marker(), [ISSUER]);
    assert.equal(useCredentialStorageStatus.getState().failedAccounts[ACCOUNT], true);

    setMode = "ok";
    await settled();
    assert.equal(keychain.get(ACCOUNT), "rt-2");
    assert.deepEqual(marker(), []);
    assert.equal(useCredentialStorageStatus.getState().failedAccounts[ACCOUNT], undefined);
  });

  it("deletes the stored token and stays in memory when the marker cannot be written", async () => {
    markerWritable = false;
    assert.equal(await getShareAccessToken(), "at-3");
    await settled();
    assert.equal(keychain.has(ACCOUNT), false);
    assert.equal(useShareOAuthStore.getState().desktopSessionOnly, true);
    assert.equal(useShareOAuthStore.getState().issuer, ISSUER);

    markerWritable = true;
    assert.equal(await getShareAccessToken(), "at-4");
    await settled();
    assert.equal(keychain.get(ACCOUNT), "rt-4");
    assert.equal(useShareOAuthStore.getState().desktopSessionOnly, false);
  });

  it("waits for the keychain delete on sign-out, even without a marker, and still revokes", async () => {
    markerWritable = false;
    const hold = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    deleteHold = hold;
    let done = false;
    const signOut = signOutOfShare().then(() => (done = true));
    try {
      await hold.started.promise;
      assert.equal(done, false, "sign-out must not finish before the delete");
      assert.equal(useShareOAuthStore.getState().issuer, ISSUER, "not reported signed out yet");
      assert.equal(keychain.get(ACCOUNT), "rt-4");
      assert.deepEqual(revoked, ["rt-4"], "the revoke does not wait for the delete");
    } finally {
      hold.release.resolve();
      markerWritable = true;
    }
    await signOut;
    assert.equal(useShareOAuthStore.getState().issuer, null);
    assert.equal(keychain.has(ACCOUNT), false);
    assert.ok(![...storage.values()].some((value) => value.includes("rt-")));
  });
});
