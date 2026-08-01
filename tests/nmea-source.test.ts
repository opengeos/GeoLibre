import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nmeaChecksum } from "../apps/geolibre-desktop/src/lib/nmea";
import type { GpsFix } from "../apps/geolibre-desktop/src/lib/gps-tracking";
import {
  connectSerialNmea,
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
  const previous = Object.getOwnPropertyDescriptor(globalThis.navigator, "serial");
  Object.defineProperty(globalThis.navigator, "serial", {
    configurable: true,
    value: { requestPort: async () => makePort() },
  });
  return {
    port: () => {
      assert.ok(fake, "no port was requested");
      return fake;
    },
    restore: () => {
      if (previous) Object.defineProperty(globalThis.navigator, "serial", previous);
      else Reflect.deleteProperty(globalThis.navigator as object, "serial");
    },
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
    const previous = Object.getOwnPropertyDescriptor(globalThis.navigator, "serial");
    Object.defineProperty(globalThis.navigator, "serial", {
      configurable: true,
      value: {
        requestPort: async () => {
          // What Chromium throws when the user dismisses the port picker.
          const err = new Error("No port selected by the user.");
          err.name = "NotFoundError";
          throw err;
        },
      },
    });
    try {
      await assert.rejects(
        connectSerialNmea({ baudRate: 9600 }, { onFix: () => {}, onError: () => {} }),
        (err: unknown) => err instanceof NmeaError && err.cancelled && err.code === "cancelled",
      );
    } finally {
      if (previous) Object.defineProperty(globalThis.navigator, "serial", previous);
      else Reflect.deleteProperty(globalThis.navigator as object, "serial");
    }
  });
});
