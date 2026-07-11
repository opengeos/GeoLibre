import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";

// diagnostics.ts reads localStorage at import time, so the window stub must
// be installed before the module is loaded; hence the dynamic import below.
const storage = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  },
  // Stubs so installDiagnosticsCapture (which patches window.fetch and adds
  // window error listeners) can run under node --test.
  fetch: (() => Promise.resolve(new Response())) as typeof fetch,
  addEventListener: () => {},
  removeEventListener: () => {},
};

type DiagnosticsModule =
  typeof import("../apps/geolibre-desktop/src/lib/diagnostics");
let appendDiagnostic: DiagnosticsModule["appendDiagnostic"];
let clearDiagnostics: DiagnosticsModule["clearDiagnostics"];
let getDiagnosticsSnapshot: DiagnosticsModule["getDiagnosticsSnapshot"];
let setCaptureNetworkInfo: DiagnosticsModule["setCaptureNetworkInfo"];
let installDiagnosticsCapture: DiagnosticsModule["installDiagnosticsCapture"];
let OPTIONAL_RESOURCE_HEADER: DiagnosticsModule["OPTIONAL_RESOURCE_HEADER"];

before(async () => {
  ({
    appendDiagnostic,
    clearDiagnostics,
    getDiagnosticsSnapshot,
    setCaptureNetworkInfo,
    installDiagnosticsCapture,
    OPTIONAL_RESOURCE_HEADER,
  } = await import("../apps/geolibre-desktop/src/lib/diagnostics"));
});

// Intentionally duplicated from diagnostics.ts: the key is a persistence
// contract with users' localStorage, so an accidental rename in the source
// should fail this test rather than be silently mirrored by an import.
const CAPTURE_NETWORK_INFO_STORAGE_KEY =
  "geolibre.diagnostics.captureNetworkInfo";

describe("diagnostics network info capture", () => {
  beforeEach(() => {
    setCaptureNetworkInfo(false);
    clearDiagnostics();
    storage.clear();
  });

  it("drops info-level network entries by default", () => {
    appendDiagnostic({
      category: "network",
      level: "info",
      message: "GET 200 OK",
    });
    assert.equal(getDiagnosticsSnapshot().totalCount, 0);
    assert.equal(getDiagnosticsSnapshot().networkCount, 0);
  });

  it("keeps error-level network entries by default", () => {
    appendDiagnostic({
      category: "network",
      level: "error",
      message: "GET 500 Internal Server Error",
    });
    const snapshot = getDiagnosticsSnapshot();
    assert.equal(snapshot.totalCount, 1);
    assert.equal(snapshot.networkCount, 1);
    assert.equal(snapshot.errorCount, 1);
  });

  it("keeps warning-level network entries even when capture is off", () => {
    appendDiagnostic({
      category: "network",
      level: "warning",
      message: "GET 301 Moved Permanently",
    });
    const snapshot = getDiagnosticsSnapshot();
    assert.equal(snapshot.totalCount, 1);
    assert.equal(snapshot.networkCount, 1);
    assert.equal(snapshot.warningCount, 1);
  });

  it("redacts sensitive query params from a URL embedded in the detail", () => {
    appendDiagnostic({
      category: "network",
      level: "error",
      message: "GET fetch_url_bytes failed (network)",
      // A native reqwest error embeds the full request URL, including secrets.
      detail:
        "error sending request for url (https://tiles.example.com/1/2/3.png?api_key=SECRET123): connection refused",
    });
    const [record] = getDiagnosticsSnapshot().records;
    // The param value is replaced with the REDACTED marker (URL-encoded in the
    // query string); the important guarantee is the secret no longer appears.
    assert.ok(record.detail?.includes("REDACTED"));
    assert.ok(!record.detail?.includes("SECRET123"));
  });

  it("does not filter info-level entries from other categories", () => {
    appendDiagnostic({
      category: "console",
      level: "info",
      message: "informational",
    });
    assert.equal(getDiagnosticsSnapshot().totalCount, 1);
  });

  it("records info-level network entries once enabled", () => {
    setCaptureNetworkInfo(true);
    appendDiagnostic({
      category: "network",
      level: "info",
      message: "GET 200 OK",
    });
    const snapshot = getDiagnosticsSnapshot();
    assert.equal(snapshot.totalCount, 1);
    assert.equal(snapshot.networkCount, 1);
    assert.equal(snapshot.captureNetworkInfo, true);
  });

  it("persists opt-in to localStorage and clears the key on opt-out", () => {
    setCaptureNetworkInfo(true);
    assert.equal(storage.get(CAPTURE_NETWORK_INFO_STORAGE_KEY), "true");
    setCaptureNetworkInfo(false);
    assert.equal(storage.has(CAPTURE_NETWORK_INFO_STORAGE_KEY), false);
  });

  it("exposes the capture flag through the snapshot", () => {
    assert.equal(getDiagnosticsSnapshot().captureNetworkInfo, false);
    setCaptureNetworkInfo(true);
    assert.equal(getDiagnosticsSnapshot().captureNetworkInfo, true);
  });
});

