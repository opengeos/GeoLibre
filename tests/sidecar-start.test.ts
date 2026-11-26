import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ignoreSidecarStartError,
  startGeoLibreSidecar,
  StaleSidecarError,
  stopGeoLibreSidecar,
} from "../apps/geolibre-desktop/src/lib/sidecar";
import { checkSidecarHealth, setSidecarFetch } from "../packages/processing/src/sidecar-client";

/**
 * The token the sidecar client currently attaches: what a start publishes and a
 * stop clears.
 */
async function currentSidecarToken(): Promise<string | null> {
  let token: string | null = null;
  setSidecarFetch(async (_input, init) => {
    token = new Headers(init?.headers).get("X-GeoLibre-Token");
    return new Response("{}", { status: 500 });
  });
  try {
    await checkSidecarHealth("http://127.0.0.1:8765");
  } finally {
    setSidecarFetch(null);
  }
  return token;
}

// Tauri rejects a failed `Result<_, String>` command with the bare string. The
// stale-sidecar case must become a StaleSidecarError so best-effort callers
// surface it instead of hitting the old sidecar without a token (GeoLibre#2959).
// The message is STALE_SIDECAR_ERROR in src-tauri/src/sidecar.rs, whose own test
// keeps the matched phrase in place.
const STALE =
  "A GeoLibre processing server from a previous session is still running on port 8765 " +
  "but does not accept this session's token. Quit any stray GeoLibre processes and try again.";

// isTauri() and invoke() both read window.__TAURI_INTERNALS__ at call time.
const globals: { window?: unknown } = globalThis;
let rejection: unknown;
let previousWindow: unknown;
let previousStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const ledger = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => ledger.get(key) ?? null,
      setItem: (key: string, value: string) => ledger.set(key, value),
      removeItem: (key: string) => ledger.delete(key),
    },
  });
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
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
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

it("does not republish a start response delivered after stop completes", async () => {
  let finishStart!: (info: { baseUrl: string; port: number; token: string }) => void;
  globals.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string) =>
        command === "start_geolibre_sidecar"
          ? new Promise((resolve) => {
              finishStart = resolve;
            })
          : Promise.resolve(),
    },
  };
  const starting = startGeoLibreSidecar();
  await stopGeoLibreSidecar();
  finishStart({ baseUrl: "http://127.0.0.1:8765", port: 8765, token: "obsolete" });
  await starting;
  assert.equal(await currentSidecarToken(), null);
});

it("never touches Live MCP access: the desktop shell hosts that relay", async () => {
  const commands: string[] = [];
  const info = { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "processing" };
  globals.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        commands.push(command);
        return info;
      },
    },
  };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response("{}");
  };
  try {
    assert.deepEqual(await startGeoLibreSidecar(), info);
    await stopGeoLibreSidecar();
    assert.deepEqual(commands, ["start_geolibre_sidecar", "stop_geolibre_sidecar"]);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("reports a failed stop without claiming the running sidecar stopped", async () => {
  const info = { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "still-running" };
  let failStop = true;
  globals.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        if (command === "stop_geolibre_sidecar" && failStop) throw new Error("stop failed");
        return info;
      },
    },
  };
  try {
    await startGeoLibreSidecar();
    await assert.rejects(stopGeoLibreSidecar(), /stop failed/);
    assert.equal(await currentSidecarToken(), "still-running");
  } finally {
    failStop = false;
    await stopGeoLibreSidecar();
  }
});

it("does not publish a start result while a requested stop is still pending", async () => {
  const info = { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "stopping" };
  let finishStart!: (value: typeof info) => void;
  let finishStop!: () => void;
  const startResult = new Promise<typeof info>((resolve) => {
    finishStart = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  globals.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string) => (command === "start_geolibre_sidecar" ? startResult : stopped),
    },
  };
  try {
    const starting = startGeoLibreSidecar();
    const stopping = stopGeoLibreSidecar();
    finishStart(info);
    await starting;
    assert.equal(await currentSidecarToken(), null);
    finishStop();
    await stopping;
    assert.equal(await currentSidecarToken(), null);
  } finally {
    finishStop();
  }
});
