import { useCallback, useEffect, useState } from "react";
import { isTauri } from "../lib/is-tauri";
import {
  UPDATE_DISMISSED_VERSION_STORAGE_KEY,
  UPDATE_LAST_CHECK_STORAGE_KEY,
} from "../lib/storage-keys";
import {
  APP_VERSION,
  fetchLatestRelease,
  IS_STORE_BUILD,
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
    return Number(window.localStorage.getItem(UPDATE_LAST_CHECK_STORAGE_KEY) ?? 0);
  } catch {
    return 0;
  }
}

function writeLastCheck(timestamp: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UPDATE_LAST_CHECK_STORAGE_KEY, String(timestamp));
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

    // The Microsoft Store build must update only through the Store (policy
    // 10.2.5), so it never reaches out to GitHub to check for a newer release.
    if (IS_STORE_BUILD) return;

    const settings = useDesktopSettingsStore.getState().desktopSettings.updates;
    if (!settings.checkOnStartup) return;

    // Throttle the network call so frequent relaunches don't burn the GitHub
    // rate limit. The timestamp is stamped only after a definitive response,
    // never up front: an up-front stamp makes React StrictMode's double-invoked
    // effect early-return on its second run and silently skip the check.
    const now = Date.now();
    if (now - readLastCheck() < CHECK_THROTTLE_MS) return;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const release = await fetchLatestRelease(controller.signal);
        if (cancelled) return;
        // GitHub was reached and parsed, so throttle the next launches
        // regardless of the outcome below (up to date, below the chosen level,
        // or a dismissed version). Bounded staleness is intentional: there is
        // no benefit to re-querying within the window once we have an answer.
        writeLastCheck(now);

        const severity = releaseSeverity(APP_VERSION, release.version);
        if (!severity) return;
        if (!meetsNotificationLevel(severity, settings.notificationLevel)) {
          return;
        }
        if (readDismissedVersion() === release.version) return;

        setPending({ release, severity });
      } catch (error) {
        // Never let a background update check interrupt startup. A server
        // response that failed (rate limit, HTTP error) still counts toward the
        // throttle window; an abort or a transient network failure does not, so
        // the next launch retries instead of staying silent for the full window.
        if (!cancelled && error instanceof UpdateCheckError && error.code !== "network") {
          writeLastCheck(now);
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
  // The write lives outside the setPending updater so the updater stays pure
  // (StrictMode invokes updaters twice).
  const skipVersion = useCallback(() => {
    if (pending) writeDismissedVersion(pending.release.version);
    setPending(null);
  }, [pending]);

  return { pending, remindLater, skipVersion };
}