describe("diagnostics startup transient suppression", () => {
  type Listener = (event: unknown) => void;
  const listeners = new Map<string, Listener>();
  const win = (globalThis as { window?: Record<string, unknown> }).window!;
  let installCapture: DiagnosticsModule["installDiagnosticsCapture"];
  let realWarn: typeof console.warn;
  let realError: typeof console.error;
  const realDateNow = Date.now;
  // Tracked so afterEach can tear down the interceptors even if an assertion
  // throws mid-test, keeping the module-level capture ref-count clean.
  let activeCleanup: (() => void) | null = null;

  function install(): void {
    activeCleanup = installCapture();
  }

  before(async () => {
    ({ installDiagnosticsCapture: installCapture } = await import(
      "../apps/geolibre-desktop/src/lib/diagnostics"
    ));
  });

  beforeEach(() => {
    listeners.clear();
    clearDiagnostics();
    realWarn = console.warn;
    realError = console.error;
    win.fetch = (() => Promise.resolve()) as unknown as typeof fetch;
    win.addEventListener = (type: string, listener: Listener) => {
      listeners.set(type, listener);
    };
    win.removeEventListener = (type: string) => {
      listeners.delete(type);
    };
    delete win.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    activeCleanup?.();
    activeCleanup = null;
    console.warn = realWarn;
    console.error = realError;
    Date.now = realDateNow;
  });

  function rejectionEvent(reason: unknown) {
    let prevented = false;
    return {
      event: {
        reason,
        preventDefault: () => {
          prevented = true;
        },
      },
      wasPrevented: () => prevented,
    };
  }

  it("swallows a benign startup fetch rejection under Tauri", () => {
    win.__TAURI_INTERNALS__ = {};
    install();
    const { event, wasPrevented } = rejectionEvent(
      new TypeError("Failed to fetch"),
    );
    listeners.get("unhandledrejection")?.(event);
    assert.equal(wasPrevented(), true);
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.level, "warning");
    assert.equal(record.category, "network");
  });

  it("leaves a fetch rejection alone outside the Tauri runtime", () => {
    install();
    const { event, wasPrevented } = rejectionEvent(
      new TypeError("Failed to fetch"),
    );
    listeners.get("unhandledrejection")?.(event);
    assert.equal(wasPrevented(), false);
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.level, "error");
    assert.equal(record.category, "runtime");
  });

  it("does not swallow a fetch rejection after the startup window", () => {
    win.__TAURI_INTERNALS__ = {};
    install();
    // installedAt is captured at install; jump past the grace window so the
    // rejection no longer counts as a startup transient.
    Date.now = () => realDateNow() + 60_000;
    const { event, wasPrevented } = rejectionEvent(
      new TypeError("Failed to fetch"),
    );
    listeners.get("unhandledrejection")?.(event);
    assert.equal(wasPrevented(), false);
    assert.equal(getDiagnosticsSnapshot().records[0]?.level, "error");
  });

  it("does not swallow a non-fetch rejection under Tauri", () => {
    win.__TAURI_INTERNALS__ = {};
    install();
    const { event, wasPrevented } = rejectionEvent(new Error("boom"));
    listeners.get("unhandledrejection")?.(event);
    assert.equal(wasPrevented(), false);
    assert.equal(getDiagnosticsSnapshot().records[0]?.level, "error");
  });

  it("records but does not echo Tauri's IPC fallback warning", () => {
    win.__TAURI_INTERNALS__ = {};
    let echoed: unknown[] | null = null;
    console.warn = (...args: unknown[]) => {
      echoed = args;
    };
    install();
    console.warn(
      "IPC custom protocol failed, Tauri will now use the postMessage interface instead",
      new TypeError("Failed to fetch"),
    );
    assert.equal(echoed, null);
    assert.equal(getDiagnosticsSnapshot().records[0]?.level, "warning");
  });

  it("echoes the IPC fallback warning after the startup window", () => {
    win.__TAURI_INTERNALS__ = {};
    let echoed: unknown[] | null = null;
    console.warn = (...args: unknown[]) => {
      echoed = args;
    };
    install();
    Date.now = () => realDateNow() + 60_000;
    const message =
      "IPC custom protocol failed, Tauri will now use the postMessage interface instead";
    console.warn(message);
    assert.deepEqual(echoed, [message]);
  });

  it("still echoes ordinary warnings under Tauri", () => {
    win.__TAURI_INTERNALS__ = {};
    let echoed: unknown[] | null = null;
    console.warn = (...args: unknown[]) => {
      echoed = args;
    };
    install();
    console.warn("a normal warning");
    assert.deepEqual(echoed, ["a normal warning"]);
  });

  it("keeps the benign globe easing warning out of diagnostics but echoes it", () => {
    let echoed: unknown[] | null = null;
    console.warn = (...args: unknown[]) => {
      echoed = args;
    };
    install();
    const message =
      "Easing around a point is not supported under globe projection.";
    console.warn(message);
    // Echoed to the console for contributors, but not recorded in the panel.
    assert.deepEqual(echoed, [message]);
    assert.equal(getDiagnosticsSnapshot().totalCount, 0);
  });

  it("flags an unmarked non-ok response as an error", async () => {
    win.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" }),
      )) as unknown as typeof fetch;
    install();
    await (win.fetch as typeof fetch)("/missing.json");
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.category, "network");
    assert.equal(record.level, "error");
    assert.equal(getDiagnosticsSnapshot().errorCount, 1);
  });

  it("downgrades a non-ok response on an optional-resource request", async () => {
    setCaptureNetworkInfo(true);
    try {
      win.fetch = (() =>
        Promise.resolve(
          new Response(null, { status: 404, statusText: "Not Found" }),
        )) as unknown as typeof fetch;
      install();
      await (win.fetch as typeof fetch)("/admin-profile.json", {
        headers: { [OPTIONAL_RESOURCE_HEADER]: "1" },
      });
      const [record] = getDiagnosticsSnapshot().records;
      assert.equal(record.category, "network");
      // Marked optional, so the 404 is informational rather than an error.
      assert.equal(record.level, "info");
      assert.equal(getDiagnosticsSnapshot().errorCount, 0);
    } finally {
      setCaptureNetworkInfo(false);
    }
  });

  it("treats init.headers as replacing a Request's optional marker", async () => {
    win.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" }),
      )) as unknown as typeof fetch;
    install();
    // The Request carries the optional marker, but init.headers replaces the
    // Request's headers entirely (fetch spec), dropping it — so the 404 is a
    // real error.
    await (win.fetch as typeof fetch)(
      new Request("http://localhost/admin-profile.json", {
        headers: { [OPTIONAL_RESOURCE_HEADER]: "1" },
      }),
      { headers: {} },
    );
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.category, "network");
    assert.equal(record.level, "error");
    assert.equal(getDiagnosticsSnapshot().errorCount, 1);
  });

  it("downgrades a thrown network error on an optional-resource request", async () => {
    setCaptureNetworkInfo(true);
    try {
      win.fetch = (() =>
        Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
      install();
      await (win.fetch as typeof fetch)("/admin-profile.json", {
        headers: { [OPTIONAL_RESOURCE_HEADER]: "1" },
      }).catch(() => {});
      const [record] = getDiagnosticsSnapshot().records;
      assert.equal(record.category, "network");
      // Optional, so even a thrown failure is informational rather than an error.
      assert.equal(record.level, "info");
      assert.equal(getDiagnosticsSnapshot().errorCount, 0);
    } finally {
      setCaptureNetworkInfo(false);
    }
  });

  it("downgrades a benign startup fetch failure under Tauri to a warning", async () => {
    win.__TAURI_INTERNALS__ = {};
    win.fetch = (() =>
      Promise.reject(new TypeError("Load failed"))) as unknown as typeof fetch;
    install();
    // The URL is illustrative of the real warm-up failure (a call to the Tauri
    // IPC endpoint); the benign-startup downgrade keys off the error message,
    // not the URL, so any URL would produce the same result here.
    await (win.fetch as typeof fetch)("http://ipc.localhost/main").catch(
      () => {},
    );
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.category, "network");
    // The Tauri custom-protocol warm-up at launch retries over postMessage, so
    // it is a benign transient rather than a critical error (issue #657).
    assert.equal(record.level, "warning");
    assert.equal(getDiagnosticsSnapshot().errorCount, 0);
    // The panel badge reads warningCount, so assert it tracks the downgrade.
    assert.equal(getDiagnosticsSnapshot().warningCount, 1);
  });

  it("keeps a startup fetch failure outside the Tauri runtime as an error", async () => {
    win.fetch = (() =>
      Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    install();
    await (win.fetch as typeof fetch)("https://example.com/data").catch(
      () => {},
    );
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.category, "network");
    assert.equal(record.level, "error");
    assert.equal(getDiagnosticsSnapshot().errorCount, 1);
  });

  it("flags a fetch failure after the startup window as an error under Tauri", async () => {
    win.__TAURI_INTERNALS__ = {};
    win.fetch = (() =>
      Promise.reject(new TypeError("Load failed"))) as unknown as typeof fetch;
    install();
    // Jump past the grace window so the failure is no longer a startup transient.
    Date.now = () => realDateNow() + 60_000;
    await (win.fetch as typeof fetch)("http://ipc.localhost/main").catch(
      () => {},
    );
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.level, "error");
    assert.equal(getDiagnosticsSnapshot().errorCount, 1);
  });

  it("classifies a genuine fetch network failure with an actionable hint", async () => {
    win.fetch = (() =>
      Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    install();
    await (win.fetch as typeof fetch)("https://example.com/data").catch(
      () => {},
    );
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.level, "error");
    // The opaque browser error is interpreted rather than left as a raw stack.
    assert.match(record.message, /network\/TLS\/CORS/);
    assert.ok(record.detail?.includes("CORS"));
    // The raw error is still preserved after the hint.
    assert.ok(record.detail?.includes("Failed to fetch"));
  });

  it("does not append a redundant label for an unclassified failure", async () => {
    win.fetch = (() =>
      Promise.reject(new Error("some opaque failure"))) as unknown as typeof fetch;
    install();
    await (win.fetch as typeof fetch)("https://example.com/data").catch(
      () => {},
    );
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.level, "error");
    // An "unknown" classification must not render "request failed (request failed)".
    assert.equal(record.message, "GET request failed");
    assert.ok(!/\(request failed\)/.test(record.message));
  });
});
