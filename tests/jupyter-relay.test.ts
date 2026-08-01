import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RELAY_RECONNECT_MAX_MS,
  RELAY_RECONNECT_MIN_MS,
  parseRelayMessage,
  relayReconnectDelay,
  relaySocketUrl,
  runRelayCommand,
} from "../apps/geolibre-desktop/src/lib/jupyter-relay";
import type { ScriptingHandlers } from "../apps/geolibre-desktop/src/lib/scripting/scriptingApi";

// The wire format the app shares with the desktop Jupyter map-command relay
// (backend/geolibre_server/geolibre_server/jupyter_relay.py), which is what lets
// an external Jupyter client (VS Code) drive the map — issue #1442.

const SERVER = { url: "http://127.0.0.1:8766", port: 8766, token: "s3cret" };

describe("relaySocketUrl", () => {
  it("points at the relay socket with the server token", () => {
    assert.equal(relaySocketUrl(SERVER), "ws://127.0.0.1:8766/geolibre/relay/socket?token=s3cret");
  });

  it("upgrades an https server to wss", () => {
    assert.equal(
      relaySocketUrl({ ...SERVER, url: "https://127.0.0.1:8766" }),
      "wss://127.0.0.1:8766/geolibre/relay/socket?token=s3cret",
    );
  });

  it("does not double up the path separator", () => {
    assert.equal(
      relaySocketUrl({ ...SERVER, url: "http://127.0.0.1:8766/" }),
      "ws://127.0.0.1:8766/geolibre/relay/socket?token=s3cret",
    );
  });

  it("escapes a token with URL-significant characters", () => {
    const url = new URL(relaySocketUrl({ ...SERVER, token: "a b&c=d" }));
    assert.equal(url.searchParams.get("token"), "a b&c=d");
  });

  it("omits the token when the server has none", () => {
    assert.equal(
      relaySocketUrl({ ...SERVER, token: "" }),
      "ws://127.0.0.1:8766/geolibre/relay/socket",
    );
  });
});

describe("parseRelayMessage", () => {
  it("accepts a command envelope", () => {
    const command = parseRelayMessage(
      JSON.stringify({
        type: "geolibre:command",
        requestId: "",
        method: "flyTo",
        params: { zoom: 4 },
      }),
    );
    assert.deepEqual(command, { requestId: "", method: "flyTo", params: { zoom: 4 } });
  });

  it("defaults missing or non-object params to an empty object", () => {
    for (const params of [undefined, null, "nope", [1, 2]]) {
      const command = parseRelayMessage(
        JSON.stringify({ type: "geolibre:command", method: "x", params }),
      );
      assert.deepEqual(command?.params, {});
      assert.equal(command?.requestId, "");
    }
  });

  it("preserves a correlated request id", () => {
    const command = parseRelayMessage(
      JSON.stringify({
        type: "geolibre:command",
        requestId: "request-1",
        method: "listLayers",
      }),
    );
    assert.equal(command?.requestId, "request-1");
  });

  it("ignores the relay's ready greeting", () => {
    assert.equal(parseRelayMessage(JSON.stringify({ type: "geolibre:relay-ready" })), null);
  });

  it("rejects anything that is not a command", () => {
    // A frame that is not ours must never be dispatched as a map command.
    assert.equal(parseRelayMessage(JSON.stringify({ type: "other", method: "flyTo" })), null);
    assert.equal(parseRelayMessage(JSON.stringify({ type: "geolibre:command" })), null);
    assert.equal(parseRelayMessage(JSON.stringify({ type: "geolibre:command", method: "" })), null);
    assert.equal(parseRelayMessage(JSON.stringify({ type: "geolibre:command", method: 7 })), null);
    assert.equal(parseRelayMessage(JSON.stringify(["geolibre:command"])), null);
    assert.equal(parseRelayMessage("not json"), null);
    assert.equal(parseRelayMessage(new ArrayBuffer(4)), null);
    assert.equal(parseRelayMessage(null), null);
  });
});

describe("runRelayCommand", () => {
  // The reply this builds is what the relay's correlated request/reply path
  // returns to the kernel, so `list_layers()` / `add_geojson()` read-back in the
  // notebook client is exactly these payloads.
  const handlers = {
    listLayers: () => [{ id: "layer-1" }],
    addGeoJsonLayer: async () => "layer-2",
    boom: () => {
      throw new Error("handler exploded");
    },
  } as unknown as ScriptingHandlers;

  /** Run without the hook's diagnostics polluting the test output. */
  const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
    const { warn, error } = console;
    console.warn = () => {};
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.warn = warn;
      console.error = error;
    }
  };

  it("returns the handler's value under the request id", async () => {
    const result = await runRelayCommand(handlers, {
      requestId: "request-1",
      method: "listLayers",
      params: {},
    });
    assert.deepEqual(result, {
      type: "geolibre:result",
      requestId: "request-1",
      ok: true,
      value: [{ id: "layer-1" }],
    });
  });

  it("awaits an async handler", async () => {
    const result = await runRelayCommand(handlers, {
      requestId: "request-2",
      method: "addGeoJsonLayer",
      params: {},
    });
    assert.deepEqual(result, {
      type: "geolibre:result",
      requestId: "request-2",
      ok: true,
      value: "layer-2",
    });
  });

  it("reports a handler failure as ok:false", async () => {
    const result = await quietly(() =>
      runRelayCommand(handlers, { requestId: "request-3", method: "boom", params: {} }),
    );
    assert.deepEqual(result, {
      type: "geolibre:result",
      requestId: "request-3",
      ok: false,
      error: "handler exploded",
    });
  });

  it("reports an unknown command as ok:false rather than hanging the caller", async () => {
    const result = await quietly(() =>
      runRelayCommand(handlers, { requestId: "request-4", method: "nope", params: {} }),
    );
    assert.deepEqual(result, {
      type: "geolibre:result",
      requestId: "request-4",
      ok: false,
      error: 'Unknown command "nope"',
    });
  });

  it("never dispatches an inherited member as a command", async () => {
    const result = await quietly(() =>
      runRelayCommand(handlers, { requestId: "request-5", method: "constructor", params: {} }),
    );
    assert.equal(result?.ok, false);
  });

  it("replies with nothing for a fire-and-forget command", async () => {
    // An empty requestId means the kernel is not waiting; the handler still runs.
    let ran = false;
    const spy = { ping: () => (ran = true) } as unknown as ScriptingHandlers;
    assert.equal(await runRelayCommand(spy, { requestId: "", method: "ping", params: {} }), null);
    assert.equal(ran, true);
    assert.equal(
      await quietly(() => runRelayCommand(spy, { requestId: "", method: "boom", params: {} })),
      null,
    );
  });
});

describe("relayReconnectDelay", () => {
  it("starts at the minimum and backs off exponentially", () => {
    assert.equal(relayReconnectDelay(0), RELAY_RECONNECT_MIN_MS);
    assert.equal(relayReconnectDelay(1), RELAY_RECONNECT_MIN_MS * 2);
    assert.equal(relayReconnectDelay(2), RELAY_RECONNECT_MIN_MS * 4);
  });

  it("caps the delay so a restarted server is picked up promptly", () => {
    assert.equal(relayReconnectDelay(50), RELAY_RECONNECT_MAX_MS);
  });

  it("treats a negative attempt count as the first one", () => {
    assert.equal(relayReconnectDelay(-3), RELAY_RECONNECT_MIN_MS);
  });
});
