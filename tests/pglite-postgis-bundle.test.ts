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
