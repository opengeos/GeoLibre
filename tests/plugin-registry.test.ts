import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { fetchPluginRegistryShared } from "../apps/geolibre-desktop/src/lib/plugin-registry";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchPluginRegistryShared", () => {
  it("shares concurrent registry requests for one URL without caching the response", async () => {
    let resolveResponse!: (response: Response) => void;
    let requests = 0;
    globalThis.fetch = (() => {
      requests++;
      if (requests > 1) {
        return Promise.resolve(
          new Response("[]", { headers: { "Content-Type": "application/json" } }),
        );
      }
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    }) as typeof fetch;

    const url = "https://example.com/registry.json";
    const first = fetchPluginRegistryShared(url);
    const second = fetchPluginRegistryShared(url);
    assert.equal(second, first);
    assert.equal(requests, 1);

    resolveResponse(
      new Response(
        JSON.stringify([
          {
            id: "single-flight-plugin",
            name: "Single Flight Plugin",
            version: "1.0.0",
            manifestUrl: "https://example.com/plugin/plugin.json",
          },
        ]),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left, right);
    assert.equal(left.entries[0]?.id, "single-flight-plugin");

    await fetchPluginRegistryShared(url);
    assert.equal(requests, 2);
  });

  it("releases a rejected request so a later registry scan can retry", async () => {
    let requests = 0;
    globalThis.fetch = (() => {
      requests++;
      return Promise.resolve(new Response("Unavailable", { status: 503 }));
    }) as typeof fetch;

    const url = "https://example.com/retry-registry.json";
    const first = fetchPluginRegistryShared(url);
    const second = fetchPluginRegistryShared(url);
    assert.equal(second, first);
    await assert.rejects(first, /HTTP 503/);

    await assert.rejects(fetchPluginRegistryShared(url), /HTTP 503/);
    assert.equal(requests, 2);
  });

  it("keeps a lowercase hex bundleSha256 and drops anything else", async () => {
    const hash = "ab".repeat(32);
    const entry = (id: string, bundleSha256: unknown) => ({
      id,
      name: id,
      version: "1.0.0",
      manifestUrl: `https://example.com/${id}/plugin.json`,
      bundleSha256,
    });
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            entry("valid", hash),
            entry("uppercase", hash.toUpperCase()),
            entry("short", "ab".repeat(31)),
            entry("not-a-string", 42),
          ]),
          { headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => void warnings.push(message);
    let registry;
    try {
      registry = await fetchPluginRegistryShared("https://example.com/hash-registry.json");
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(
      registry.entries.map((e) => [e.id, e.bundleSha256]),
      [
        ["valid", hash],
        ["uppercase", undefined],
        ["short", undefined],
        ["not-a-string", undefined],
      ],
    );
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /"uppercase"/);
  });
});
