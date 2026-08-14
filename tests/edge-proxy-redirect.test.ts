import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_REDIRECT_HOPS,
  isAllowedUpstreamUrl,
  proxyViewerRequest,
  sanitizeViewerPath,
} from "../workers/viewer/src/proxy";
import {
  TILES_MAX_REDIRECT_HOPS,
  fetchAllowlistedUpstream,
  isAllowedTilesUpstreamUrl,
} from "../workers/tiles/src/allowlisted-fetch";
import {
  assertPublicHttpUrl,
  assertResolvedPublicHost,
  fetchWithGuard,
  guardedLookup,
  PROXY_MAX_BODY_BYTES,
  PROXY_MAX_REDIRECT_HOPS,
  readBodyWithLimit,
  validatePublicUrl,
} from "../apps/geolibre-desktop/vite-proxy-guard";

describe("viewer proxy path sanitization", () => {
  it("accepts normal asset paths and rejects traversal", () => {
    assert.equal(sanitizeViewerPath("/assets/index.js"), "/assets/index.js");
    assert.equal(sanitizeViewerPath("/"), "/");
    assert.equal(sanitizeViewerPath("/../secret"), null);
    assert.equal(sanitizeViewerPath("/foo/../../etc/passwd"), null);
    assert.equal(sanitizeViewerPath("/foo%2e%2e/bar"), null);
    assert.equal(sanitizeViewerPath("/foo%2f..%2fsecret"), null);
    assert.equal(sanitizeViewerPath("/foo%2F..%2Fsecret"), null);
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
    assert.equal(isAllowedUpstreamUrl("https://geolibre.app:8443/demo/assets/a.js"), false);
  });
});

describe("viewer redirect policy", () => {
  it("follows an in-prefix redirect, strips cookies, and refuses cross-origin", async () => {
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
        return new Response("ok", {
          status: 200,
          headers: {
            "set-cookie": "session=evil",
            "set-cookie2": "also=evil",
            "content-type": "text/plain",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const ok = await proxyViewerRequest(new Request("https://web.geolibre.app/old"), fetchImpl);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "ok");
    assert.equal(ok.headers.get("set-cookie"), null);
    assert.equal(ok.headers.get("set-cookie2"), null);
    assert.deepEqual(calls, ["https://geolibre.app/demo/old", "https://geolibre.app/demo/new"]);

    const evilFetch: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      });
    const blocked = await proxyViewerRequest(new Request("https://web.geolibre.app/"), evilFetch);
    assert.equal(blocked.status, 502);
  });

  it("passes through 304 Not Modified instead of treating it as a broken redirect", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, {
        status: 304,
        headers: { etag: '"abc"' },
      });
    const response = await proxyViewerRequest(
      new Request("https://web.geolibre.app/assets/app.js", {
        headers: { "if-none-match": '"abc"' },
      }),
      fetchImpl,
    );
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("etag"), '"abc"');
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
  it("refuses off-host and off-prefix S3 redirects", async () => {
    assert.equal(isAllowedTilesUpstreamUrl("https://api.openaerialmap.org/meta"), true);
    assert.equal(isAllowedTilesUpstreamUrl("https://evil.example/meta"), false);
    assert.equal(
      isAllowedTilesUpstreamUrl("https://data.humdata.org/api/3/action/package_search"),
      true,
    );
    assert.equal(
      isAllowedTilesUpstreamUrl("https://data.humdata.org/api/3/action/package_search_v2"),
      false,
    );
    assert.equal(
      isAllowedTilesUpstreamUrl(
        "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/mola-color/0/0/0.png",
      ),
      true,
    );
    assert.equal(
      isAllowedTilesUpstreamUrl("https://s3-eu-west-1.amazonaws.com/other-bucket/secret"),
      false,
    );

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

  it("follows a same-host HTTPS redirect and caps hops", async () => {
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

    let hops = 0;
    const looping: typeof fetch = async (input) => {
      hops += 1;
      const url = String(input);
      return new Response(null, {
        status: 302,
        headers: { location: `${url}?n=${hops}` },
      });
    };
    await assert.rejects(
      () => fetchAllowlistedUpstream("https://api.openaerialmap.org/meta", {}, looping),
      /Too many upstream redirects/,
    );
    assert.equal(hops, TILES_MAX_REDIRECT_HOPS + 1);
  });

  it("passes through 304 Not Modified with its ETag", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, {
        status: 304,
        headers: { etag: '"tile-abc"' },
      });
    const response = await fetchAllowlistedUpstream(
      "https://api.openaerialmap.org/meta",
      { headers: { "if-none-match": '"tile-abc"' } },
      fetchImpl,
    );
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("etag"), '"tile-abc"');
  });

  it("accepts raw.githubusercontent.com and rejects evil redirect from it", async () => {
    assert.equal(
      isAllowedTilesUpstreamUrl("https://raw.githubusercontent.com/owner/repo/main/file.geojson"),
      true,
    );
    assert.equal(isAllowedTilesUpstreamUrl("https://raw.githubusercontent.com/"), true);
    assert.equal(isAllowedTilesUpstreamUrl("https://evil.githubusercontent.com/x"), false);

    const fetchImpl: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      });
    await assert.rejects(
      () =>
        fetchAllowlistedUpstream(
          "https://raw.githubusercontent.com/owner/repo/main/data.geojson",
          {},
          fetchImpl,
        ),
      /non-allowlisted/,
    );
  });
});

