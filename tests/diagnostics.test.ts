import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

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
