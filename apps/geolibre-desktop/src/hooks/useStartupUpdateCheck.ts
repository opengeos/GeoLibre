import { useCallback, useEffect, useState } from "react";
import { isTauri } from "../lib/is-tauri";
import {
  UPDATE_DISMISSED_VERSION_STORAGE_KEY,
  UPDATE_LAST_CHECK_STORAGE_KEY,
} from "../lib/storage-keys";
import {
  APP_VERSION,
  fetchLatestRelease,
  meetsNotificationLevel,
  releaseSeverity,
  UpdateCheckError,
  type LatestRelease,
  type ReleaseSeverity,
} from "../lib/updates";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/** A pending update surfaced by the automated startup check. */
export interface PendingUpdate {
  release: LatestRelease;
  severity: ReleaseSeverity;
}

/**
 * Minimum gap between automated startup checks. The unauthenticated GitHub API
 * allows 60 requests/hour per IP; throttling to a few per day keeps frequent
 * relaunches from exhausting that quota.
 */
const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;

function readLastCheck(): number {
  if (typeof window === "undefined") return 0;
  try {
    return Number(
      window.localStorage.getItem(UPDATE_LAST_CHECK_STORAGE_KEY) ?? 0,
    );
  } catch {
    return 0;
  }
}

function writeLastCheck(timestamp: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      UPDATE_LAST_CHECK_STORAGE_KEY,
      String(timestamp),
    );
  } catch {
    // Best-effort: ignore quota or disabled-storage errors.
  }
}

function readDismissedVersion(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(UPDATE_DISMISSED_VERSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissedVersion(version: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UPDATE_DISMISSED_VERSION_STORAGE_KEY, version);
  } catch {
    // Best-effort: ignore quota or disabled-storage errors.
  }
}

/**
 * Run an automated update check once on app startup (desktop build only) and
 * expose any notify-worthy newer release for the startup prompt.
 *
 * The check is skipped entirely on the web build, when the user disabled
 * "Check for updates on startup", when the latest release is not newer, when it
 * does not meet the chosen notification granularity, or when the user already
 * skipped that exact version. Network and parsing failures are swallowed so a
 * background check never disrupts launch.
 *
 * @returns The pending update (or `null`), plus actions to dismiss it for this
 *   session (`remindLater`) or to suppress it permanently (`skipVersion`).
 */
export function useStartupUpdateCheck() {
  const [pending, setPending] = useState<PendingUpdate | null>(null);

  useEffect(() => {
    // Automated startup checks are a desktop-only feature; the web build
    // refreshes to the latest version on reload and needs no prompt.
    if (!isTauri()) return;

    const settings =
      useDesktopSettingsStore.getState().desktopSettings.updates;
    if (!settings.checkOnStartup) return;

    // Throttle the network call so frequent relaunches don't burn the GitHub
    // rate limit. Stamp the time up front so even a server response that fails
    // (rate limit, HTTP error) counts toward the window and prevents hammering.
    const now = Date.now();
    const previousLastCheck = readLastCheck();
    if (now - previousLastCheck < CHECK_THROTTLE_MS) return;
    writeLastCheck(now);

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const release = await fetchLatestRelease(controller.signal);
        if (cancelled) return;

        const severity = releaseSeverity(APP_VERSION, release.version);
        if (!severity) return;
        if (!meetsNotificationLevel(severity, settings.notificationLevel)) {
          return;
        }
        if (readDismissedVersion() === release.version) return;

        setPending({ release, severity });
      } catch (error) {
        // Never let a background update check interrupt startup. If GitHub was
        // never reached (a transient network failure, e.g. the device was still
        // coming online), roll the timestamp back so the next launch retries
        // instead of staying silent for the full window. Server responses
        // (rate limit, HTTP errors) keep the stamp.
        if (
          error instanceof UpdateCheckError &&
          error.code === "network" &&
          !cancelled
        ) {
          writeLastCheck(previousLastCheck);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // Close the prompt for this session; it can reappear on the next launch.
  const remindLater = useCallback(() => setPending(null), []);

  // Remember the skipped version so the prompt stays hidden until a newer one.
  const skipVersion = useCallback(() => {
    setPending((current) => {
      if (current) writeDismissedVersion(current.release.version);
      return null;
    });
  }, []);

  return { pending, remindLater, skipVersion };
}
