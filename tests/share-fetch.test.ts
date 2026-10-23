import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createEmptyProject, serializeProject } from "@geolibre/core";
import {
  createNativeShareFetch,
  getShareFetch,
  requestOrigin,
  resetShareFetch,
  setShareFetch,
} from "../apps/geolibre-desktop/src/lib/share-fetch";
import { uploadProjectToShare } from "../apps/geolibre-desktop/src/lib/share-geolibre";
import {
  fetchMyProjects,
  fetchSharedProjects,
  shareAuthorizedFetch,
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
      }) as unknown as typeof fetch;

      // Default share fetch delegates to whatever globalThis.fetch is.
      await getShareFetch()("https://example.com/");
      assert.equal(calledDefault, 1);

      // Override wins.
      let calledOverride = 0;
      setShareFetch((() => {
        calledOverride += 1;
        return Promise.resolve(new Response("ok"));
      }) as unknown as typeof fetch);
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
    }) as unknown as typeof fetch);

    await uploadProjectToShare({
      token: "tok",
      filename: "p.geolibre.json",
      content: serializeProject(createEmptyProject("Share fetch")),
      visibility: "public",
    });
    assert.equal(seen, "https://share.geolibre.app/api/projects");
  });

  it("fetchSharedProjects uses the installed share fetch", async () => {
    let seen: string | null = null;
    setShareFetch(((input: RequestInfo | URL) => {
      seen = typeof input === "string" ? input : input.toString();
      return Promise.resolve(jsonResponse({ projects: [] }));
    }) as unknown as typeof fetch);

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
      if (url.includes("/api/users/me")) {
        return Promise.resolve(jsonResponse({ user: { username: "giswqs" } }));
      }
      return Promise.resolve(jsonResponse({ projects: [] }));
    }) as unknown as typeof fetch);

    await fetchMyProjects({ token: "tok" });
    assert.deepEqual(seen, [
      "https://share.geolibre.app/api/users/me",
      "https://share.geolibre.app/api/users/giswqs/projects?limit=100&offset=0",
    ]);
    // The share-host request carries the bearer token via shareAuthorizedFetch.
    assert.equal(auth, "Bearer tok");
  });
});

// installNativeShareFetch scopes the CORS-exempt native client by comparing
// these origins. Matching on host alone would let a plaintext request to a host
// configured over HTTPS through, so the scheme has to be part of the comparison.
describe("requestOrigin", () => {
  it("distinguishes schemes on the same host", () => {
    assert.equal(
      requestOrigin("https://maps.example.org/api/projects"),
      "https://maps.example.org",
    );
    assert.equal(requestOrigin("http://maps.example.org/api/projects"), "http://maps.example.org");
    assert.notEqual(
      requestOrigin("http://maps.example.org/api/projects"),
      requestOrigin("https://maps.example.org"),
    );
  });

  it("keeps a non-default port distinct", () => {
    assert.equal(requestOrigin("https://maps.example.org:8443/x"), "https://maps.example.org:8443");
    assert.notEqual(
      requestOrigin("https://maps.example.org:8443/x"),
      requestOrigin("https://maps.example.org/x"),
    );
  });

  it("accepts the Request and URL input shapes", () => {
    assert.equal(requestOrigin(new URL("https://maps.example.org/a")), "https://maps.example.org");
    assert.equal(
      requestOrigin(new Request("https://maps.example.org/a")),
      "https://maps.example.org",
    );
  });

  it("returns null for values that have no real origin", () => {
    assert.equal(requestOrigin("not a url"), null);
    assert.equal(requestOrigin("mailto:someone@example.org"), null);
  });
});

describe("native share transport", () => {
  it("uses native HTTP only for the shipped HTTPS origin, and never retries self-host CORS failures", async () => {
    const nativeUrls: string[] = [];
    const browserUrls: string[] = [];
    const native = (async (input: RequestInfo | URL) => {
      nativeUrls.push(input instanceof Request ? input.url : String(input));
      return new Response("native");
    }) as Parameters<typeof createNativeShareFetch>[0];
    const browser = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      browserUrls.push(url);
      if (url.includes("self-hosted.example")) throw new TypeError("CORS denied");
      return new Response("browser");
    }) as typeof fetch;
    const shareFetch = createNativeShareFetch(native, browser);

    assert.equal(
      await (await shareFetch("https://share.geolibre.app/api/projects")).text(),
      "native",
    );
    assert.equal(
      await (await shareFetch(new Request("https://share.geolibre.app/api/users/me"))).text(),
      "native",
    );
    assert.equal(
      await (await shareFetch(new URL("https://share.geolibre.app/api/projects"))).text(),
      "native",
    );
    assert.equal(
      await (await shareFetch("http://share.geolibre.app/api/projects")).text(),
      "browser",
    );
    assert.equal(
      await (await shareFetch("https://share.geolibre.app:8443/api/projects")).text(),
      "browser",
    );
    assert.equal(await (await shareFetch("https://tiles.example.com/xyz")).text(), "browser");
    await assert.rejects(shareFetch("https://self-hosted.example/api/projects"), /CORS denied/);
    assert.equal(nativeUrls.length, 3);
    assert.equal(browserUrls.length, 4);
  });

  it("disables native redirects for credentials and rejects 3xx instead of exposing a redirect target", async () => {
    const redirected: string[] = [];
    const options: Array<(RequestInit & { maxRedirections?: number }) | undefined> = [];
    const native = (async (
      input: RequestInfo | URL,
      init?: RequestInit & { maxRedirections?: number },
    ) => {
      options.push(init);
      if (init?.maxRedirections === 0) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/collect" },
        });
      }
      redirected.push("https://attacker.example/collect");
      return new Response("followed");
    }) as Parameters<typeof createNativeShareFetch>[0];
    const shareFetch = createNativeShareFetch(native);
    const authed = shareAuthorizedFetch("private", "https://share.geolibre.app", shareFetch);

    await assert.rejects(authed("https://share.geolibre.app/api/users/me"), /Redirect refused/);
    await assert.rejects(
      shareFetch(
        new Request("https://share.geolibre.app/private", {
          headers: { Authorization: "Bearer private" },
        }),
      ),
      /Redirect refused/,
    );
    await assert.rejects(
      shareFetch("https://share.geolibre.app/api/projects", {
        method: "POST",
        headers: { Authorization: "Bearer private" },
      }),
      /Redirect refused/,
    );
    assert.equal(options[0]?.maxRedirections, 0);
    assert.equal(options[0]?.redirect, "error");
    assert.equal(options[1]?.maxRedirections, 0);
    assert.equal(options[2]?.maxRedirections, 0);
    assert.deepEqual(redirected, []);

    assert.equal(
      await (await shareFetch("https://share.geolibre.app/api/projects")).text(),
      "followed",
    );
    assert.equal(options[3]?.maxRedirections, undefined);
    assert.deepEqual(redirected, ["https://attacker.example/collect"]);
  });
});
