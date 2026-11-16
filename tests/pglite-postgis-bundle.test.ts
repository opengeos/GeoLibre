import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchFromMirrors,
  postgisBundleUrls,
  withMirroredPostgisBundle,
} from "../apps/geolibre-desktop/src/lib/pglite-postgis-bundle";

const MODULE_URL = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite-postgis@0.2.15/dist/index.js";
const UNPKG = "https://unpkg.com/@electric-sql/pglite-postgis@0.2.15/dist/postgis.tar.gz";
const JSDELIVR =
  "https://cdn.jsdelivr.net/npm/@electric-sql/pglite-postgis@0.2.15/dist/postgis.tar.gz";

describe("postgisBundleUrls", () => {
  it("puts the unpkg mirror before the module-relative jsDelivr URL", () => {
    assert.deepEqual(postgisBundleUrls(MODULE_URL), [UNPKG, JSDELIVR]);
  });

  it("keeps a non-jsDelivr module URL as the only candidate", () => {
    assert.deepEqual(postgisBundleUrls("https://example.com/pkg/dist/index.js"), [
      "https://example.com/pkg/dist/postgis.tar.gz",
    ]);
  });
});

describe("fetchFromMirrors", () => {
  it("returns the first mirror that succeeds", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response("bundle", { status: 200 });
    }) as unknown as typeof fetch;
    const blob = await fetchFromMirrors(["a", "b"], fake);
    assert.equal(await blob.text(), "bundle");
    assert.deepEqual(calls, ["a"]);
  });

  it("falls back after an HTTP error", async () => {
    const fake = (async (url: string) =>
      url === "a"
        ? new Response("", { status: 503 })
        : new Response("ok", { status: 200 })) as unknown as typeof fetch;
    assert.equal(await (await fetchFromMirrors(["a", "b"], fake)).text(), "ok");
  });

  it("falls back when a mirror sends no headers in time", async () => {
    const fake = ((url: string, init?: RequestInit) =>
      url === "a"
        ? new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
        : Promise.resolve(new Response("late", { status: 200 }))) as unknown as typeof fetch;
    assert.equal(await (await fetchFromMirrors(["a", "b"], fake, 10)).text(), "late");
  });

  it("names every failure when no mirror works", async () => {
    const fake = (async (url: string) => {
      if (url === "a") throw new Error("offline");
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await assert.rejects(fetchFromMirrors(["a", "b"], fake), /a: offline; b: HTTP 404/);
  });
});

describe("withMirroredPostgisBundle", () => {
  it("swaps the extension's bundlePath for a blob URL of the mirrored bytes", async () => {
    const ext = {
      name: "postgis",
      setup: async (_pg: unknown, opts: unknown) => ({
        emscriptenOpts: opts,
        bundlePath: new URL(JSDELIVR),
      }),
    };
    const fake = (async () => new Response("tar", { status: 200 })) as unknown as typeof fetch;
    const wrapped = withMirroredPostgisBundle(ext, [UNPKG], fake) as typeof ext;
    assert.equal(wrapped.name, "postgis");
    const result = await wrapped.setup({}, { env: 1 });
    assert.deepEqual(result.emscriptenOpts, { env: 1 });
    assert.equal(result.bundlePath.protocol, "blob:");
    const bytes = await (await fetch(result.bundlePath)).text();
    assert.equal(bytes, "tar");
    URL.revokeObjectURL(result.bundlePath.href);
  });
});

describe("PostGIS bundle integrity and reuse", () => {
  // SHA-256 of the ASCII string "good".
  const GOOD_SHA = "770e607624d689265ca6c44884d0807d9b054d23c473c106c72be9de08b7376c";

  it("rejects a mirror whose bytes do not match the expected digest", async () => {
    const fake = (async (url: string) =>
      new Response(url === "a" ? "evil" : "good", { status: 200 })) as unknown as typeof fetch;
    const blob = await fetchFromMirrors(["a", "b"], fake, 1000, GOOD_SHA);
    assert.equal(await blob.text(), "good");
    await assert.rejects(fetchFromMirrors(["a"], fake, 1000, GOOD_SHA), /a: SHA-256 mismatch/);
  });

  it("downloads once across repeated setups and retries after a failure", async () => {
    let calls = 0;
    let fail = true;
    const fake = (async () => {
      calls++;
      if (fail) return new Response("", { status: 503 });
      return new Response("good", { status: 200 });
    }) as unknown as typeof fetch;
    const ext = {
      name: "postgis",
      setup: async () => ({ bundlePath: new URL(JSDELIVR) }),
    };
    const wrapped = withMirroredPostgisBundle(ext, [UNPKG], fake, GOOD_SHA) as typeof ext;
    await assert.rejects(wrapped.setup());
    fail = false;
    const first = await wrapped.setup();
    const second = await wrapped.setup();
    assert.equal(first.bundlePath.href, second.bundlePath.href);
    assert.equal(calls, 2);
    URL.revokeObjectURL(first.bundlePath.href);
  });
});

describe("PostGIS mirror stall handling", () => {
  it("falls back when a mirror stops sending body data", async () => {
    const fake = ((url: string, init?: RequestInit) => {
      if (url !== "a") return Promise.resolve(new Response("ok", { status: 200 }));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    const blob = await fetchFromMirrors(["a", "b"], fake, 20);
    assert.equal(await blob.text(), "ok");
  });
});
