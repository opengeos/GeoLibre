import { act, cleanup, i18n, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { renderHook } from "@testing-library/react";
import type { GpsFix } from "../apps/geolibre-desktop/src/lib/gps-tracking";
import { nmeaChecksum } from "../apps/geolibre-desktop/src/lib/nmea";
import {
  clearDiagnostics,
  getDiagnosticsSnapshot,
} from "../apps/geolibre-desktop/src/lib/diagnostics";

const { useGpsPositionSource } =
  await import("../apps/geolibre-desktop/src/hooks/useGpsPositionSource");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

interface Watch {
  fix: PositionCallback;
  error?: PositionErrorCallback | null;
}

function installHardware(serial?: unknown) {
  const watches: Watch[] = [];
  const cleared: number[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "GPS session test",
      geolocation: {
        watchPosition(fix: PositionCallback, error?: PositionErrorCallback | null) {
          watches.push({ fix, error });
          return watches.length;
        },
        clearWatch(id: number) {
          cleared.push(id);
        },
      },
      ...(serial ? { serial } : {}),
    },
  });
  return { watches, cleared };
}

function position(): GeolocationPosition {
  return {
    coords: {
      latitude: 35.95,
      longitude: -83.92,
      accuracy: 2,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp: 1000,
    toJSON: () => ({}),
  };
}

function positionError(code: 1 | 2 | 3): GeolocationPositionError {
  return {
    code,
    message: "injected device error",
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  };
}

function receiver() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const opened: number[] = [];
  let closes = 0;
  return {
    port: {
      readable,
      async open(options: { baudRate: number }) {
        opened.push(options.baudRate);
      },
      async close() {
        closes += 1;
      },
    },
    controller,
    opened,
    closeCount: () => closes,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function renderSource() {
  const fixes: GpsFix[] = [];
  const errors: (string | null)[] = [];
  const onFix = (fix: GpsFix) => {
    fixes.push(fix);
  };
  const onError = (error: string | null) => {
    errors.push(error);
  };
  const onActivity = () => {};
  const hook = renderHook(() => useGpsPositionSource({ onFix, onError, onActivity }));
  return { ...hook, fixes, errors };
}

afterEach(() => {
  cleanup();
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

it("owns device permission errors and ignores callbacks after stopping the watch", async () => {
  const hardware = installHardware();
  const hook = renderSource();
  await act(async () => hook.result.current.handleStart());
  assert.equal(hook.result.current.tracking, true);
  assert.equal(hardware.watches.length, 1);
  act(() => hardware.watches[0].fix(position()));
  assert.equal(hook.fixes.length, 1);
  act(() => hardware.watches[0].error?.(positionError(2)));
  assert.equal(hook.result.current.tracking, true);
  assert.equal(hook.errors.at(-1), i18n.t("gps.waitingForFix"));
  await act(async () => hardware.watches[0].error?.(positionError(1)));
  assert.equal(hook.result.current.tracking, false);
  assert.deepEqual(hardware.cleared, [1]);
  assert.equal(hook.errors.at(-1), i18n.t("gps.permissionDenied"));
  const errors = hook.errors.length;
  act(() => {
    hardware.watches[0].fix(position());
    hardware.watches[0].error?.(positionError(2));
  });
  assert.equal(hook.fixes.length, 1);
  assert.equal(hook.errors.length, errors);
});

it("releases the device watch on a source change and requires a receiver before starting NMEA", async () => {
  const hardware = installHardware();
  const hook = renderSource();
  await act(async () => hook.result.current.handleStart());
  await act(async () => hook.result.current.changeSource("nmea"));
  assert.deepEqual(hardware.cleared, [1]);
  assert.equal(hook.result.current.tracking, false);
  assert.equal(hook.result.current.canTrack, false);
  act(() => hook.result.current.handleStart());
  assert.equal(hook.result.current.tracking, false);
  act(() => hardware.watches[0].fix(position()));
  assert.equal(hook.fixes.length, 0);
});

it("closes a receiver selected after stop without reviving tracking", async () => {
  const chosen = deferred<ReturnType<typeof receiver>["port"]>();
  let requests = 0;
  installHardware({
    requestPort: () => {
      requests += 1;
      return chosen.promise;
    },
  });
  const hook = renderSource();
  act(() => hook.result.current.changeSource("nmea"));
  let connecting!: Promise<void>;
  await act(async () => {
    connecting = hook.result.current.connectNmea("serial");
  });
  assert.equal(requests, 1);
  assert.equal(hook.result.current.connecting, "serial");
  await act(async () => hook.result.current.handleStop());
  assert.equal(hook.result.current.connecting, null);
  const late = receiver();
  await act(async () => {
    chosen.resolve(late.port);
    await connecting;
  });
  assert.equal(late.closeCount(), 1);
  assert.equal(hook.result.current.tracking, false);
  assert.equal(hook.result.current.nmeaLabel, null);
  assert.equal(hook.errors.filter(Boolean).length, 0);
});

it("keeps the newer connection when an older chooser resolves last", async () => {
  const firstChoice = deferred<ReturnType<typeof receiver>["port"]>();
  const secondChoice = deferred<ReturnType<typeof receiver>["port"]>();
  let requests = 0;
  installHardware({
    requestPort: () => (++requests === 1 ? firstChoice.promise : secondChoice.promise),
  });
  const hook = renderSource();
  act(() => hook.result.current.changeSource("nmea"));
  let first!: Promise<void>;
  await act(async () => {
    first = hook.result.current.connectNmea("serial");
  });
  act(() => hook.result.current.updateBaudRate(19200));
  let second!: Promise<void>;
  await act(async () => {
    second = hook.result.current.connectNmea("serial");
  });
  const current = receiver();
  await act(async () => {
    secondChoice.resolve(current.port);
    await second;
  });
  assert.deepEqual(current.opened, [19200]);
  assert.equal(hook.result.current.tracking, true);
  assert.equal(hook.result.current.nmeaLabel, "Serial @ 19200 baud");
  const stale = receiver();
  await act(async () => {
    firstChoice.resolve(stale.port);
    await first;
  });
  assert.equal(stale.closeCount(), 1);
  assert.equal(current.closeCount(), 0);
  assert.equal(hook.result.current.nmeaLabel, "Serial @ 19200 baud");
  await act(async () => hook.result.current.disconnectNmea());
  assert.equal(current.closeCount(), 1);
  assert.equal(hook.result.current.nmeaLabel, null);
});

it("treats device chooser cancellation as cancellation and clears its indicator", async () => {
  installHardware({
    requestPort: async () => {
      throw new DOMException("No selection", "NotFoundError");
    },
  });
  const hook = renderSource();
  act(() => hook.result.current.changeSource("nmea"));
  await act(async () => hook.result.current.connectNmea("serial"));
  assert.equal(hook.result.current.connecting, null);
  assert.equal(hook.result.current.tracking, false);
  assert.equal(hook.errors.filter(Boolean).length, 0);
});

it("ends tracking and releases its receiver when the stream disconnects", async () => {
  const live = receiver();
  installHardware({ requestPort: async () => live.port });
  const hook = renderSource();
  act(() => hook.result.current.changeSource("nmea"));
  await act(async () => hook.result.current.connectNmea("serial"));
  assert.equal(hook.result.current.tracking, true);
  await act(async () => live.controller.close());
  await waitFor(() => assert.equal(hook.result.current.tracking, false));
  assert.equal(hook.result.current.nmeaLabel, null);
  assert.equal(hook.result.current.nmeaStats, null);
  assert.equal(live.closeCount(), 1);
  assert.equal(hook.errors.at(-1), i18n.t("gps.nmeaDisconnected"));
});

it("delivers real assembled NMEA fixes through the same position callback", async () => {
  const live = receiver();
  installHardware({ requestPort: async () => live.port });
  const hook = renderSource();
  act(() => hook.result.current.changeSource("nmea"));
  await act(async () => hook.result.current.connectNmea("serial"));
  const sentence = (payload: string) => `$${payload}*${nmeaChecksum(payload)}\r\n`;
  const epoch = (time: string) =>
    sentence(`GNGGA,${time},3557.5432,N,08355.1234,W,1,09,0.92,268.4,M,-33.2,M,,`) +
    sentence(`GNRMC,${time},A,3557.5432,N,08355.1234,W,4.5,187.3,010826,,,A`);
  await act(async () =>
    live.controller.enqueue(new TextEncoder().encode(epoch("174512.00") + epoch("174513.00"))),
  );
  await waitFor(() => assert.equal(hook.fixes.length, 1));
  assert.ok(Math.abs(hook.fixes[0].lat - 35.9590533) < 1e-6);
  assert.equal(hook.fixes[0].satellites, 9);
  await act(async () => hook.result.current.handleStop());
  assert.equal(live.closeCount(), 1);
});

it("reports an unavailable device source with a localized error and diagnostic", async () => {
  clearDiagnostics();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "No GPS" },
  });
  const hook = renderSource();
  await act(async () => hook.result.current.handleStart());
  assert.equal(hook.result.current.tracking, false);
  assert.equal(hook.errors.at(-1), i18n.t("gps.noGeolocation"));
  assert.equal(
    getDiagnosticsSnapshot().records.some(
      (record) =>
        record.source === "gps-tracking" &&
        record.message === "GPS: starting the position watch failed",
    ),
    true,
  );
});

it("releases a connection that finishes opening after unmount", async () => {
  const chosen = deferred<ReturnType<typeof receiver>["port"]>();
  installHardware({ requestPort: () => chosen.promise });
  const hook = renderSource();
  act(() => hook.result.current.changeSource("nmea"));
  let connecting!: Promise<void>;
  await act(async () => {
    connecting = hook.result.current.connectNmea("serial");
  });
  hook.unmount();
  const late = receiver();
  await act(async () => {
    chosen.resolve(late.port);
    await connecting;
  });
  assert.equal(late.closeCount(), 1);
  assert.equal(hook.fixes.length, 0);
});
