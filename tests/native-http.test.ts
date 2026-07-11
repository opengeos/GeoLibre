import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// native-http imports diagnostics, which reads localStorage at import time, and
// @tauri-apps/api/core; stub the globals both touch before importing.
const storage = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

type NativeHttpModule =
  typeof import("../apps/geolibre-desktop/src/lib/native-http");
let nativeHttpSuccessRecord: NativeHttpModule["nativeHttpSuccessRecord"];
let nativeHttpFailureRecord: NativeHttpModule["nativeHttpFailureRecord"];

before(async () => {
  ({ nativeHttpSuccessRecord, nativeHttpFailureRecord } = await import(
    "../apps/geolibre-desktop/src/lib/native-http"
  ));
});

describe("nativeHttpSuccessRecord", () => {
  it("builds an info-level network record with the command and context", () => {
    const record = nativeHttpSuccessRecord(
      "fetch_url_bytes",
      "https://example.com/wms",
      42,
      "WFS GetCapabilities",
    );
    assert.equal(record.category, "network");
    assert.equal(record.level, "info");
    assert.equal(record.method, "GET");
    assert.equal(record.durationMs, 42);
    assert.equal(record.url, "https://example.com/wms");
    assert.match(record.message, /fetch_url_bytes/);
    assert.equal(record.source, "native fetch_url_bytes — WFS GetCapabilities");
  });

  it("omits the context suffix from the source when none is given", () => {
    const record = nativeHttpSuccessRecord("resolve_url_redirect", "https://x/y", 5);
    assert.equal(record.source, "native resolve_url_redirect");
  });
});

describe("nativeHttpFailureRecord", () => {
  it("classifies a native TLS error and prepends the hint to the raw error", () => {
    const record = nativeHttpFailureRecord(
      "fetch_url_bytes",
      "https://example.com/wms",
      "Request failed: invalid peer certificate",
      100,
      "WFS GetCapabilities",
    );
    assert.equal(record.level, "error");
    assert.match(record.message, /failed \(network\)/);
    // The native hint comes first (no CORS / "try the desktop app" advice, since
    // this path already runs in the desktop app), then the raw error follows.
    assert.ok(record.detail?.includes("certificate"));
    assert.ok(!record.detail?.includes("CORS"));
    assert.ok(record.detail?.includes("invalid peer certificate"));
  });

  it("keeps the raw error alone when the failure is unclassified", () => {
    const record = nativeHttpFailureRecord(
      "fetch_url_bytes",
      "https://example.com/tile",
      "Request failed with status 500 Internal Server Error",
      10,
    );
    assert.equal(record.level, "error");
    // An "unknown" classification (an ordinary non-2xx status) must not render
    // the redundant "failed (request failed)".
    assert.equal(record.message, "GET fetch_url_bytes failed");
    assert.equal(record.detail, "Request failed with status 500 Internal Server Error");
  });
});
