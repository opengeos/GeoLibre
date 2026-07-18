import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CollabConnection,
  createSession,
  httpBaseFromWs,
  resolveCollabBaseUrl,
  sessionWsUrl,
} from "../apps/geolibre-desktop/src/lib/collab-client";
import { participantCanEdit } from "../apps/geolibre-desktop/src/lib/collab-protocol";
import type {
  ClientMessage,
  ServerMessage,
} from "../apps/geolibre-desktop/src/lib/collab-protocol";
import type { CollaborationParticipant } from "@geolibre/core";

describe("resolveCollabBaseUrl", () => {
  it("accepts a wss host", () => {
    assert.equal(resolveCollabBaseUrl("wss://collab.geolibre.app"), "wss://collab.geolibre.app");
  });

  it("accepts ws on loopback for local dev", () => {
    assert.equal(resolveCollabBaseUrl("ws://127.0.0.1:8787"), "ws://127.0.0.1:8787");
    assert.equal(resolveCollabBaseUrl("ws://localhost:8787"), "ws://localhost:8787");
  });

  it("trims a trailing slash", () => {
    assert.equal(resolveCollabBaseUrl("wss://collab.geolibre.app/"), "wss://collab.geolibre.app");
  });

  it("rejects plaintext ws on a non-loopback host", () => {
    assert.equal(resolveCollabBaseUrl("ws://collab.geolibre.app"), null);
    // A look-alike host must not slip through a naive prefix check.
    assert.equal(resolveCollabBaseUrl("ws://localhost.evil.com"), null);
  });

  it("rejects non-ws protocols and junk", () => {
    assert.equal(resolveCollabBaseUrl("https://collab.geolibre.app"), null);
    assert.equal(resolveCollabBaseUrl("not a url"), null);
  });

  it("returns null when unset", () => {
    assert.equal(resolveCollabBaseUrl(undefined), null);
    assert.equal(resolveCollabBaseUrl(""), null);
  });
});

describe("url derivation", () => {
  it("maps ws(s) to http(s)", () => {
    assert.equal(httpBaseFromWs("wss://collab.geolibre.app"), "https://collab.geolibre.app");
    assert.equal(httpBaseFromWs("ws://127.0.0.1:8787"), "http://127.0.0.1:8787");
  });

  it("builds the session websocket url with an encoded code", () => {
    assert.equal(
      sessionWsUrl("wss://collab.geolibre.app", "AB CD"),
      "wss://collab.geolibre.app/sessions/AB%20CD/ws",
    );
  });
});

describe("participantCanEdit", () => {
  const base = (over: Partial<CollaborationParticipant>): CollaborationParticipant => ({
    clientId: "x",
    displayName: "X",
    color: "#000000",
    role: "guest",
    editOverride: null,
    ...over,
  });

  it("always lets the host edit, regardless of mode", () => {
    assert.equal(participantCanEdit(base({ role: "host" }), "view-only"), true);
    assert.equal(participantCanEdit(base({ role: "host" }), "co-edit"), true);
  });

  it("follows the session mode when there is no override", () => {
    assert.equal(participantCanEdit(base({}), "co-edit"), true);
    assert.equal(participantCanEdit(base({}), "view-only"), false);
  });

  it("lets a host-set override win over the session mode", () => {
    // Pinned to view-only inside an otherwise co-edit session.
    assert.equal(participantCanEdit(base({ editOverride: false }), "co-edit"), false);
    // Granted edit inside an otherwise view-only session.
    assert.equal(participantCanEdit(base({ editOverride: true }), "view-only"), true);
  });
});

