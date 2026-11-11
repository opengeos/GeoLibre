import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nmeaChecksum } from "../apps/geolibre-desktop/src/lib/nmea";
import type { GpsFix } from "../apps/geolibre-desktop/src/lib/gps-tracking";
import {
  connectAndroidBluetoothNmea,
  connectSerialNmea,
  listPairedBluetoothDevices,
  type NativeBluetoothBridge,
  NmeaError,
  serialNmeaSupported,
} from "../apps/geolibre-desktop/src/lib/nmea-source";

const sentence = (payload: string) => `$${payload}*${nmeaChecksum(payload)}\r\n`;

/** One complete 1 Hz epoch at the given `hhmmss.ss`. */
function epoch(time: string): string {
  return (
    sentence(`GNGGA,${time},3557.5432,N,08355.1234,W,1,09,0.92,268.4,M,-33.2,M,,`) +
    sentence(`GNRMC,${time},A,3557.5432,N,08355.1234,W,4.5,187.3,010826,,,A`)
  );
}

interface FakePort {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closeCalls: number;
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/**
 * Replace the whole `navigator` global rather than mutating the real one,
 * matching the convention in tests/geolocation.test.ts. That keeps the stub
 * from depending on the runtime providing an extensible `navigator`.
 */
function setSerialApi(serial: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node", serial },
    configurable: true,
    writable: true,
  });
}

function restoreNavigator(): void {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
}

/**
 * Install a fake `navigator.serial` whose port streams whatever the test
 * enqueues. Only the browser API boundary is faked; the transport, the parser,
 * and the assembler all run for real.
 */
function installFakeSerial(): { port: () => FakePort; restore: () => void } {
  let fake: FakePort | undefined;
  const makePort = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const port = {
      open: async () => {},
      close: async () => {
        if (fake) fake.closeCalls += 1;
      },
      get readable() {
        return stream;
      },
    };
    fake = { controller, closeCalls: 0 };
    return port;
  };
  setSerialApi({ requestPort: async () => makePort() });
  return {
    port: () => {
      assert.ok(fake, "no port was requested");
      return fake;
    },
    restore: restoreNavigator,
  };
}

const encode = (text: string) => new TextEncoder().encode(text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("connectSerialNmea", () => {
  it("reports Web Serial support from the presence of navigator.serial", () => {
    const serial = installFakeSerial();
    try {
      assert.equal(serialNmeaSupported(), true);
    } finally {
      serial.restore();
    }
  });

  it("streams fixes assembled from the sentences the port emits", async () => {
    const serial = installFakeSerial();
    try {
      const fixes: GpsFix[] = [];
      const conn = await connectSerialNmea(
        { baudRate: 9600 },
        { onFix: (f) => fixes.push(f), onError: () => {} },
      );
      // The second epoch's first sentence is what closes the first epoch.
      serial.port().controller.enqueue(encode(epoch("174512.00") + epoch("174513.00")));
      await settle();
      assert.equal(fixes.length, 1, "one completed epoch");
      assert.ok(Math.abs(fixes[0].lat - 35.9590533) < 1e-6);
      assert.ok(Math.abs(fixes[0].speed! - 2.315) < 1e-3, "carried RMC speed");
      assert.equal(conn.stats().fixes, 1);
      await conn.close();
    } finally {
      serial.restore();
    }
  });

  it("delivers no further fix once close() has been called", async () => {
    const serial = installFakeSerial();
    try {
      const fixes: GpsFix[] = [];
      const conn = await connectSerialNmea(
        { baudRate: 9600 },
        { onFix: (f) => fixes.push(f), onError: () => {} },
      );
      serial.port().controller.enqueue(encode(epoch("174512.00") + epoch("174513.00")));
      await settle();
      const delivered = fixes.length;
      assert.equal(delivered, 1, "precondition: the stream is live");

      // Enqueue data that would complete another fix and close in the same turn,
      // so the pending read() resolves only after close() has set its flag. The
      // contract is that close() never delivers another fix: a late one would
      // re-create the map overlays that teardown has already removed.
      serial.port().controller.enqueue(encode(epoch("174514.00") + epoch("174515.00")));
      await conn.close();
      await settle();
      assert.equal(fixes.length, delivered, "no fix arrived after close()");
    } finally {
      serial.restore();
    }
  });

  it("is safe to close twice and releases the port once", async () => {
    const serial = installFakeSerial();
    try {
      const conn = await connectSerialNmea(
        { baudRate: 9600 },
        { onFix: () => {}, onError: () => {} },
      );
      await conn.close();
      await conn.close();
      assert.equal(serial.port().closeCalls, 1);
    } finally {
      serial.restore();
    }
  });

  it("classifies a dismissed port chooser as cancelled rather than a failure", async () => {
    setSerialApi({
      requestPort: async () => {
        // What Chromium throws when the user dismisses the port picker.
        const err = new Error("No port selected by the user.");
        err.name = "NotFoundError";
        throw err;
      },
    });
    try {
      await assert.rejects(
        connectSerialNmea({ baudRate: 9600 }, { onFix: () => {}, onError: () => {} }),
        (err: unknown) => err instanceof NmeaError && err.cancelled && err.code === "cancelled",
      );
    } finally {
      restoreNavigator();
    }
  });
});

/**
 * A stand-in for the native Android plugin: records invokes and lets the test
 * push channel events, so the transport, parser, and assembler run for real.
 */
function fakeBridge(responses: Record<string, (args?: Record<string, unknown>) => unknown> = {}): {
  bridge: NativeBluetoothBridge;
  calls: { cmd: string; args?: Record<string, unknown> }[];
  push: (
    event:
      | { event: "data"; data: string }
      | { event: "closed"; error?: string }
      | { event: "ntrip"; state: string; bytes: number; message?: string; code?: string },
  ) => void;
} {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  let listener: ((event: never) => void) | null = null;
  const bridge: NativeBluetoothBridge = {
    invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const respond = responses[cmd];
      return (respond ? await respond(args) : undefined) as T;
    },
    createChannel: (onMessage) => {
      listener = onMessage as (event: never) => void;
      return { id: "fake-channel" };
    },
  };
  return {
    bridge,
    calls,
    push: (event) => {
      assert.ok(listener, "no channel was created");
      listener(event as never);
    },
  };
}

