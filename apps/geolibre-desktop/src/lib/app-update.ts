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
 * The worker's activation is not proof of a new build: on the relative-base
 * `/demo/` deployment workbox has flagged a re-fetched, unchanged worker as an
 * update. So the notice is only offered once the deployed index.html is seen to
 * load a different entry script than the running page ({@link isNewBuildDeployed}).
 *
 * A tab can stay open for days, so the registration is also re-checked when the
 * tab becomes visible again and periodically while it stays open.
 */

import type { NotifyOptions } from "./notify";

/** How often an open tab asks the server for a newer service worker. */
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Toasts sharing this key collapse, so repeat activations show one notice. */
export const APP_UPDATE_DEDUPE_KEY = "app-update-available";

/** Matches each opening script tag in index.html. */
const SCRIPT_TAG_PATTERN = /<script\b[^>]*>/gi;

/**
 * Return the entry module script URL referenced by an index.html document: the
 * first `<script type="module" src>`, with its attributes in any order.
 *
 * @param html - The index.html source.
 * @param baseUrl - URL the document was fetched from, to resolve a relative src.
 * @returns The absolute entry script URL, or null when none is found.
 */
export function entryScriptUrl(html: string, baseUrl: string): string | null {
  for (const [tag] of html.matchAll(SCRIPT_TAG_PATTERN)) {
    // Whitespace before each name, so `data-type` / `data-src` never match.
    if (!/\stype=["']module["']/i.test(tag)) continue;
    const src = /\ssrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return null;
    }
  }
  return null;
}

export interface NewBuildCheckDeps {
  /** Absolute URL of the entry script the running page loaded, if known. */
  currentEntryUrl: string | null;
  /** Fetch the deployed index.html (bypassing the HTTP cache) from this URL. */
  fetchText: (url: string) => Promise<string>;
}

/**
 * Whether the deployed build differs from the one the page is running.
 *
 * Vite content-hashes the entry script, so a deploy that changes the app
 * changes the entry URL in index.html. index.html sits one level above the
 * entry (`<base>/assets/main-<hash>.js`). When the comparison cannot be made
 * (unknown entry, failed fetch, unparseable HTML) the worker's word is taken
 * and the answer is true: a needless notice beats a missed update.
 *
 * @param deps - The running entry URL and a fetcher, injected for testability.
 * @returns True when a different build is deployed, or when it cannot be told.
 */
export async function isNewBuildDeployed(deps: NewBuildCheckDeps): Promise<boolean> {
  if (!deps.currentEntryUrl) return true;
  let indexUrl: string;
  try {
    indexUrl = new URL("../index.html", deps.currentEntryUrl).href;
  } catch {
    return true;
  }
  try {
    const deployed = entryScriptUrl(await deps.fetchText(indexUrl), indexUrl);
    return deployed === null || deployed !== deps.currentEntryUrl;
  } catch {
    return true;
  }
}

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
 * guard still prompts before it does). It is pinned, so a burst of later
 * toasts cannot evict it.
 *
 * @param deps - Toast, translated strings, and reload, injected for testability.
 */
export function offerAppUpdate(deps: AppUpdateNoticeDeps): void {
  deps.showInfo(deps.message, {
    durationMs: null,
    // Later toasts must not push the notice off screen while it is unanswered.
    pinned: true,
    dedupeKey: APP_UPDATE_DEDUPE_KEY,
    action: { label: deps.reloadLabel, onClick: deps.reload },
  });
}

/** The parts of the browser environment {@link watchForAppUpdates} uses. */
export interface AppUpdateWatchEnv {
  /** The document whose visibility gates the checks. */
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  /** Start a repeating timer; returns its handle. */
  setInterval: (handler: () => void, ms: number) => number;
  /** Stop a timer started by {@link setInterval}. */
  clearInterval: (handle: number) => void;
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
