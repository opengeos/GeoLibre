import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fixFromPosition, type GpsFix } from "../lib/gps-tracking";
import { watchPosition } from "../lib/geolocation";
import type { NmeaStreamStats } from "../lib/nmea";
import {
  connectAndroidBluetoothNmea,
  connectBluetoothNmea,
  connectSerialNmea,
  DEFAULT_NMEA_BAUD_RATE,
  NMEA_BAUD_RATES,
  NmeaError,
  type NmeaConnection,
  type PairedBluetoothDevice,
} from "../lib/nmea-source";
import { nmeaErrorText } from "../lib/gps-nmea-errors";
import { useNtripCorrections } from "./useNtripCorrections";
import { logGpsFailure } from "../lib/gps-diagnostics";

const NMEA_BAUD_STORAGE_KEY = "geolibre.gpsTracking.nmeaBaudRate";

/** Release a receiver without leaking a rejected cleanup promise. */
async function releaseConnection(connection: NmeaConnection | null): Promise<void> {
  try {
    await connection?.close();
  } catch (error) {
    logGpsFailure("GPS: the NMEA receiver did not close cleanly", error, "warning");
  }
}

/**
 * Where fixes come from: the device's own Geolocation API, or an external NMEA
 * 0183 receiver on a serial port or Bluetooth (issue #1617). Both feed the same
 * {@link GpsFix} pipeline, so tracking, recording, and export are identical.
 */
export type PositionSource = "device" | "nmea";

/**
 * How an NMEA receiver is reached. See lib/nmea-source.ts for why each exists;
 * `android-bluetooth` is the native plugin the Android app uses (issue #3397).
 */
export type NmeaTransport = "serial" | "bluetooth" | "android-bluetooth";

function loadStoredBaudRate(): number {
  try {
    const raw = Number(window.localStorage.getItem(NMEA_BAUD_STORAGE_KEY));
    if ((NMEA_BAUD_RATES as readonly number[]).includes(raw)) return raw;
  } catch {
    // Corrupt or unavailable storage falls through to the default.
  }
  return DEFAULT_NMEA_BAUD_RATE;
}

interface GpsPositionSourceOptions {
  onFix: (fix: GpsFix) => void;
  onError: (message: string | null) => void;
  /** Clear a prior action notice when the user changes or starts a session. */
  onActivity: () => void;
}

