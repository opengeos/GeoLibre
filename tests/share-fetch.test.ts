import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getShareFetch,
  resetShareFetch,
  setShareFetch,
} from "../apps/geolibre-desktop/src/lib/share-fetch";
import { uploadProjectToShare } from "../apps/geolibre-desktop/src/lib/share-geolibre";
import {
  fetchMyProjects,
  fetchSharedProjects,
} from "../apps/geolibre-desktop/src/lib/share-gallery";

// A minimal JSON Response for a share endpoint.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("share fetch override", () => {
  afterEach(() => resetShareFetch());

  it("defaults to the global fetch and is overridable + resettable", async () => {
    const original = globalThis.fetch;
    try {
      let calledDefault = 0;
      globalThis.fetch = (() => {
        calledDefault += 1;
        return Promise.resolve(new Response("ok"));
      }) as typeof fetch;

      // Default share fetch delegates to whatever globalThis.fetch is.
      await getShareFetch()("https://example.com/");
      assert.equal(calledDefault, 1);

      // Override wins.
      let calledOverride = 0;
      setShareFetch((() => {
        calledOverride += 1;
        return Promise.resolve(new Response("ok"));
      }) as typeof fetch);
      await getShareFetch()("https://example.com/");
      assert.equal(calledOverride, 1);
      assert.equal(calledDefault, 1);

      // Reset restores the default (global fetch) path.
      resetShareFetch();
      await getShareFetch()("https://example.com/");
      assert.equal(calledDefault, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  // Regression guard for the desktop CORS fix: the share client functions must
  // route through the installed share fetch when no fetchImpl is passed, so the
  // desktop build's native (CORS-exempt) fetch actually gets used.
  it("uploadProjectToShare uses the installed share fetch", async () => {
    let seen: string | null = null;
    setShareFetch(((input: RequestInfo | URL) => {
      seen = typeof input === "string" ? input : input.toString();
      return Promise.resolve(
        jsonResponse({
          project: {
            projectUrl: "https://share.geolibre.app/u/p",
            rawJsonUrl: "https://share.geolibre.app/u/p.geolibre.json",
          },
        }),
      );
    }) as typeof fetch);

    await uploadProjectToShare({
      token: "tok",
      filename: "p.geolibre.json",
      content: "{}",
      visibility: "public",
    });
    assert.equal(seen, "https://share.geolibre.app/api/projects");
  });

  it("fetchSharedProjects uses the installed share fetch", async () => {
    let seen: string | null = null;
    setShareFetch(((input: RequestInfo | URL) => {
      seen = typeof input === "string" ? input : input.toString();
      return Promise.resolve(jsonResponse({ projects: [] }));
    }) as typeof fetch);

    await fetchSharedProjects();
    assert.equal(seen, "https://share.geolibre.app/api/projects");
  });

  it("fetchMyProjects uses the installed share fetch (with auth)", async () => {
    const seen: string[] = [];
    let auth: string | null = null;
    setShareFetch(((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push(url);
      auth = new Headers(init?.headers).get("Authorization");
      if (url.endsWith("/api/users/me")) {
        return Promise.resolve(jsonResponse({ user: { username: "giswqs" } }));
      }
      return Promise.resolve(jsonResponse({ projects: [] }));
    }) as typeof fetch);

    await fetchMyProjects({ token: "tok" });
    assert.deepEqual(seen, [
      "https://share.geolibre.app/api/users/me",
      "https://share.geolibre.app/api/users/giswqs/projects",
    ]);
    // The share-host request carries the bearer token via shareAuthorizedFetch.
    assert.equal(auth, "Bearer tok");
  });
});
