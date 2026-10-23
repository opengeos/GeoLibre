import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ArcGISAuthError,
  arcgisAuthErrorKey,
  arcgisLayerTokenProvider,
  arcgisOAuthEndpoint,
  defaultArcGISClientId,
  getArcGISAccessToken,
  normalizeArcGISPortalUrl,
  resetArcGISSessions,
  signInToArcGIS,
  signOutOfArcGIS,
} from "../apps/geolibre-desktop/src/lib/arcgis-oauth";
import {
  DESKTOP_SHARE_CALLBACK,
  NativeShareAuthReceiver,
  NO_ISSUER,
  parseNativeShareCallback,
} from "../apps/geolibre-desktop/src/lib/native-share-auth";

describe("normalizeArcGISPortalUrl", () => {
  it("treats blank as ArcGIS Online", () => {
    assert.equal(normalizeArcGISPortalUrl(""), "https://www.arcgis.com");
    assert.equal(normalizeArcGISPortalUrl(undefined), "https://www.arcgis.com");
  });

  it("strips the sharing REST suffix and trailing slashes", () => {
    assert.equal(
      normalizeArcGISPortalUrl("https://www.arcgis.com/sharing/rest"),
      "https://www.arcgis.com",
    );
    assert.equal(
      normalizeArcGISPortalUrl("https://gis.example.org/portal/sharing/rest/"),
      "https://gis.example.org/portal",
    );
    assert.equal(
      normalizeArcGISPortalUrl("https://gis.example.org/portal/?x=1#y"),
      "https://gis.example.org/portal",
    );
  });

  it("rejects non-https, credentials and garbage", () => {
    assert.equal(normalizeArcGISPortalUrl("http://gis.example.org/portal"), null);
    assert.equal(normalizeArcGISPortalUrl("https://user:pw@gis.example.org"), null);
    assert.equal(normalizeArcGISPortalUrl("not a url"), null);
  });
});

describe("arcgisOAuthEndpoint", () => {
  it("keeps every endpoint on ArcGIS Online and Enterprise portals", () => {
    for (const portal of ["https://www.arcgis.com", "https://gis.example.org/portal"]) {
      for (const endpoint of ["authorize", "token", "revokeToken"] as const) {
        assert.equal(
          arcgisOAuthEndpoint(portal, endpoint).href,
          `${portal}/sharing/rest/oauth2/${endpoint}`,
        );
      }
    }
  });

  it("sends an organization's token calls to www.arcgis.com, which allows CORS", () => {
    const org = "https://myorg.maps.arcgis.com";
    assert.equal(
      arcgisOAuthEndpoint(org, "authorize").href,
      `${org}/sharing/rest/oauth2/authorize`,
    );
    assert.equal(
      arcgisOAuthEndpoint(org, "token").href,
      "https://www.arcgis.com/sharing/rest/oauth2/token",
    );
    assert.equal(
      arcgisOAuthEndpoint(org, "revokeToken").href,
      "https://www.arcgis.com/sharing/rest/oauth2/revokeToken",
    );
  });
});

describe("defaultArcGISClientId", () => {
  const env = { VITE_ARCGIS_OAUTH_CLIENT_ID: " default-id " };

  it("applies to ArcGIS Online and its organization URLs", () => {
    assert.equal(defaultArcGISClientId("https://www.arcgis.com", env), "default-id");
    assert.equal(defaultArcGISClientId("https://myorg.maps.arcgis.com", env), "default-id");
  });

  it("never applies to an Enterprise portal, and is blank when unset", () => {
    assert.equal(defaultArcGISClientId("https://gis.example.org/portal", env), "");
    assert.equal(defaultArcGISClientId("https://www.arcgis.com", {}), "");
  });
});

describe("desktop callback without iss", () => {
  const state = "state-1";
  const callback = `${DESKTOP_SHARE_CALLBACK}?code=abc&state=${state}`;

  it("is rejected by default and accepted when no issuer is expected", () => {
    assert.equal(parseNativeShareCallback(callback), null);
    assert.deepEqual(parseNativeShareCallback(callback, false), {
      code: "abc",
      state,
      issuer: NO_ISSUER,
    });
    assert.equal(parseNativeShareCallback(`${callback}&iss=x`, false), null);
  });

  it("resolves a pending NO_ISSUER flow", async () => {
    const receiver = new NativeShareAuthReceiver(() => {});
    const pending = receiver.waitForCode(state, NO_ISSUER, 300_000);
    assert.equal(receiver.accept(callback), true);
    assert.equal(await pending.code, "abc");
  });

  it("still requires iss for a share flow", () => {
    const receiver = new NativeShareAuthReceiver(() => {});
    const pending = receiver.waitForCode(state, "https://share.geolibre.app", 300_000);
    void pending.code.catch(() => {});
    assert.equal(receiver.accept(callback), true);
    return assert.rejects(pending.code);
  });
});

