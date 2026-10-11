/**
 * Browser pieces of a drive that are not map logic: the arrow drawn at the
 * drive's position, and the screen wake lock that keeps a phone awake.
 */

/** A held screen wake lock. */
export interface ScreenWakeLock {
  release: () => Promise<void>;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<ScreenWakeLock> };
};

/**
 * Keep the screen on, where the platform allows it.
 *
 * @returns The lock, or null when unsupported or refused (a hidden page).
 */
export async function requestScreenWakeLock(): Promise<ScreenWakeLock | null> {
  try {
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    return wakeLock ? await wakeLock.request("screen") : null;
  } catch {
    return null;
  }
}

/**
 * The navigation arrow drawn at the drive's position.
 *
 * @returns The marker element; rotate the marker, not the element.
 */
export function createPuckElement(): HTMLElement {
  const el = document.createElement("div");
  el.dataset.testid = "navigation-puck";
  el.innerHTML =
    '<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">' +
    '<circle cx="22" cy="22" r="19" fill="#2563eb" fill-opacity="0.18"/>' +
    '<path d="M22 7 L33 34 L22 27.5 L11 34 Z" fill="#2563eb" stroke="#fff" ' +
    'stroke-width="2.5" stroke-linejoin="round"/></svg>';
  return el;
}
