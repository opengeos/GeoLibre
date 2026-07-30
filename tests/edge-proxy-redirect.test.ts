import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_REDIRECT_HOPS,
  isAllowedUpstreamUrl,
  proxyViewerRequest,
  sanitizeViewerPath,
} from "../workers/viewer/src/proxy";
import {
  fetchAllowlistedUpstream,
  isAllowedTilesUpstreamUrl,
} from "../workers/tiles/src/allowlisted-fetch";

describe("viewer proxy path sanitization", () => {
  it("accepts normal asset paths and rejects traversal", () => {
    assert.equal(sanitizeViewerPath("/assets/index.js"), "/assets/index.js");
    assert.equal(sanitizeViewerPath("/"), "/");
    assert.equal(sanitizeViewerPath("/../secret"), null);
    assert.equal(sanitizeViewerPath("/foo/../../etc/passwd"), null);
    assert.equal(sanitizeViewerPath("/foo%2e%2e/bar"), null);
  });
});

describe("viewer upstream allowlist", () => {
  it("keeps fetches under https://geolibre.app/demo", () => {
    assert.equal(isAllowedUpstreamUrl("https://geolibre.app/demo"), true);
    assert.equal(isAllowedUpstreamUrl("https://geolibre.app/demo/"), true);
    assert.equal(isAllowedUpstreamUrl("https://geolibre.app/demo/assets/a.js"), true);
    assert.equal(isAllowedUpstreamUrl("https://geolibre.app/"), false);
    assert.equal(isAllowedUpstreamUrl("https://evil.example/demo"), false);
    assert.equal(isAllowedUpstreamUrl("http://geolibre.app/demo"), false);
  });
});

describe("viewer redirect policy", () => {
  it("follows an in-prefix redirect and refuses a cross-origin Location", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/demo/old")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://geolibre.app/demo/new" },
        });
      }
      if (url.endsWith("/demo/new")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };

    const ok = await proxyViewerRequest(new Request("https://web.geolibre.app/old"), fetchImpl);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "ok");
    assert.deepEqual(calls, ["https://geolibre.app/demo/old", "https://geolibre.app/demo/new"]);

    const evilFetch: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      });
    const blocked = await proxyViewerRequest(new Request("https://web.geolibre.app/"), evilFetch);
    assert.equal(blocked.status, 502);
  });

  it("rejects non-GET methods and caps redirect hops", async () => {
    const method = await proxyViewerRequest(
      new Request("https://web.geolibre.app/", { method: "POST" }),
    );
    assert.equal(method.status, 405);

    let hops = 0;
    const looping: typeof fetch = async (input) => {
      hops += 1;
      const url = String(input);
      return new Response(null, {
        status: 302,
        headers: { location: `${url}?n=${hops}` },
      });
    };
    const capped = await proxyViewerRequest(new Request("https://web.geolibre.app/loop"), looping);
    assert.equal(capped.status, 502);
    assert.equal(hops, MAX_REDIRECT_HOPS + 1);
  });
});

describe("tiles allowlisted fetch", () => {
  it("refuses off-host redirects from an allowlisted origin", async () => {
    assert.equal(isAllowedTilesUpstreamUrl("https://api.openaerialmap.org/meta"), true);
    assert.equal(isAllowedTilesUpstreamUrl("https://evil.example/meta"), false);

    const fetchImpl: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/payload" },
      });

    await assert.rejects(
      () => fetchAllowlistedUpstream("https://api.openaerialmap.org/meta", {}, fetchImpl),
      /non-allowlisted/,
    );
  });

  it("follows a same-host HTTPS redirect", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/meta")) {
        return new Response(null, {
          status: 301,
          headers: { location: "https://api.openaerialmap.org/meta/" },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const response = await fetchAllowlistedUpstream(
      "https://api.openaerialmap.org/meta",
      {},
      fetchImpl,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
  });
});
