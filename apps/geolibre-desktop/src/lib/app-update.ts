/**
 * "A new version is available" notice for the web build.
 *
 * The service worker updates itself on a deploy (skipWaiting + clientsClaim in
 * vite.config.ts), but the open page keeps running the previous build's code.
 * That mix of an old page and a new deployment is what leaves a tab half
 * working after a release: a lazily loaded chunk the old page asks for no
 * longer exists, so a panel or the map fails to load. main.tsx deliberately does
 * not force a reload when the new worker activates (it would discard the user's
 * map), so instead this offers one: a persistent toast with a Reload button.
 *
 * A tab can stay open for days, so the registration is also re-checked when the
 * tab becomes visible again and periodically while it stays open.
 */

import type { NotifyOptions } from "./notify";

/** How often an open tab asks the server for a newer service worker. */
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Toasts sharing this key collapse, so repeat activations show one notice. */
export const APP_UPDATE_DEDUPE_KEY = "app-update-available";

export interface AppUpdateNoticeDeps {
  /** Show a toast (the app's `notify.info`). */
  showInfo: (message: string, options?: NotifyOptions) => void;
  /** Translated "a new version is available" message. */
  message: string;
  /** Translated label for the reload button. */
  reloadLabel: string;
  /** Reload the page onto the new build. */
  reload: () => void;
}

/**
 * Offer a reload after a new service worker took control of the page.
 *
 * The toast persists until the user reloads or dismisses it: a reload is the
 * user's call, because it discards in-memory map state (and the unsaved-changes
 * guard still prompts before it does).
 *
 * @param deps - Toast, translated strings, and reload, injected for testability.
 */
export function offerAppUpdate(deps: AppUpdateNoticeDeps): void {
  deps.showInfo(deps.message, {
    durationMs: null,
    dedupeKey: APP_UPDATE_DEDUPE_KEY,
    action: { label: deps.reloadLabel, onClick: deps.reload },
  });
}

/** The parts of the browser environment {@link watchForAppUpdates} uses. */
export interface AppUpdateWatchEnv {
  /** The document whose visibility gates the checks. */
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  /** Start a repeating timer; returns its handle. */
  setInterval: (handler: () => void, ms: number) => unknown;
  /** Stop a timer started by {@link setInterval}. */
  clearInterval: (handle: unknown) => void;
}

/**
 * Keep asking the server for a newer service worker while the page is open.
 *
 * Browsers only re-check `sw.js` on navigation (and at most once a day for
 * long-lived pages), so a tab left open across a deploy would never learn of
 * it. Checking when the tab returns to view and once an hour while visible
 * makes the update notice appear without the user reloading first.
 *
 * @param registration - The app's service worker registration.
 * @param env - Document and timers, injected for testability.
 * @returns A function that stops watching.
 */
export function watchForAppUpdates(
  registration: Pick<ServiceWorkerRegistration, "update">,
  env: AppUpdateWatchEnv,
): () => void {
  const check = () => {
    if (env.document.visibilityState !== "visible") return;
    // An offline or failed check is harmless: the next one retries.
    registration.update().catch(() => undefined);
  };
  env.document.addEventListener("visibilitychange", check);
  const timer = env.setInterval(check, APP_UPDATE_CHECK_INTERVAL_MS);
  return () => {
    env.document.removeEventListener("visibilitychange", check);
    env.clearInterval(timer);
  };
}
