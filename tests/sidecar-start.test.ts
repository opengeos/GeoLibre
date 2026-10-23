import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ignoreSidecarStartError,
  startGeoLibreSidecar,
  StaleSidecarError,
} from "../apps/geolibre-desktop/src/lib/sidecar";

// Tauri rejects a failed `Result<_, String>` command with the bare string. The
// stale-sidecar case must become a StaleSidecarError so best-effort callers
// surface it instead of hitting the old sidecar without a token (GeoLibre#2959).
// The message is STALE_SIDECAR_ERROR in src-tauri/src/lib.rs, whose own test
// keeps the matched phrase in place.
const STALE =
  "A GeoLibre processing server from a previous session is still running on port 8765 " +
  "but does not accept this session's token. Quit any stray GeoLibre processes and try again.";

// isTauri() and invoke() both read window.__TAURI_INTERNALS__ at call time.
const globals: { window?: unknown } = globalThis;
let rejection: unknown;
let previousWindow: unknown;

beforeEach(() => {
  previousWindow = globals.window;
  globals.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        assert.equal(cmd, "start_geolibre_sidecar");
        throw rejection;
      },
    },
  };
});

afterEach(() => {
  globals.window = previousWindow;
});

describe("startGeoLibreSidecar failures", () => {
  it("classifies the backend's stale-sidecar string as StaleSidecarError", async () => {
    rejection = STALE;
    const error = await startGeoLibreSidecar().catch((caught: unknown) => caught);
    assert.ok(error instanceof StaleSidecarError);
    assert.equal(error.message, STALE);
    assert.throws(() => ignoreSidecarStartError(error), StaleSidecarError);
  });

  it("wraps any other string rejection in a plain Error that callers may ignore", async () => {
    rejection = "Could not start GeoLibre sidecar: uv not found";
    const error = await startGeoLibreSidecar().catch((caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof StaleSidecarError));
    assert.equal(error.message, "Could not start GeoLibre sidecar: uv not found");
    assert.doesNotThrow(() => ignoreSidecarStartError(error));
  });
});