/** Own positioning and corrections independently of dialog visibility. */
export function useGpsPositionSource({
  onFix: handleFix,
  onError: reportError,
  onActivity,
}: GpsPositionSourceOptions) {
  const { t } = useTranslation();
  const [tracking, setTracking] = useState(false);
  const [source, setSource] = useState<PositionSource>("device");
  const [baudRate, setBaudRate] = useState<number>(loadStoredBaudRate);
  /** Non-null exactly while an NMEA receiver is connected; holds its label. */
  const [nmeaLabel, setNmeaLabel] = useState<string | null>(null);
  const [nmeaStats, setNmeaStats] = useState<NmeaStreamStats | null>(null);
  const [connecting, setConnecting] = useState<NmeaTransport | null>(null);
  const nmeaConnRef = useRef<NmeaConnection | null>(null);
  /**
   * NTRIP corrections (issue #3400). Held here rather than in the dialog body
   * because the dialog content unmounts when it closes while the receiver and
   * its correction stream keep running.
   */
  const ntrip = useNtripCorrections(nmeaConnRef);
  const { reset: resetNtrip, resumeFor: resumeNtripFor } = ntrip;
  /** Whether the connected receiver's transport can take corrections. */
  const [nmeaHasCorrections, setNmeaHasCorrections] = useState(false);
  /**
   * Bumped whenever an in-flight connect is superseded by another connect, a
   * source change, stopping, or unmount. A Bluetooth `gatt.connect()` can stay
   * pending for seconds, and nothing stops the user abandoning it meanwhile, so
   * a late success must close itself rather than silently reactivating a
   * session the user believes is over (or leaking a port opened after unmount).
   */
  const connectGenerationRef = useRef(0);

  // The watchPosition subscription follows `tracking`, and only runs for the
  // device source. An NMEA receiver drives handleFix from its own stream
  // instead. On Tauri mobile this routes through the native geolocation plugin
  // (which requests the OS location permission first); elsewhere it wraps
  // navigator.geolocation. Starting a native watch is async, so the effect
  // tracks cancellation and unsubscribes once the watch resolves. See
  // lib/geolocation.ts.
  useEffect(() => {
    if (!tracking || source !== "device") return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    watchPosition(
      (pos) => {
        if (!cancelled) handleFix(fixFromPosition(pos));
      },
      (err) => {
        if (cancelled) return;
        if (err.permissionDenied) {
          reportError(t("gps.permissionDenied"));
          setTracking(false);
        } else {
          // Transient (no signal / timeout): keep watching, tell the user.
          reportError(t("gps.waitingForFix"));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    )
      .then((unsub) => {
        if (cancelled) unsub();
        else unsubscribe = unsub;
      })
      .catch((err) => {
        if (cancelled) return;
        // A denied permission is the user's choice; anything else is a real
        // failure hidden behind the generic "no geolocation" message.
        if (!err?.permissionDenied) logGpsFailure("GPS: starting the position watch failed", err);
        reportError(t(err?.permissionDenied ? "gps.permissionDenied" : "gps.noGeolocation"));
        setTracking(false);
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [tracking, source, handleFix, reportError, t]);

  /**
   * Stop tracking, release the live connection, and clear its readout, leaving
   * the generation alone. Split from {@link disconnectNmea} so a connect attempt can close a
   * previous connection without invalidating the generation it just claimed.
   */
  const closeNmea = useCallback(async () => {
    const conn = nmeaConnRef.current;
    nmeaConnRef.current = null;
    setTracking(false);
    setNmeaLabel(null);
    setNmeaStats(null);
    // Closing the receiver ends its correction session natively.
    resetNtrip();
    setNmeaHasCorrections(false);
    await releaseConnection(conn);
  }, [resetNtrip]);

  /** Abandon any in-flight connect as well as closing the live connection. */
  const disconnectNmea = useCallback(async () => {
    connectGenerationRef.current += 1;
    // Clearing the indicator belongs on the abandon path rather than in
    // connectNmea's `finally`: an attempt abandoned by a source change or a
    // stop is stale by the time it resolves, so that `finally` deliberately
    // skips it, and the buttons would stay disabled showing "Connecting…" for
    // the rest of the session.
    setConnecting(null);
    await closeNmea();
  }, [closeNmea]);

  /**
   * Open an NMEA receiver and start tracking from it. Both transports show a
   * browser device chooser, so this must run from a user gesture; a dismissed
   * chooser is a deliberate "never mind" and is not surfaced as an error.
   */
  const connectNmea = useCallback(
    async (transport: NmeaTransport, device?: PairedBluetoothDevice) => {
      reportError(null);
      onActivity();
      // Claim a generation synchronously, before the first await: closing the
      // previous connection suspends, and two invocations that both captured
      // afterwards would read the same value and both believe they are current.
      const generation = ++connectGenerationRef.current;
      const isStale = () => generation !== connectGenerationRef.current;
      // Show the indicator before the first await, so there is no window in
      // which an attempt is in flight but the buttons look idle. Closing a
      // live connection below can take real time. closeNmea deliberately does
      // not clear it; only the abandon path (disconnectNmea) does.
      setConnecting(transport);
      // Closes the previous connection without invalidating the generation
      // just claimed, and cannot reject (closeNmea swallows close failures).
      await closeNmea();
      if (isStale()) return;
      try {
        const handlers = {
          // Both callbacks are generation-guarded: the transport starts reading
          // before this function commits the connection, so a superseded
          // attempt could otherwise re-create overlays teardown had cleared, or
          // tear down a newer connection that replaced it.
          onFix: (fix: GpsFix) => {
            if (!isStale()) handleFix(fix);
          },
          // A dropped device or a read failure stops the session rather than
          // leaving a stale position on the map.
          onError: (err: NmeaError) => {
            if (isStale()) return;
            reportError(nmeaErrorText(err, t));
            setTracking(false);
            void disconnectNmea();
          },
        };
        let conn: NmeaConnection;
        if (transport === "serial") conn = await connectSerialNmea({ baudRate }, handlers);
        else if (transport === "android-bluetooth") {
          // Never fall through to Web Bluetooth here: it does not exist in the
          // Android WebView, so its error would misdescribe the failure.
          if (!device) throw new NmeaError(t("gps.nmeaConnectFailed"));
          conn = await connectAndroidBluetoothNmea(device, handlers);
        } else conn = await connectBluetoothNmea(handlers);
        if (isStale()) {
          // The user moved on while the device was still opening: release it
          // rather than resurrecting a session they already abandoned.
          await releaseConnection(conn);
          return;
        }
        nmeaConnRef.current = conn;
        setNmeaLabel(conn.label);
        setNmeaStats(conn.stats());
        setNmeaHasCorrections(conn.corrections != null);
        setTracking(true);
        // Corrections that were running when this receiver was last used
        // come back on their own, as they do in a dedicated field app.
        resumeNtripFor(conn);
      } catch (err) {
        if (isStale()) return;
        if (err instanceof NmeaError) {
          if (!err.cancelled) reportError(nmeaErrorText(err, t));
        } else {
          reportError(err instanceof Error ? err.message : t("gps.nmeaConnectFailed"));
        }
      } finally {
        // A superseded attempt must not clear the newer attempt's indicator;
        // one abandoned by a source change or a stop already had it reset by
        // disconnectNmea itself.
        if (!isStale()) setConnecting(null);
      }
    },
    [baudRate, closeNmea, disconnectNmea, handleFix, resumeNtripFor, t, reportError, onActivity],
  );

  // Poll the assembler's counters while connected so the readout shows the
  // stream is alive even before the first usable fix arrives.
  useEffect(() => {
    if (!nmeaLabel) return;
    const id = window.setInterval(() => {
      setNmeaStats(nmeaConnRef.current?.stats() ?? null);
    }, 1000);
    return () => window.clearInterval(id);
  }, [nmeaLabel]);

  const updateBaudRate = useCallback((next: number) => {
    setBaudRate(next);
    try {
      window.localStorage.setItem(NMEA_BAUD_STORAGE_KEY, String(next));
    } catch {
      // Best-effort persistence; the session keeps the in-memory value.
    }
  }, []);

  /** Switching source ends the current session so no stale fixes linger. */
  const changeSource = useCallback(
    (next: PositionSource) => {
      if (next === source) return;
      setSource(next);
      setTracking(false);
      void disconnectNmea();
      reportError(null);
      onActivity();
    },
    [source, disconnectNmea, reportError, onActivity],
  );

  /**
   * Whether anything can actually feed {@link handleFix} right now. The device
   * watch starts on demand, but an NMEA receiver has to be connected first;
   * otherwise starting a recording produces a session that silently logs
   * nothing, reports no error, and hides the "connect a receiver" hint.
   */
  const canTrack = source === "device" || nmeaLabel != null;

  const handleStart = useCallback(() => {
    if (!canTrack) return;
    reportError(null);
    onActivity();
    setTracking(true);
  }, [canTrack, reportError, onActivity]);

  const handleStop = useCallback(() => {
    setTracking(false);
    void disconnectNmea();
  }, [disconnectNmea]);

  // Release the serial port / GATT server so a remount can reopen it, and mark
  // in-flight connects stale so a receiver arriving after unmount closes itself.
  useEffect(
    () => () => {
      connectGenerationRef.current += 1;
      const connection = nmeaConnRef.current;
      nmeaConnRef.current = null;
      void releaseConnection(connection);
    },
    [],
  );

  return {
    tracking,
    source,
    baudRate,
    nmeaLabel,
    nmeaStats,
    connecting,
    ntrip,
    nmeaHasCorrections,
    updateBaudRate,
    changeSource,
    canTrack,
    handleStart,
    handleStop,
    connectNmea,
    disconnectNmea,
  };
}
