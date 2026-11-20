/**
 * LIFO back-navigation stack for Android hardware/predictive back gestures in
 * the mobile shell (GeoLibre#3537 Phase 5).
 *
 * Handlers return `true` if they consumed the back press (e.g. closing an open
 * BottomSheet, drill-down page, or crosshair capture mode).
 */

/**
 * Native bridge event dispatched by `src-tauri/android/MainActivity.kt` on
 * hardware/predictive Android Back presses. Dispatchers MUST pass
 * `{ cancelable: true }` (`new CustomEvent(ANDROID_BACK_EVENT, { cancelable: true })`)
 * and inspect `event.defaultPrevented` to know whether a JS surface consumed
 * the gesture.
 */
export const ANDROID_BACK_EVENT = "geolibre:android-back";

export type MobileBackHandler = () => boolean;

export interface MobileBackHandlerOptions {
  /**
   * Dispatch priority (higher runs first; LIFO within equal priority).
   * Defaults to `0` for modal sheets; map-level capture modes use `-1` so any
   * open sheet closes first without risking a false yield that exits the app.
   */
  priority?: number;
}

interface RegisteredHandler {
  id: number;
  priority: number;
  handler: MobileBackHandler;
}

const handlers: RegisteredHandler[] = [];
let nextHandlerId = 1;
let installed = false;

/**
 * Dispatch a back press to the highest-priority (and within equal priority,
 * most recently registered) handler that consumes it. Returns `true` if a
 * handler closed an active UI surface.
 */
export function dispatchMobileBack(): boolean {
  const ordered = [...handlers].sort((a, b) => b.priority - a.priority || b.id - a.id);
  for (const entry of ordered) {
    try {
      if (entry.handler()) return true;
    } catch (error) {
      console.error("mobile back handler failed:", error);
    }
  }
  return false;
}

function ensureBackListeners(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(ANDROID_BACK_EVENT, (event) => {
    if (dispatchMobileBack()) {
      event.preventDefault();
    }
  });
}

/** Register a back-press handler; returns an unregister callback. */
export function registerMobileBackHandler(
  handler: MobileBackHandler,
  options?: MobileBackHandlerOptions,
): () => void {
  ensureBackListeners();
  const id = nextHandlerId++;
  const priority = options?.priority ?? 0;
  handlers.push({ id, priority, handler });
  return () => {
    const index = handlers.findIndex((entry) => entry.id === id);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/** Clear all handlers (for isolated unit tests). */
export function resetMobileBackHandlers(): void {
  handlers.length = 0;
}
