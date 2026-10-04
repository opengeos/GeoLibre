import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  getBlocklistedBundle,
  getBlocklistedPlugin,
  loadPluginBlocklist,
  parsePluginBlocklist,
  pluginBlocklistUrl,
  setPluginBlocklist,
} from "../apps/geolibre-desktop/src/lib/plugin-blocklist";
import { evaluatePlugin } from "../apps/geolibre-desktop/src/lib/plugin-policy";

const HASH = "ab".repeat(32);
const REGISTRY = "https://plugins.example.com/plugin-registry.json";
const originalFetch = globalThis.fetch;
const globals = globalThis as Record<string, unknown>;
let storage = new Map<string, string>();
let warnings: unknown[] = [];
const originalWarn = console.warn;

beforeEach(() => {
  storage = new Map();
  globals.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  warnings = [];
  console.warn = (...args: unknown[]) => void warnings.push(args);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  setPluginBlocklist([]);
});

function respondWith(body: unknown, status = 200): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    )) as typeof fetch;
}

describe("plugin blocklist", () => {
  it("keeps valid entries and drops malformed ones", () => {
    assert.deepEqual(
      parsePluginBlocklist({
        version: 1,
        blocked: [
          { id: "whole", reason: "Malware." },
          { id: "one-version", bundleSha256: HASH, reason: "Bad release." },
          { id: "bad-hash", bundleSha256: HASH.toUpperCase(), reason: "x" },
          { id: "", reason: "no id" },
          { id: "no-reason" },
          "not an object",
        ],
      }),
      [
        { id: "whole", reason: "Malware." },
        { id: "one-version", bundleSha256: HASH, reason: "Bad release." },
        { id: "no-reason", reason: "No reason given." },
      ],
    );
    assert.deepEqual(parsePluginBlocklist(null), []);
    assert.deepEqual(parsePluginBlocklist({ blocked: "nope" }), []);
  });

  it("lives next to the registry", () => {
    assert.equal(pluginBlocklistUrl(REGISTRY), "https://plugins.example.com/blocklist.json");
    assert.equal(pluginBlocklistUrl("not a url"), null);
  });

  it("denies a blocked plugin for every external source, not bundled drop-ins", () => {
    setPluginBlocklist([{ id: "evil", reason: "Malware." }]);
    for (const source of ["registry", "manifest-url", "zip", "directory"] as const) {
      const decision = evaluatePlugin("evil", source, null);
      assert.equal(decision.allowed, false, source);
      if (!decision.allowed) {
        assert.deepEqual(decision.denial, {
          kind: "blocklisted",
          pluginId: "evil",
          reason: "Malware.",
        });
      }
    }
    assert.equal(evaluatePlugin("evil", "bundled", null).allowed, true);
    assert.equal(evaluatePlugin("fine", "registry", null).allowed, true);
  });

  it("blocks a single bundle by hash without blocking the plugin", () => {
    setPluginBlocklist([{ id: "plugin", bundleSha256: HASH, reason: "Bad release." }]);
    assert.equal(getBlocklistedPlugin("plugin"), undefined);
    assert.equal(evaluatePlugin("plugin", "registry", null).allowed, true);
    assert.equal(getBlocklistedBundle("plugin", HASH)?.reason, "Bad release.");
    assert.equal(getBlocklistedBundle("plugin", "cd".repeat(32)), undefined);
    assert.equal(getBlocklistedBundle("other", HASH), undefined);
  });

  it("loads the list and caches it for offline starts", async () => {
    respondWith({ version: 1, blocked: [{ id: "evil", reason: "Malware." }] });
    await loadPluginBlocklist(REGISTRY);
    assert.equal(getBlocklistedPlugin("evil")?.reason, "Malware.");

    // Offline next session: the cached copy still blocks it.
    setPluginBlocklist([]);
    globalThis.fetch = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
    await loadPluginBlocklist(REGISTRY);
    assert.equal(getBlocklistedPlugin("evil")?.reason, "Malware.");
    assert.equal(warnings.length, 1);
  });

  it("treats a missing blocklist as empty", async () => {
    setPluginBlocklist([{ id: "stale", reason: "x" }]);
    respondWith("Not found", 404);
    await loadPluginBlocklist(REGISTRY);
    assert.equal(getBlocklistedPlugin("stale"), undefined);
  });

  it("rejects an oversized blocklist while streaming it", async () => {
    // A chunked body with no Content-Length, well over the 1 MB cap.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 4 * 1024 * 1024) return controller.close();
        sent += 256 * 1024;
        controller.enqueue(new Uint8Array(256 * 1024).fill(32));
      },
    });
    globalThis.fetch = (() => Promise.resolve(new Response(stream))) as typeof fetch;
    await loadPluginBlocklist(REGISTRY);
    assert.equal(evaluatePlugin("anything", "registry", null).allowed, true);
    assert.match(String((warnings[0] as unknown[])[1]), /exceeds the 1 MB size limit/);
    assert.ok(sent < 4 * 1024 * 1024, "stopped reading early");
  });

  it("fails open when it can't be fetched and nothing is cached", async () => {
    respondWith("{ not json", 200);
    await loadPluginBlocklist(REGISTRY);
    assert.equal(evaluatePlugin("anything", "registry", null).allowed, true);
    assert.equal(warnings.length, 1);
  });
});