describe("Vite proxy guard — validatePublicUrl", () => {
  it("accepts public HTTP(S) URLs", () => {
    assert.equal(validatePublicUrl("https://example.com/tiles"), null);
    assert.equal(validatePublicUrl("http://example.com/data"), null);
    assert.equal(validatePublicUrl("https://8.8.8.8/dns"), null);
  });

  it("rejects non-HTTP protocols", () => {
    assert.notEqual(validatePublicUrl("ftp://example.com"), null);
    assert.notEqual(validatePublicUrl("file:///etc/passwd"), null);
    assert.notEqual(validatePublicUrl("data:text/html,<h1>hi</h1>"), null);
  });

  it("rejects URLs with credentials", () => {
    assert.notEqual(validatePublicUrl("https://user:pass@example.com"), null);
    assert.notEqual(validatePublicUrl("https://user@example.com"), null);
  });

  it("rejects non-default ports", () => {
    assert.match(validatePublicUrl("https://example.com:8443/tiles") ?? "", /port/i);
    assert.match(validatePublicUrl("http://8.8.8.8:8080/dns") ?? "", /port/i);
  });

  it("rejects localhost and .localhost", () => {
    assert.notEqual(validatePublicUrl("http://localhost/secret"), null);
    assert.notEqual(validatePublicUrl("http://foo.localhost/bar"), null);
  });

  it("rejects loopback IPv4 (127.0.0.0/8)", () => {
    assert.notEqual(validatePublicUrl("http://127.0.0.1/admin"), null);
    assert.notEqual(validatePublicUrl("http://127.0.0.2/x"), null);
    assert.notEqual(validatePublicUrl("http://127.255.255.255"), null);
  });

  it("rejects private RFC-1918 ranges", () => {
    assert.notEqual(validatePublicUrl("http://10.0.0.1"), null);
    assert.notEqual(validatePublicUrl("http://172.16.0.1"), null);
    assert.notEqual(validatePublicUrl("http://172.31.255.255"), null);
    assert.notEqual(validatePublicUrl("http://192.168.1.1"), null);
  });

  it("rejects link-local / cloud metadata 169.254.x.x", () => {
    assert.notEqual(validatePublicUrl("http://169.254.169.254/latest/meta-data/"), null);
    assert.notEqual(validatePublicUrl("http://169.254.0.1"), null);
  });

  it("rejects 0.0.0.0/8 and multicast/reserved (224+)", () => {
    assert.notEqual(validatePublicUrl("http://0.0.0.0"), null);
    assert.notEqual(validatePublicUrl("http://224.0.0.1"), null);
    assert.notEqual(validatePublicUrl("http://255.255.255.255"), null);
  });

  it("rejects CGNAT, benchmarking, and all three TEST-NET ranges", () => {
    assert.notEqual(validatePublicUrl("http://100.64.0.1"), null);
    assert.notEqual(validatePublicUrl("http://100.127.255.254"), null);
    assert.notEqual(validatePublicUrl("http://198.18.0.1"), null);
    assert.notEqual(validatePublicUrl("http://198.19.255.254"), null);
    assert.notEqual(validatePublicUrl("http://192.0.2.1"), null); // TEST-NET-1
    assert.notEqual(validatePublicUrl("http://198.51.100.1"), null); // TEST-NET-2
    assert.notEqual(validatePublicUrl("http://203.0.113.1"), null); // TEST-NET-3
  });

  it("rejects IPv6 loopback, full fe80::/10 link-local, and ULA", () => {
    assert.notEqual(validatePublicUrl("http://[::1]"), null);
    assert.notEqual(validatePublicUrl("http://[::]"), null);
    assert.notEqual(validatePublicUrl("http://[fe80::1]"), null);
    assert.notEqual(validatePublicUrl("http://[fe90::1]"), null); // still in fe80::/10
    assert.notEqual(validatePublicUrl("http://[febf::1]"), null); // top of fe80::/10
    assert.notEqual(validatePublicUrl("http://[fd00::1]"), null);
    assert.notEqual(validatePublicUrl("http://[fc00::1]"), null);
  });

  it("rejects IPv4-mapped IPv6 private addresses", () => {
    assert.notEqual(validatePublicUrl("http://[::ffff:127.0.0.1]"), null);
    assert.notEqual(validatePublicUrl("http://[::ffff:169.254.169.254]"), null);
    assert.notEqual(validatePublicUrl("http://[::ffff:10.0.0.1]"), null);
  });

  it("rejects metadata.google.internal", () => {
    assert.notEqual(validatePublicUrl("http://metadata.google.internal/v1/"), null);
  });

  it("allows non-private 172.x addresses outside 172.16-31", () => {
    assert.equal(validatePublicUrl("http://172.15.0.1"), null);
    assert.equal(validatePublicUrl("http://172.32.0.1"), null);
  });
});

