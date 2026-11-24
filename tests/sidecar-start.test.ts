import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ignoreSidecarStartError,
  startGeoLibreSidecar,
  StaleSidecarError,
  stopGeoLibreSidecar,
  subscribeSidecarRelay,
  updateLiveMcpAccess,
} from "../apps/geolibre-desktop/src/lib/sidecar";
import { useDesktopSettingsStore } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";

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
  const seen: unknown[] = [];
  const unsubscribe = subscribeSidecarRelay((info) => seen.push(info));
  try {
    const starting = startGeoLibreSidecar();
    await stopGeoLibreSidecar();
    finishStart({ baseUrl: "http://127.0.0.1:8765", port: 8765, token: "obsolete" });
    await starting;
    assert.deepEqual(seen, [null]);
  } finally {
    unsubscribe();
  }
});

it("keeps processing startup successful when relay access synchronization fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalSettings = useDesktopSettingsStore.getState().desktopSettings;
  useDesktopSettingsStore.setState({
    desktopSettings: {
      ...originalSettings,
      startup: { ...originalSettings.startup, allowLiveMcp: true },
    },
  });
  let requests = 0;
  const info = { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "processing" };
  globals.window = { __TAURI_INTERNALS__: { invoke: async () => info } };
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("relay unavailable");
  };
  try {
    assert.deepEqual(await startGeoLibreSidecar(), info);
    await updateLiveMcpAccess();
    assert.ok(requests > 0);
  } finally {
    await stopGeoLibreSidecar();
    globalThis.fetch = originalFetch;
    useDesktopSettingsStore.setState({ desktopSettings: originalSettings });
  }
});

it("applies opt-in and revocation to a running sidecar without stopping it", async () => {
  const originalFetch = globalThis.fetch;
  const originalSettings = useDesktopSettingsStore.getState().desktopSettings;
  const commands: string[] = [];
  const requests: { enabled: boolean }[] = [];
  const relayStates: unknown[] = [];
  const unsubscribe = subscribeSidecarRelay((info) => relayStates.push(info));
  globals.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        commands.push(command);
        return { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "current" };
      },
    },
  };
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "http://127.0.0.1:8765/relay/access");
    assert.equal(new Headers(init?.headers).get("X-GeoLibre-Token"), "current");
    requests.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  const setAllowed = (enabled: boolean) =>
    useDesktopSettingsStore.setState({
      desktopSettings: {
        ...originalSettings,
        startup: { ...originalSettings.startup, allowLiveMcp: enabled },
      },
    });
  try {
    setAllowed(false);
    await startGeoLibreSidecar();
    setAllowed(true);
    await updateLiveMcpAccess();
    assert.ok(relayStates.at(-1));
    setAllowed(false);
    const revocation = updateLiveMcpAccess();
    assert.equal(relayStates.at(-1), null);
    await revocation;
    assert.deepEqual(requests, [{ enabled: true }, { enabled: false }]);
    assert.deepEqual(commands, ["start_geolibre_sidecar"]);
  } finally {
    await stopGeoLibreSidecar();
    globalThis.fetch = originalFetch;
    useDesktopSettingsStore.setState({ desktopSettings: originalSettings });
    unsubscribe();
  }
});

it("reports a failed stop without claiming the running sidecar stopped", async () => {
  const originalFetch = globalThis.fetch;
  const originalSettings = useDesktopSettingsStore.getState().desktopSettings;
  useDesktopSettingsStore.setState({
    desktopSettings: {
      ...originalSettings,
      startup: { ...originalSettings.startup, allowLiveMcp: true },
    },
  });
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
  globalThis.fetch = async () => Response.json({ enabled: false });
  const seen: unknown[] = [];
  const unsubscribe = subscribeSidecarRelay((state) => seen.push(state));
  try {
    await startGeoLibreSidecar();
    await updateLiveMcpAccess();
    await assert.rejects(stopGeoLibreSidecar(), /stop failed/);
    assert.equal(seen.at(-1), info);
  } finally {
    failStop = false;
    await stopGeoLibreSidecar();
    unsubscribe();
    globalThis.fetch = originalFetch;
    useDesktopSettingsStore.setState({ desktopSettings: originalSettings });
  }
});