describe("ArcGIS sign-in session", () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  const realFetch = globalThis.fetch;
  let requests: URLSearchParams[] = [];
  let tokenBodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    requests = [];
    const listeners: Array<(e: unknown) => void> = [];
    const popup = {
      closed: false,
      location: {
        set href(value: string) {
          const state = new URL(value).searchParams.get("state");
          queueMicrotask(() =>
            listeners.forEach((l) =>
              l({
                origin: "https://app.test",
                source: popup,
                data: { type: "geolibre-share-oauth", code: "the-code", state },
              }),
            ),
          );
        },
      },
      close() {},
    };
    (globalThis as { window?: unknown }).window = {
      location: { origin: "https://app.test", href: "https://app.test/" },
      crypto: globalThis.crypto,
      open: () => popup,
      addEventListener: (_: string, l: (e: unknown) => void) => listeners.push(l),
      removeEventListener: () => {},
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    };
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(new URLSearchParams(init?.body as URLSearchParams));
      const body = tokenBodies.shift() ?? {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    resetArcGISSessions();
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = realWindow;
    globalThis.fetch = realFetch;
    resetArcGISSessions();
  });

  it("exchanges the code with the verifier, then reuses the token", async () => {
    tokenBodies = [
      { access_token: "at-1", refresh_token: "rt-1", expires_in: 1800, username: "ada" },
    ];
    const info = await signInToArcGIS({ portalUrl: "", clientId: " cid " });
    assert.deepEqual(info, { portal: "https://www.arcgis.com", username: "ada" });
    assert.equal(requests[0].get("grant_type"), "authorization_code");
    assert.equal(requests[0].get("client_id"), "cid");
    assert.equal(requests[0].get("code"), "the-code");
    assert.ok((requests[0].get("code_verifier") ?? "").length >= 43);
    assert.equal(await getArcGISAccessToken(""), "at-1");
    assert.equal(requests.length, 1);
  });

  it("renews an expiring token from the refresh token", async () => {
    tokenBodies = [
      { access_token: "at-1", refresh_token: "rt-1", expires_in: 1, username: "ada" },
      { access_token: "at-2", expires_in: 1800 },
    ];
    await signInToArcGIS({ portalUrl: "", clientId: "cid" });
    assert.equal(await getArcGISAccessToken(""), "at-2");
    assert.equal(requests[1].get("grant_type"), "refresh_token");
    assert.equal(requests[1].get("refresh_token"), "rt-1");
  });

  it("drops the session when renewal fails", async () => {
    tokenBodies = [
      { access_token: "at-1", refresh_token: "rt-1", expires_in: 1, username: "ada" },
      { error: { code: 400, message: "invalid refresh token" } },
    ];
    await signInToArcGIS({ portalUrl: "", clientId: "cid" });
    await assert.rejects(
      getArcGISAccessToken(""),
      (e) => e instanceof ArcGISAuthError && e.code === "session-expired",
    );
    await assert.rejects(
      getArcGISAccessToken(""),
      (e) => e instanceof ArcGISAuthError && e.code === "not-signed-in",
    );
  });

  it("keeps the session through a transient refresh failure", async () => {
    tokenBodies = [{ access_token: "at-1", refresh_token: "rt-1", expires_in: 1, username: "ada" }];
    await signInToArcGIS({ portalUrl: "", clientId: "cid" });
    const okFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    await assert.rejects(
      getArcGISAccessToken(""),
      (e) => e instanceof ArcGISAuthError && e.code === "network-error",
    );
    globalThis.fetch = okFetch;
    tokenBodies = [{ access_token: "at-2", expires_in: 1800 }];
    assert.equal(await getArcGISAccessToken(""), "at-2");
  });

  it("signs out and revokes the refresh token", async () => {
    tokenBodies = [{ access_token: "at-1", refresh_token: "rt-1", expires_in: 1800 }];
    await signInToArcGIS({ portalUrl: "", clientId: "cid" });
    await signOutOfArcGIS("");
    assert.equal(requests[1].get("auth_token"), "rt-1");
    await assert.rejects(getArcGISAccessToken(""), ArcGISAuthError);
  });

  it("refuses an ArcGIS error body at code exchange", async () => {
    tokenBodies = [{ error: { code: 400, message: "bad" } }];
    await assert.rejects(
      signInToArcGIS({ portalUrl: "", clientId: "cid" }),
      (e) => e instanceof ArcGISAuthError && e.code === "exchange-failed",
    );
  });

  it("needs a client ID and a valid portal", async () => {
    await assert.rejects(signInToArcGIS({ portalUrl: "", clientId: " " }), ArcGISAuthError);
    await assert.rejects(
      signInToArcGIS({ portalUrl: "http://x.test", clientId: "c" }),
      ArcGISAuthError,
    );
  });
});

describe("arcgisAuthErrorKey", () => {
  it("words specific failures and falls back for the rest", () => {
    assert.equal(
      arcgisAuthErrorKey(new ArcGISAuthError("popup-blocked")),
      "addData.arcgis.signInErrorPopup",
    );
    assert.equal(
      arcgisAuthErrorKey(new ArcGISAuthError("session-expired")),
      "addData.arcgis.signInErrorExpired",
    );
    assert.equal(
      arcgisAuthErrorKey(new ArcGISAuthError("exchange-failed")),
      "addData.arcgis.signInError",
    );
    assert.equal(arcgisAuthErrorKey(new Error("x")), null);
  });
});

describe("arcgisLayerTokenProvider", () => {
  it("resolves undefined when signed out", async () => {
    const provide = arcgisLayerTokenProvider("https://gis.example.org/portal", (key) => key);
    assert.equal(await provide(), undefined);
  });
});
