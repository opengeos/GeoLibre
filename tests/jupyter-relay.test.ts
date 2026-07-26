import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RELAY_RECONNECT_MAX_MS,
  RELAY_RECONNECT_MIN_MS,
  parseRelayMessage,
  relayReconnectDelay,
  relaySocketUrl,
} from "../apps/geolibre-desktop/src/lib/jupyter-relay";

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
    assert.deepEqual(command, { method: "flyTo", params: { zoom: 4 } });
  });

  it("defaults missing or non-object params to an empty object", () => {
    for (const params of [undefined, null, "nope", [1, 2]]) {
      const command = parseRelayMessage(
        JSON.stringify({ type: "geolibre:command", method: "x", params }),
      );
      assert.deepEqual(command?.params, {});
    }
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
