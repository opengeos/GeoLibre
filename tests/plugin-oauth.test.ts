import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  authorizeInPopup,
  getPluginOAuthRedirectUri,
  PluginOAuthError,
} from "../apps/geolibre-desktop/src/lib/plugin-oauth";

const APP_ORIGIN = "https://app.test";
const REDIRECT_URI = `${APP_ORIGIN}/oauth-callback.html`;

/** What the fake provider sends back once the popup is navigated to it. */
type Callback = { code?: string; state?: string; error?: string } | "close";

function authorizationUrl(params: Record<string, string>): string {
  const url = new URL("https://records.example.org/o/authorize/");
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

describe("plugin OAuth popup sign-in", () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  let respond: (requestState: string | null) => Callback;
  let popupOpened: boolean;
  let popupClosed: boolean;
  let blockPopup: boolean;

  beforeEach(() => {
    respond = (requestState) => ({ code: "the-code", state: requestState ?? undefined });
    popupOpened = false;
    popupClosed = false;
    blockPopup = false;
    const listeners: Array<(event: unknown) => void> = [];
    const popup = {
      closed: false,
      location: {
        set href(value: string) {
          const callback = respond(new URL(value).searchParams.get("state"));
          queueMicrotask(() => {
            if (callback === "close") {
              popup.closed = true;
              return;
            }
            for (const listener of listeners) {
              listener({
                origin: APP_ORIGIN,
                source: popup,
                data: { type: "geolibre-share-oauth", ...callback },
              });
            }
          });
        },
      },
      close() {
        popupClosed = true;
      },
    };
    (globalThis as { window?: unknown }).window = {
      location: { origin: APP_ORIGIN, href: `${APP_ORIGIN}/` },
      open: () => {
        if (blockPopup) return null;
        popupOpened = true;
        return popup;
      },
      addEventListener: (_: string, listener: (event: unknown) => void) => listeners.push(listener),
      removeEventListener: () => {},
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = realWindow;
  });

  async function rejection(promise: Promise<unknown>): Promise<string> {
    const error = await promise.then(
      () => assert.fail("expected the sign-in to fail"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof PluginOAuthError);
    return error.reason;
  }

  it("uses the app's callback page as the redirect URI on the web", () => {
    assert.equal(getPluginOAuthRedirectUri(), REDIRECT_URI);
  });

  it("resolves with the code once the callback's state matches", async () => {
    const code = await authorizeInPopup(
      authorizationUrl({ state: "s1", redirect_uri: REDIRECT_URI, response_type: "code" }),
    );
    assert.equal(code, "the-code");
  });

  it("refuses an invalid request without opening a popup", async () => {
    assert.equal(
      await rejection(authorizeInPopup(authorizationUrl({ redirect_uri: REDIRECT_URI }))),
      "invalid-request",
    );
    const request = authorizationUrl({ state: "s1", redirect_uri: REDIRECT_URI });
    for (const timeoutMs of [Number.NaN, -1, 0, 2 ** 31]) {
      assert.equal(await rejection(authorizeInPopup(request, { timeoutMs })), "invalid-request");
    }
    assert.equal(popupOpened, false);
    assert.equal(
      await rejection(
        authorizeInPopup(
          authorizationUrl({ state: "s1", redirect_uri: "https://evil.example/callback" }),
        ),
      ),
      "invalid-request",
    );
  });

  it("reports a blocked popup", async () => {
    blockPopup = true;
    assert.equal(
      await rejection(
        authorizeInPopup(authorizationUrl({ state: "s1", redirect_uri: REDIRECT_URI })),
      ),
      "popup-blocked",
    );
    assert.equal(popupOpened, false);
  });

  it("rejects a callback for another flow, a denial, and a closed popup, closing its popup", async () => {
    const request = authorizationUrl({ state: "s1", redirect_uri: REDIRECT_URI });
    respond = () => ({ code: "foreign-code", state: "someone-else" });
    assert.equal(await rejection(authorizeInPopup(request)), "invalid-callback");
    assert.equal(popupClosed, true, "a failed sign-in closes its popup");
    respond = (requestState) => ({ error: "access_denied", state: requestState ?? undefined });
    assert.equal(await rejection(authorizeInPopup(request)), "access-denied");
    respond = () => "close";
    assert.equal(await rejection(authorizeInPopup(request)), "cancelled");
  });

  it("refuses a second sign-in without touching the first one's popup", async () => {
    let opened = 0;
    const realOpen = (window as unknown as { open: () => unknown }).open;
    (window as unknown as { open: () => unknown }).open = () => {
      opened += 1;
      return realOpen();
    };
    const request = authorizationUrl({ state: "s1", redirect_uri: REDIRECT_URI });
    const first = authorizeInPopup(request);
    assert.equal(await rejection(authorizeInPopup(request)), "already-pending");
    assert.equal(await first, "the-code");
    assert.equal(opened, 1);
    assert.equal(popupClosed, false);
  });
});