const CONNECT = "plugin:gnss-bluetooth|connect";
const DISCONNECT = "plugin:gnss-bluetooth|disconnect";
const LIST = "plugin:gnss-bluetooth|list_devices";
const receiver = { address: "00:11:22:33:44:55", name: "TX2" };

describe("connectAndroidBluetoothNmea", () => {
  it("streams fixes from channel data split mid-sentence", async () => {
    const fake = fakeBridge({ [CONNECT]: () => ({ id: 7, name: "TX2 rover" }) });
    const fixes: GpsFix[] = [];
    const conn = await connectAndroidBluetoothNmea(
      receiver,
      { onFix: (f) => fixes.push(f), onError: () => {} },
      fake.bridge,
    );
    assert.equal(conn.label, "TX2 rover");
    assert.deepEqual(fake.calls[0].args, {
      address: receiver.address,
      channel: { id: "fake-channel" },
    });
    const stream = epoch("174512.00") + epoch("174513.00");
    fake.push({ event: "data", data: stream.slice(0, 50) });
    fake.push({ event: "data", data: stream.slice(50) });
    assert.equal(fixes.length, 1, "one completed epoch across the split");
    assert.ok(Math.abs(fixes[0].lat - 35.9590533) < 1e-6);
    await conn.close();
    assert.deepEqual(fake.calls.at(-1), { cmd: DISCONNECT, args: { id: 7 } });
  });

  it("reports a dropped socket once and delivers nothing after close", async () => {
    const fake = fakeBridge({ [CONNECT]: () => ({ id: 1, name: "TX2" }) });
    const errors: NmeaError[] = [];
    const fixes: GpsFix[] = [];
    await connectAndroidBluetoothNmea(
      receiver,
      { onFix: (f) => fixes.push(f), onError: (e) => errors.push(e) },
      fake.bridge,
    );
    fake.push({ event: "closed", error: "socket closed" });
    fake.push({ event: "data", data: epoch("174512.00") + epoch("174513.00") });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "disconnected");
    assert.equal(fixes.length, 0);
  });

  it("starts corrections with a normalized config and relays status events", async () => {
    const fake = fakeBridge({ [CONNECT]: () => ({ id: 3, name: "TX2" }) });
    const conn = await connectAndroidBluetoothNmea(
      receiver,
      { onFix: () => {}, onError: () => {} },
      fake.bridge,
    );
    assert.ok(conn.corrections, "the Android transport can take corrections");
    const statuses: unknown[] = [];
    await conn.corrections.start(
      {
        host: "http://caster.example.com:2102/",
        port: 2101,
        mountpoint: "/MOUNT",
        username: "u",
        password: "p",
        tls: true,
      },
      (s) => statuses.push(s),
    );
    assert.deepEqual(fake.calls.at(-1), {
      cmd: "plugin:gnss-bluetooth|start_corrections",
      args: {
        id: 3,
        host: "caster.example.com",
        port: 2102,
        mountpoint: "MOUNT",
        username: "u",
        password: "p",
        tls: true,
      },
    });
    fake.push({ event: "ntrip", state: "connected", bytes: 512 });
    fake.push({ event: "ntrip", state: "error", bytes: 512, message: "bad", code: "AUTH_FAILED" });
    assert.deepEqual(statuses, [
      { state: "connected", bytes: 512, message: undefined, code: undefined },
      { state: "error", bytes: 512, message: "bad", code: "auth-failed" },
    ]);
    await conn.corrections.stop();
    assert.deepEqual(fake.calls.at(-1), {
      cmd: "plugin:gnss-bluetooth|stop_corrections",
      args: { id: 3 },
    });
    fake.push({ event: "ntrip", state: "connected", bytes: 1024 });
    assert.equal(statuses.length, 2, "no status after stop");
  });

  it("maps native rejection codes to NmeaError codes", async () => {
    const cases: [string, string][] = [
      ["DISABLED", "bluetooth-off"],
      ["PERMISSION_DENIED", "permission-denied"],
      ["CONNECT_FAILED", "connect-failed"],
      ["UNAVAILABLE", "unavailable"],
      ["BUSY", "busy"],
      ["NOT_PAIRED", "not-paired"],
      ["SOMETHING_ELSE", "failed"],
    ];
    for (const [nativeCode, code] of cases) {
      const fake = fakeBridge({
        [CONNECT]: () => Promise.reject({ message: "nope", code: nativeCode }),
      });
      await assert.rejects(
        connectAndroidBluetoothNmea(receiver, { onFix: () => {}, onError: () => {} }, fake.bridge),
        (err: unknown) => err instanceof NmeaError && err.code === code && err.message === "nope",
      );
    }
  });

  it("lists paired devices with classic receivers before BLE-only ones", async () => {
    const fake = fakeBridge({
      [LIST]: () => ({
        devices: [
          { address: "a", name: "Watch", type: "le" },
          { address: "b", name: "Zed rover", type: "classic" },
          { address: "c", name: "Alpha rover", type: "dual" },
        ],
      }),
    });
    const devices = await listPairedBluetoothDevices(fake.bridge);
    assert.deepEqual(
      devices.map((d) => d.name),
      ["Alpha rover", "Zed rover", "Watch"],
    );
  });
});
