import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resetShareFetch, setShareFetch } from "../apps/geolibre-desktop/src/lib/share-fetch";
import {
  getShareAccessToken,
  signInToShare,
  signOutOfShare,
  useShareOAuthStore,
} from "../apps/geolibre-desktop/src/lib/share-oauth";
import {
  authorizeShareSessionManagement,
  closeShareSessionManagement,
  listShareSessions,
  revokeShareSession,
  SessionManagementError,
} from "../apps/geolibre-desktop/src/lib/share-session-management";

describe("session management revocation", () => {
  it("keeps a project session signed in when its revoke request fails", async () => {
    const issuer = "https://share.geolibre.app";
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const storage = new Map<string, string>();
    const popup = {
      closed: false,
      location: { href: "about:blank" },
      close() {
        this.closed = true;
      },
    };
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    let messageReady = Promise.withResolvers<void>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "https://app.example" },
        crypto,
        open: () => {
          popup.closed = false;
          return popup;
        },
        sessionStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
        addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
          messageHandler = listener;
          messageReady.resolve();
        },
        removeEventListener: () => {},
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: () => 1,
        clearInterval: () => {},
      },
    });
    let exchanges = 0;
    setShareFetch(async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/oauth/token") {
        exchanges += 1;
        return Response.json(
          exchanges === 1
            ? { access_token: "project-access", refresh_token: "project-refresh", expires_in: 600 }
            : { access_token: "manager-access", expires_in: 300 },
        );
      }
      if (url.pathname === "/api/users/me") {
        const token = new Headers(init?.headers).get("Authorization");
        assert.ok(token === "Bearer project-access" || token === "Bearer manager-access");
        return Response.json({
          user: { id: "same-account", username: "ada", email: null },
          sessionId: token === "Bearer project-access" ? "current-project" : "manager-session",
          scopes: token === "Bearer project-access" ? ["read:projects"] : ["manage:sessions"],
        });
      }
      if (url.pathname === "/api/auth/sessions/current-project" && init?.method === "DELETE") {
        return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      }
      if (url.pathname === "/api/auth/sessions") {
        return Response.json({ sessions: [], limit: 50, offset: 0, total: 0 });
      }
      if (url.pathname === "/oauth/revoke") return Response.json({});
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    async function consent<T>(start: () => Promise<T>): Promise<T> {
      const pending = start();
      await messageReady.promise;
      const handler = messageHandler;
      assert.ok(handler);
      messageReady = Promise.withResolvers<void>();
      handler({
        origin: "https://app.example",
        source: popup,
        data: {
          type: "geolibre-share-oauth",
          code: "one-time-code",
          state: new URL(popup.location.href).searchParams.get("state"),
          iss: issuer,
        },
      } as unknown as MessageEvent);
      return pending;
    }

    try {
      await consent(() => signInToShare(issuer));
      await consent(() => authorizeShareSessionManagement());
      await assert.rejects(
        revokeShareSession("current-project"),
        (error: unknown) =>
          error instanceof SessionManagementError && error.code === "request-failed",
      );
      assert.equal(useShareOAuthStore.getState().issuer, issuer);
      assert.equal(await getShareAccessToken(issuer), "project-access");
      assert.equal((await listShareSessions()).total, 0);
    } finally {
      await closeShareSessionManagement();
      await signOutOfShare(issuer);
      resetShareFetch();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
