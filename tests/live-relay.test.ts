import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type LiveRelayTransport,
  connectLiveRelay,
  createLiveRelayAccessController,
} from "../apps/geolibre-desktop/src/lib/live-relay";
import type { ScriptingHandlers } from "../apps/geolibre-desktop/src/lib/scripting/scriptingApi";

// The app side of the Live MCP relay the desktop shell hosts
// (src-tauri/src/live_relay.rs): access follows the user's setting, and while
// it is on the webview runs relayed commands and returns their results.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLiveRelayAccessController", () => {
  it("applies opt-in and opt-out, revoking before the shell confirms", async () => {
    let enabled = true;
    const sent: boolean[] = [];
    let release!: () => void;
    let hold: Promise<void> | null = null;
    const controller = createLiveRelayAccessController({
      getEnabled: () => enabled,
      send: async (value) => {
        sent.push(value);
        if (hold) await hold;
      },
    });
    const ready: boolean[] = [];
    controller.subscribe((state) => ready.push(state.ready));
    await controller.sync();
    assert.equal(controller.getState().ready, true);

    enabled = false;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const revoking = controller.sync();
    // Commands stop before the shell has answered.
    assert.equal(controller.getState().ready, false);
    release();
    await revoking;
    assert.deepEqual(sent, [true, false]);
    // Initial state, "enabling", confirmed, then revoked.
    assert.deepEqual(ready, [false, false, true, false]);
    controller.dispose();
  });

  it("reasserts a disabled preference on every sync, as after a reload", async () => {
    const sent: boolean[] = [];
    const controller = createLiveRelayAccessController({
      getEnabled: () => false,
      send: async (value) => {
        sent.push(value);
      },
    });
    await controller.sync();
    await controller.sync();
    assert.deepEqual(sent, [false, false]);
    controller.dispose();
  });

  it("reports and retries a failed update", async () => {
    let fail = true;
    const controller = createLiveRelayAccessController({
      getEnabled: () => true,
      send: async () => {
        if (fail) throw new Error("shell busy");
      },
    });
    await controller.sync();
    assert.deepEqual(controller.getState(), { enabled: true, ready: false, error: true });
    fail = false;
    await controller.sync();
    assert.deepEqual(controller.getState(), { enabled: true, ready: true, error: false });
    controller.dispose();
  });

  it("drops a stale result when the preference changed while it was in flight", async () => {
    let enabled = true;
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sent: boolean[] = [];
    const controller = createLiveRelayAccessController({
      getEnabled: () => enabled,
      send: async (value) => {
        sent.push(value);
        if (sent.length === 1) {
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    });
    const enabling = controller.sync();
    await firstStarted;
    enabled = false;
    const disabling = controller.sync();
    release();
    await Promise.all([enabling, disabling]);
    assert.deepEqual(sent, [true, false]);
    assert.equal(controller.getState().ready, false);
    controller.dispose();
  });
});

function fakeTransport() {
  const calls: string[] = [];
  const replies: unknown[] = [];
  let handler: ((payload: unknown) => void) | null = null;
  const transport: LiveRelayTransport = {
    listen: async (next) => {
      calls.push("listen");
      handler = next;
      return () => {
        calls.push("unlisten");
        handler = null;
      };
    },
    subscribe: async () => {
      calls.push("subscribe");
    },
    unsubscribe: async () => {
      calls.push("unsubscribe");
    },
    reply: async (frame) => {
      replies.push(JSON.parse(frame));
    },
  };
  return { transport, calls, replies, emit: (payload: unknown) => handler?.(payload) };
}

describe("connectLiveRelay", () => {
  it("subscribes while ready, runs commands, and unsubscribes on revocation", async () => {
    let setReady!: (ready: boolean) => void;
    const ready = (listener: (ready: boolean) => void) => {
      setReady = listener;
      listener(false);
      return () => {};
    };
    const handlers = {
      getView: async (params: Record<string, unknown>) => ({ zoom: 3, params }),
      boom: async () => {
        throw new Error("no map");
      },
    } as unknown as ScriptingHandlers;
    const fake = fakeTransport();
    const stop = connectLiveRelay(ready, handlers, fake.transport);
    assert.deepEqual(fake.calls, []);

    setReady(true);
    await flush();
    assert.deepEqual(fake.calls, ["listen", "subscribe"]);

    fake.emit({ type: "geolibre:command", requestId: "d1", method: "getView", params: { a: 1 } });
    fake.emit({ type: "geolibre:command", requestId: "d2", method: "boom", params: {} });
    fake.emit({ type: "other" });
    await flush();
    assert.deepEqual(fake.replies, [
      { type: "geolibre:result", requestId: "d1", ok: true, value: { zoom: 3, params: { a: 1 } } },
      { type: "geolibre:result", requestId: "d2", ok: false, error: "no map" },
    ]);

    setReady(false);
    await flush();
    assert.deepEqual(fake.calls, ["listen", "subscribe", "unlisten", "unsubscribe"]);
    fake.emit({ type: "geolibre:command", requestId: "d3", method: "getView", params: {} });
    await flush();
    assert.equal(fake.replies.length, 2);
    stop();
  });

  it("does not report a command that finishes after an opt-out", async () => {
    let setReady!: (ready: boolean) => void;
    let finish!: (value: unknown) => void;
    const handlers = {
      slow: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    } as unknown as ScriptingHandlers;
    const fake = fakeTransport();
    const stop = connectLiveRelay(
      (listener) => {
        setReady = listener;
        return () => {};
      },
      handlers,
      fake.transport,
    );
    setReady(true);
    await flush();
    fake.emit({ type: "geolibre:command", requestId: "s", method: "slow", params: {} });
    await flush();
    setReady(false);
    finish("late");
    await flush();
    assert.deepEqual(fake.replies, []);
    stop();
  });

  it("orders a stale unsubscribe before a newer subscription", async () => {
    let setReady!: (ready: boolean) => void;
    const fake = fakeTransport();
    let releaseFirst!: () => void;
    let subscribes = 0;
    fake.transport.subscribe = () => {
      subscribes += 1;
      fake.calls.push(`subscribe${subscribes}`);
      return subscribes === 1
        ? new Promise<void>((resolve) => {
            releaseFirst = resolve;
          })
        : Promise.resolve();
    };
    const stop = connectLiveRelay(
      (listener) => {
        setReady = listener;
        return () => {};
      },
      {} as ScriptingHandlers,
      fake.transport,
    );
    setReady(true);
    await flush();
    setReady(false);
    setReady(true);
    await flush();
    releaseFirst();
    await flush();
    await flush();
    const shell = fake.calls.filter((call) => call.startsWith("sub") || call === "unsubscribe");
    assert.deepEqual(shell, ["subscribe1", "unsubscribe", "subscribe2"]);
    stop();
  });

  it("unsubscribes a window whose subscription lands after teardown", async () => {
    let setReady!: (ready: boolean) => void;
    const fake = fakeTransport();
    let releaseSubscribe!: () => void;
    fake.transport.subscribe = () =>
      new Promise<void>((resolve) => {
        fake.calls.push("subscribe");
        releaseSubscribe = resolve;
      });
    const stop = connectLiveRelay(
      (listener) => {
        setReady = listener;
        return () => {};
      },
      {} as ScriptingHandlers,
      fake.transport,
    );
    setReady(true);
    await flush();
    stop();
    releaseSubscribe();
    await flush();
    assert.deepEqual(fake.calls, ["listen", "subscribe", "unlisten", "unsubscribe"]);
  });
});
