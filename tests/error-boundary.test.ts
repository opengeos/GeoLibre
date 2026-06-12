import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

// diagnostics.ts (pulled in transitively by the desktop boundaries) reads
// localStorage at import time, so the window stub must be installed before the
// modules are loaded; hence the dynamic imports below.
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

type ErrorBoundaryModule =
  typeof import("../packages/ui/src/components/error-boundary");
type BoundariesModule =
  typeof import("../apps/geolibre-desktop/src/components/common/error-boundaries");
type DiagnosticsModule =
  typeof import("../apps/geolibre-desktop/src/lib/diagnostics");

let ErrorBoundary: ErrorBoundaryModule["ErrorBoundary"];
let resetKeysChanged: ErrorBoundaryModule["resetKeysChanged"];
let reportBoundaryError: BoundariesModule["reportBoundaryError"];
let clearDiagnostics: DiagnosticsModule["clearDiagnostics"];
let getDiagnosticsSnapshot: DiagnosticsModule["getDiagnosticsSnapshot"];

before(async () => {
  ({ ErrorBoundary, resetKeysChanged } = await import(
    "../packages/ui/src/components/error-boundary"
  ));
  ({ reportBoundaryError } = await import(
    "../apps/geolibre-desktop/src/components/common/error-boundaries"
  ));
  ({ clearDiagnostics, getDiagnosticsSnapshot } = await import(
    "../apps/geolibre-desktop/src/lib/diagnostics"
  ));
});

describe("ErrorBoundary derived state", () => {
  it("captures the thrown error into state", () => {
    const error = new Error("boom");
    assert.deepEqual(ErrorBoundary.getDerivedStateFromError(error), { error });
  });
});

describe("resetKeysChanged", () => {
  it("treats absent and empty key lists the same (no reset)", () => {
    assert.equal(resetKeysChanged(undefined, undefined), false);
    assert.equal(resetKeysChanged(undefined, []), false);
    assert.equal(resetKeysChanged([], undefined), false);
    assert.equal(resetKeysChanged([], []), false);
  });

  it("does not reset when keys are unchanged", () => {
    assert.equal(resetKeysChanged(["a", 1], ["a", 1]), false);
  });

  it("resets when a key value changes", () => {
    assert.equal(resetKeysChanged(["a"], ["b"]), true);
  });

  it("resets when the key count changes", () => {
    assert.equal(resetKeysChanged(["a"], ["a", "b"]), true);
    assert.equal(resetKeysChanged([], ["a"]), true);
  });
});

describe("reportBoundaryError", () => {
  beforeEach(() => {
    clearDiagnostics();
  });

  it("records a runtime error diagnostic the user can see", () => {
    reportBoundaryError("Layer panel", new Error("render failed"), {
      componentStack: "\n at LayerPanel",
    });
    const snapshot = getDiagnosticsSnapshot();
    assert.equal(snapshot.totalCount, 1);
    assert.equal(snapshot.errorCount, 1);
    const [record] = snapshot.records;
    assert.equal(record.category, "runtime");
    assert.equal(record.level, "error");
    assert.match(record.message, /Layer panel crashed: render failed/);
    assert.equal(record.source, "Layer panel");
    assert.ok(record.detail?.includes("at LayerPanel"));
  });
});
