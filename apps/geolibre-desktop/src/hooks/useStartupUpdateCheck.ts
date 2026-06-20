import { useCallback, useEffect, useState } from "react";
import { isTauri } from "../lib/is-tauri";
import { UPDATE_DISMISSED_VERSION_STORAGE_KEY } from "../lib/storage-keys";
import {
  APP_VERSION,
  fetchLatestRelease,
  meetsNotificationLevel,
  releaseSeverity,
  type LatestRelease,
  type ReleaseSeverity,
} from "../lib/updates";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/** A pending update surfaced by the automated startup check. */
export interface PendingUpdate {
  release: LatestRelease;
  severity: ReleaseSeverity;
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
      } catch {
        // Never let a background update check interrupt startup.
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
