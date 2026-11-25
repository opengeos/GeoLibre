import { type RefObject, useCallback, useRef, useState } from "react";
import { appendDiagnostic, formatUnknown } from "../lib/diagnostics";
import type { NmeaConnection } from "../lib/nmea-source";
import {
  loadNtripSettings,
  normalizeNtripConfig,
  ntripConfigProblem,
  ntripSessionRunning,
  saveNtripSettings,
  type NtripConfig,
  type NtripStatus,
  type StoredNtripSettings,
} from "../lib/ntrip";

/**
 * NTRIP session state for the receiver in `connRef` (issue #3400). Lives in
 * the always-mounted GPS component, so closing the dialog neither stops nor
 * restarts a session. `status` is null when no session runs for the current
 * receiver.
 */
export function useNtripCorrections(connRef: RefObject<NmeaConnection | null>) {
  const [settings, setSettingsState] = useState<StoredNtripSettings>(loadNtripSettings);
  const settingsRef = useRef(settings);
  const [status, setStatus] = useState<NtripStatus | null>(null);

  const update = useCallback((next: StoredNtripSettings) => {
    settingsRef.current = next;
    setSettingsState(next);
    saveNtripSettings(next);
  }, []);

  /**
   * Start the session for `conn`. Status from a receiver that has since been
   * replaced is dropped, and a `stopped` that follows a fatal error keeps the
   * error on screen so the user can see why it stopped.
   */
  const startFor = useCallback(
    async (conn: NmeaConnection, config: NtripConfig) => {
      if (!conn.corrections) return;
      setStatus({ state: "connecting", bytes: 0 });
      try {
        await conn.corrections.start(config, (next) => {
          if (connRef.current !== conn) return;
          setStatus((prev) => (next.state === "stopped" && prev?.state === "error" ? prev : next));
          // A fatal stop (bad login, unknown mountpoint, TLS) must not start
          // again on its own at the next connect.
          if (next.state === "error" && !ntripSessionRunning(next))
            update({ ...settingsRef.current, autoStart: false });
        });
      } catch (err) {
        if (connRef.current !== conn) return;
        setStatus({
          state: "error",
          bytes: 0,
          // Not "failed": that means the native client is retrying, and here
          // it never started, so the form must unlock rather than show Stop.
          code: "not-started",
          message: err instanceof Error ? err.message : String(err),
        });
        appendDiagnostic({
          category: "runtime",
          level: "warning",
          message: "GPS: could not start NTRIP corrections",
          detail: formatUnknown(err),
          source: "gps-tracking",
        });
      }
    },
    [connRef, update],
  );

  const start = useCallback(() => {
    const conn = connRef.current;
    const current = settingsRef.current;
    if (!conn?.corrections || ntripConfigProblem(current.config)) return;
    // Show what is actually sent: a pasted "http://host:2102/" becomes host
    // and port, and a leading slash leaves the mountpoint.
    const config = normalizeNtripConfig(current.config);
    update({ config, autoStart: true });
    void startFor(conn, config);
  }, [connRef, startFor, update]);

  const stop = useCallback(() => {
    update({ ...settingsRef.current, autoStart: false });
    setStatus(null);
    void connRef.current?.corrections?.stop();
  }, [connRef, update]);

  /**
   * Called once a receiver connects: corrections that were running when it
   * was last used come back on their own, as they do in a dedicated field app.
   */
  const resumeFor = useCallback(
    (conn: NmeaConnection) => {
      const stored = settingsRef.current;
      if (conn.corrections && stored.autoStart && !ntripConfigProblem(stored.config))
        void startFor(conn, stored.config);
    },
    [startFor],
  );

  const setConfig = useCallback(
    (config: NtripConfig) => update({ ...settingsRef.current, config }),
    [update],
  );

  /** The receiver closed, which ends its session natively. */
  const reset = useCallback(() => setStatus(null), []);

  return { settings, status, setConfig, start, stop, resumeFor, reset };
}