describe("Vite proxy guard — assertPublicHttpUrl", () => {
  it("throws on private URLs", () => {
    assert.throws(() => assertPublicHttpUrl("http://127.0.0.1"), /private|reserved|Blocked/i);
    assert.throws(
      () => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"),
      /private|reserved|Blocked/i,
    );
  });

  it("does not throw on public URLs", () => {
    assert.doesNotThrow(() => assertPublicHttpUrl("https://example.com/tiles"));
    assert.doesNotThrow(() => assertPublicHttpUrl("https://8.8.8.8/dns"));
  });
});

describe("Vite proxy guard — assertResolvedPublicHost", () => {
  it("rejects private IP literals without DNS", async () => {
    await assert.rejects(() => assertResolvedPublicHost("127.0.0.1"), /Blocked/);
    await assert.rejects(() => assertResolvedPublicHost("169.254.169.254"), /Blocked/);
  });

  it("accepts a public IP literal", async () => {
    await assertResolvedPublicHost("8.8.8.8");
  });

  it("rejects a DNS name that resolves to a private address", async () => {
    const lookup = (async () => [{ address: "10.0.0.5", family: 4 as const }]) as never;
    await assert.rejects(() => assertResolvedPublicHost("evil.example", lookup), /10\.0\.0\.5/);
  });

  it("rejects an empty DNS result", async () => {
    const lookup = (async () => []) as never;
    await assert.rejects(() => assertResolvedPublicHost("empty.example", lookup), /no addresses/);
  });
});

