import { act, cleanup } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { renderHook } from "@testing-library/react";
import { NmeaAssembler } from "../apps/geolibre-desktop/src/lib/nmea";
import type { NmeaConnection } from "../apps/geolibre-desktop/src/lib/nmea-source";
import {
  DEFAULT_NTRIP_CONFIG,
  loadNtripSettings,
  type NtripConfig,
  type NtripStatus,
} from "../apps/geolibre-desktop/src/lib/ntrip";

const { useNtripCorrections } =
  await import("../apps/geolibre-desktop/src/hooks/useNtripCorrections");
const config = { ...DEFAULT_NTRIP_CONFIG, host: "caster.example", mountpoint: "/RTCM" };

function receiver(label: string) {
  const starts: NtripConfig[] = [];
  let report: ((status: NtripStatus) => void) | null = null;
  let stops = 0;
  const connection: NmeaConnection = {
    label,
    stats: () => new NmeaAssembler().getStats(),
    close: async () => {},
    corrections: {
      async start(value, onStatus) {
        starts.push(value);
        report = onStatus;
      },
      async stop() {
        stops += 1;
      },
    },
  };
  return {
    connection,
    starts,
    stopCount: () => stops,
    emit(status: NtripStatus) {
      assert.ok(report);
      report(status);
    },
  };
}

afterEach(cleanup);

it("resumes corrections for a replacement receiver and ignores the old receiver's status", async () => {
  const first = receiver("First");
  const ref: { current: NmeaConnection | null } = { current: first.connection };
  const hook = renderHook(() => useNtripCorrections(ref));
  act(() => hook.result.current.setConfig(config));
  await act(async () => hook.result.current.start());
  assert.equal(first.starts.length, 1);
  assert.equal(first.starts[0].mountpoint, "RTCM");
  assert.equal(loadNtripSettings().autoStart, true);
  act(() => first.emit({ state: "connected", bytes: 128 }));
  assert.equal(hook.result.current.status?.bytes, 128);
  const second = receiver("Second");
  ref.current = second.connection;
  act(() => hook.result.current.reset());
  await act(async () => hook.result.current.resumeFor(second.connection));
  assert.equal(second.starts.length, 1);
  act(() => first.emit({ state: "error", code: "auth-failed", bytes: 0 }));
  assert.equal(hook.result.current.settings.autoStart, true);
  assert.equal(hook.result.current.status?.state, "connecting");
  act(() => second.emit({ state: "connected", bytes: 512 }));
  assert.equal(hook.result.current.status?.bytes, 512);
  await act(async () => hook.result.current.stop());
  assert.equal(second.stopCount(), 1);
  assert.equal(hook.result.current.status, null);
  assert.equal(loadNtripSettings().autoStart, false);
});

it("keeps a fatal authentication failure visible and prevents reconnect from resuming it", async () => {
  const first = receiver("First");
  const ref: { current: NmeaConnection | null } = { current: first.connection };
  const hook = renderHook(() => useNtripCorrections(ref));
  act(() => hook.result.current.setConfig(config));
  await act(async () => hook.result.current.start());
  act(() => first.emit({ state: "error", code: "auth-failed", bytes: 0 }));
  act(() => first.emit({ state: "stopped", bytes: 0 }));
  assert.equal(hook.result.current.status?.state, "error");
  assert.equal(hook.result.current.status?.code, "auth-failed");
  assert.equal(loadNtripSettings().autoStart, false);
  const second = receiver("Second");
  ref.current = second.connection;
  act(() => hook.result.current.reset());
  await act(async () => hook.result.current.resumeFor(second.connection));
  assert.equal(second.starts.length, 0);
  assert.equal(hook.result.current.status, null);
});
