/**
 * LIFO back-navigation stack for Android hardware/predictive back gestures and
 * browser back button interception in the mobile shell (GeoLibre#3537 Phase 5).
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

interface RegisteredHandler {
  id: number;
  handler: MobileBackHandler;
}

const handlers: RegisteredHandler[] = [];
let nextHandlerId = 1;
let installed = false;

/**
 * Dispatch a back press to the topmost registered handler that consumes it.
 * Returns `true` if a handler closed an active UI surface.
 */
export function dispatchMobileBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    try {
      if (handlers[i].handler()) return true;
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
export function registerMobileBackHandler(handler: MobileBackHandler): () => void {
  ensureBackListeners();
  const id = nextHandlerId++;
  handlers.push({ id, handler });
  return () => {
    const index = handlers.findIndex((entry) => entry.id === id);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/** Clear all handlers (for isolated unit tests). */
export function resetMobileBackHandlers(): void {
  handlers.length = 0;
}