describe("Vite proxy guard — readBodyWithLimit", () => {
  it("rejects an oversized Content-Length before reading", async () => {
    const response = new Response("ignored", {
      headers: { "content-length": String(PROXY_MAX_BODY_BYTES + 1) },
    });
    await assert.rejects(() => readBodyWithLimit(response), /size limit/);
  });

  it("aborts when streamed bytes exceed the limit", async () => {
    const chunk = new Uint8Array(1024).fill(1);
    let remaining = 3;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining-- > 0) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });
    const response = new Response(stream);
    await assert.rejects(() => readBodyWithLimit(response, 1500), /size limit/);
  });

  it("returns the full body when under the limit", async () => {
    const response = new Response("hello", { headers: { "content-length": "5" } });
    const buf = await readBodyWithLimit(response, 100);
    assert.equal(buf.toString("utf8"), "hello");
  });
});

describe("Vite proxy guard — fetchWithGuard redirect policy", () => {
  const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 as const }]) as never;

  it("follows a public redirect and refuses a private-address redirect", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      assert.equal(init?.redirect, "manual");
      if (url === "https://example.com/a") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/b" },
        });
      }
      if (url === "https://example.com/b") {
        return new Response("ok", { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };

    const resp = await fetchWithGuard(
      "https://example.com/a",
      {},
      { fetchImpl, lookup: publicLookup },
    );
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), "ok");

    const evil: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    await assert.rejects(
      () =>
        fetchWithGuard("https://example.com/evil", {}, { fetchImpl: evil, lookup: publicLookup }),
      /Blocked/,
    );
  });

  it("caps redirect hops", async () => {
    let hops = 0;
    const fetchImpl: typeof fetch = async (input) => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: `${String(input)}?n=${hops}` },
      });
    };

    await assert.rejects(
      () => fetchWithGuard("https://example.com/loop", {}, { fetchImpl, lookup: publicLookup }),
      /Too many/,
    );
    assert.equal(hops, PROXY_MAX_REDIRECT_HOPS + 1);
  });

  it("still resolves DNS when a test fetchImpl is injected", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("should not run", { status: 200 });
    };
    const lookup = (async () => [{ address: "10.0.0.5", family: 4 as const }]) as never;
    await assert.rejects(
      () => fetchWithGuard("https://evil.example/x", {}, { fetchImpl, lookup }),
      /10\.0\.0\.5/,
    );
    assert.equal(called, false);
  });
});

describe("guarded connector DNS lookup", () => {
  // `dns.lookup(host, { all: true }, cb)` stand-in.
  const resolving = (addresses: Array<{ address: string; family: number }>) =>
    ((hostname: string, options: unknown, cb: (err: unknown, addresses: unknown) => void) => {
      cb(null, addresses);
    }) as never;

  it("answers the array form when the connector asked for all addresses", () => {
    // Node's `net` enables autoSelectFamily by default, so it passes
    // `all: true` and then reads `addresses[0].address` off the reply. Replying
    // with the single-address string form makes it index into a string and
    // throw `ERR_INVALID_IP_ADDRESS: undefined`, which 502s every proxied
    // raster fetch.
    const addresses = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];
    let reply: unknown[] | undefined;
    guardedLookup(
      "example.com",
      { all: true },
      (err, address, family) => {
        assert.equal(err, null);
        reply = [address, family];
      },
      resolving(addresses),
    );

    assert.deepEqual(reply?.[0], addresses, "hands back every validated address");
  });

  it("answers the single-address form when the connector did not ask for all", () => {
    let reply: unknown[] | undefined;
    guardedLookup(
      "example.com",
      {},
      (err, address, family) => {
        assert.equal(err, null);
        reply = [address, family];
      },
      resolving([{ address: "93.184.216.34", family: 4 }]),
    );

    assert.deepEqual(reply, ["93.184.216.34", 4]);
  });

  it("refuses a host that resolves to a private address in either reply shape", () => {
    for (const options of [{ all: true }, {}]) {
      let error: Error | null = null;
      guardedLookup(
        "rebind.example",
        options,
        (err) => {
          error = err as Error;
        },
        resolving([
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ]),
      );

      assert.match(String(error), /169\.254\.169\.254/);
    }
  });
});
