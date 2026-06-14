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
};

type DiagnosticsModule =
  typeof import("../apps/geolibre-desktop/src/lib/diagnostics");
let appendDiagnostic: DiagnosticsModule["appendDiagnostic"];
let clearDiagnostics: DiagnosticsModule["clearDiagnostics"];
let getDiagnosticsSnapshot: DiagnosticsModule["getDiagnosticsSnapshot"];
let setCaptureNetworkInfo: DiagnosticsModule["setCaptureNetworkInfo"];

before(async () => {
  ({
    appendDiagnostic,
    clearDiagnostics,
    getDiagnosticsSnapshot,
    setCaptureNetworkInfo,
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
    console.warn = realWarn;
    console.error = realError;
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
    const cleanup = installCapture();
    const { event, wasPrevented } = rejectionEvent(
      new TypeError("Failed to fetch"),
    );
    listeners.get("unhandledrejection")?.(event);
    assert.equal(wasPrevented(), true);
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.level, "warning");
    assert.equal(record.category, "network");
    cleanup();
  });

  it("leaves a fetch rejection alone outside the Tauri runtime", () => {
    const cleanup = installCapture();
    const { event, wasPrevented } = rejectionEvent(
      new TypeError("Failed to fetch"),
    );
    listeners.get("unhandledrejection")?.(event);
    assert.equal(wasPrevented(), false);
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.level, "error");
    assert.equal(record.category, "runtime");
    cleanup();
  });

  it("does not swallow a non-fetch rejection under Tauri", () => {
    win.__TAURI_INTERNALS__ = {};
    const cleanup = installCapture();
    const { event, wasPrevented } = rejectionEvent(new Error("boom"));
    listeners.get("unhandledrejection")?.(event);
    assert.equal(wasPrevented(), false);
    assert.equal(getDiagnosticsSnapshot().records[0]?.level, "error");
    cleanup();
  });

  it("records but does not echo Tauri's IPC fallback warning", () => {
    win.__TAURI_INTERNALS__ = {};
    let echoed: unknown[] | null = null;
    console.warn = (...args: unknown[]) => {
      echoed = args;
    };
    const cleanup = installCapture();
    console.warn(
      "IPC custom protocol failed, Tauri will now use the postMessage interface instead",
      new TypeError("Failed to fetch"),
    );
    assert.equal(echoed, null);
    assert.equal(getDiagnosticsSnapshot().records[0]?.level, "warning");
    cleanup();
  });

  it("still echoes ordinary warnings under Tauri", () => {
    win.__TAURI_INTERNALS__ = {};
    let echoed: unknown[] | null = null;
    console.warn = (...args: unknown[]) => {
      echoed = args;
    };
    const cleanup = installCapture();
    console.warn("a normal warning");
    assert.deepEqual(echoed, ["a normal warning"]);
    cleanup();
  });
});
