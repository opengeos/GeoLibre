import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { tilesWorker } from "../workers/tiles/src/index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Calgary CCTV edge proxy", () => {
  it("relays one fixed, bounded public frame with CORS", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(requested, "https://trafficcam.calgary.ca/loc86.jpg");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "public, max-age=30");
  });

  it("accepts the Referer-only request shape sent by popup image elements", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { referer: "https://web.geolibre.app/" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 200);
  });

  it("returns 502 when the upstream frame body stalls", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let startedReading!: () => void;
    const readingStarted = new Promise<void>((resolve) => {
      startedReading = resolve;
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          pull(controller) {
            startedReading();
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
        { status: 200, headers: { "content-type": "image/jpeg" } },
      );
    }) as typeof fetch;
    const pending = tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    await readingStarted;
    t.mock.timers.tick(30_000);
    assert.equal((await pending).status, 502);
  });

  it("rejects a request with neither an allowed origin nor referrer", async () => {
    const headerlessResponse = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg"),
      {},
      {} as ExecutionContext,
    );
    assert.equal(headerlessResponse.status, 403);
  });

  it("rejects untrusted origins, malformed ids, non-images, and oversized frames", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("not an image", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    const forbidden = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "https://example.com" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(fetched, false);

    const forbiddenReferer = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { referer: "https://example.com/" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbiddenReferer.status, 403);
    assert.equal(fetched, false);

    const malformed = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/not-an-id.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(malformed.status, 404);

    const wrongType = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(wrongType.status, 502);

    globalThis.fetch = (async () =>
      new Response(new Uint8Array(), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(5 * 1024 * 1024 + 1),
        },
      })) as typeof fetch;
    const oversized = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(oversized.status, 502);
  });
});

describe("Austin CCTV edge proxy", () => {
  it("relays one fixed, bounded public frame with CORS", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/austin/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(requested, "https://cctv.austinmobility.io/image/86.jpg");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  it("rejects malformed ids before fetching upstream", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response();
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/austin/12345.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 404);
    assert.equal(fetched, false);
  });
});

describe("CCTV catalog edge proxy", () => {
  it("relays only the fixed provider JSON catalogs", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const body = url.includes("livetraffic")
        ? '{"features":[]}'
        : url.includes("dot.ca.gov")
          ? '{"data":[]}'
          : "[]";
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    for (const provider of ["ontario", "drivebc", "nsw", "caltrans-4"]) {
      const response = await tilesWorker.fetch(
        new Request(`https://tiles.geolibre.app/cctv/catalog/${provider}.json`, {
          headers: { origin: "http://localhost:5173" },
        }),
        {},
        {} as ExecutionContext,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("cache-control"), "public, max-age=900");
    }
    assert.deepEqual(requested, [
      "https://511on.ca/api/v2/get/cameras?format=json&lang=en",
      "https://www.drivebc.ca/api/webcams/",
      "https://data.livetraffic.com/cameras/traffic-cam.json",
      "https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json",
    ]);
  });

  it("rejects untrusted callers, unknown providers, and malformed upstream JSON", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const forbidden = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/catalog/ontario.json", {
        headers: { origin: "https://example.com" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(fetched, false);
    const unknown = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/catalog/unknown.json", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(unknown.status, 404);
    const malformed = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/catalog/ontario.json", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(malformed.status, 502);

    globalThis.fetch = (async () =>
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const wrongNswShape = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/catalog/nsw.json", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(wrongNswShape.status, 502);
  });
});

describe("Ontario CCTV edge proxy", () => {
  it("relays a pinned Ontario frame with browser-readable CORS", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/ontario/1456", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(requested, "https://511on.ca/map/Cctv/1456");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});

describe("NSW CCTV edge proxy", () => {
  it("relays a pinned frame with the browser user agent required upstream", async () => {
    let requested = "";
    let userAgent = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input);
      userAgent = new Headers(init?.headers).get("user-agent") ?? "";
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/nsw/king_st_%26_sussex_st_sydney.jpeg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(
      requested,
      "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/king_st_%26_sussex_st_sydney.jpeg",
    );
    assert.match(userAgent, /Mozilla\/5\.0/);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
  });
});

describe("Caltrans CCTV edge proxy", () => {
  it("relays a pinned district frame with browser-readable CORS", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/caltrans/4/TV102i580WestOfSR24.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(
      requested,
      "https://cwwp2.dot.ca.gov/data/d4/cctv/image/TV102i580WestOfSR24/TV102i580WestOfSR24.jpg",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});