describe("new protocol messages round-trip", () => {
  it("serializes a set-participant-mode client message", () => {
    const msg: ClientMessage = {
      type: "set-participant-mode",
      clientId: "guest-1",
      canEdit: false,
    };
    assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg);
  });

  it("serializes a chat send with an attached coordinate", () => {
    const msg: ClientMessage = {
      type: "chat",
      text: "look here",
      coordinate: { lng: -122.4, lat: 37.8 },
    };
    assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg);
  });

  it("parses a chat broadcast server message", () => {
    const server: ServerMessage = {
      type: "chat",
      message: {
        id: "m1",
        clientId: "c1",
        displayName: "Alex",
        color: "#2563eb",
        text: "hi",
        coordinate: null,
        ts: 1_700_000_000_000,
      },
    };
    const parsed = JSON.parse(JSON.stringify(server)) as ServerMessage;
    assert.equal(parsed.type, "chat");
    assert.equal(parsed.type === "chat" ? parsed.message.text : null, "hi");
  });
});

describe("createSession", () => {
  const ok = (body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

  it("returns the parsed session on success", async () => {
    const result = await createSession(
      "co-edit",
      "wss://collab.geolibre.app",
      ok({ sessionId: "ABCD2345", hostToken: "deadbeef", mode: "co-edit" }),
    );
    assert.deepEqual(result, {
      sessionId: "ABCD2345",
      hostToken: "deadbeef",
      mode: "co-edit",
    });
  });

  it("throws when collaboration is not configured", async () => {
    await assert.rejects(() => createSession("co-edit", null, ok({})), /not configured/);
  });

  it("throws on an unexpected response shape", async () => {
    await assert.rejects(
      () => createSession("co-edit", "wss://x.example", ok({ sessionId: "x" })),
      /unexpected response/,
    );
  });

  it("throws a friendly error on a non-ok status", async () => {
    const fail: typeof fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(() => createSession("co-edit", "wss://x.example", fail), /HTTP 500/);
  });
});

// A minimal fake WebSocket that lets us drive open/message/close synchronously.
class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, ((event: unknown) => void)[]> = {};
  constructor(public url: string) {}
  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, event?: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

describe("CollabConnection", () => {
  function setup() {
    const holder: { socket: FakeWebSocket | null } = { socket: null };
    const Impl = function (this: unknown, url: string) {
      holder.socket = new FakeWebSocket(url);
      return holder.socket;
    } as unknown as typeof WebSocket;
    (Impl as unknown as { OPEN: number }).OPEN = FakeWebSocket.OPEN;
    const received: ServerMessage[] = [];
    const events: string[] = [];
    const conn = new CollabConnection(
      "wss://x.example/sessions/AB/ws",
      {
        onOpen: () => events.push("open"),
        onMessage: (m) => received.push(m),
        onClose: (reconnecting) => events.push(`close:${reconnecting}`),
      },
      Impl,
    );
    // The socket only exists after connect(); read it through the holder then.
    return { conn, holder, received, events };
  }

  it("reports open, parses messages, and serializes sends", () => {
    const { conn, holder, received, events } = setup();
    conn.connect();
    const socket = holder.socket!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    assert.deepEqual(events, ["open"]);

    const welcome: ServerMessage = {
      type: "welcome",
      clientId: "c1",
      role: "host",
      mode: "co-edit",
      participants: [],
      snapshot: null,
      presence: {},
      chat: [],
      rev: 0,
    };
    socket.emit("message", { data: JSON.stringify(welcome) });
    assert.equal(received.length, 1);
    assert.equal(received[0]?.type, "welcome");

    const msg: ClientMessage = {
      type: "presence",
      cursor: { lng: 1, lat: 2 },
    };
    conn.send(msg);
    assert.deepEqual(JSON.parse(socket.sent[0] ?? "null"), msg);
    conn.close();
  });

  it("ignores malformed inbound frames", () => {
    const { conn, holder, received } = setup();
    conn.connect();
    holder.socket!.emit("message", { data: "{not json" });
    holder.socket!.emit("message", { data: 123 }); // non-string
    assert.equal(received.length, 0);
    conn.close();
  });

  it("signals reconnecting on an unexpected close, not after close()", () => {
    const { conn, holder, events } = setup();
    conn.connect();
    holder.socket!.emit("close");
    assert.ok(events.includes("close:true"));
    conn.close(); // clears the pending reconnect timer

    const second = setup();
    second.conn.connect();
    second.conn.close();
    second.holder.socket!.emit("close");
    assert.ok(second.events.includes("close:false"));
  });
});
