import { simulatedFix, simulatedSpeed, type NavFix } from "./engine";
import type { NavRoute } from "./route";
import { SIM_TICK_MS } from "./session";

/**
 * Browser pieces of a drive that are not map logic: the arrow drawn at the
 * drive's position, the screen wake lock that keeps a phone awake, and the
 * timer that replays a route without a GPS.
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

/**
 * Replay a route without a GPS: a fix every {@link SIM_TICK_MS} along the
 * route at the router's speed for each step, times a speed factor read on
 * every tick so it can change mid-drive.
 *
 * @param route - The route to drive.
 * @param speedFactor - Reads the current speed multiplier.
 * @param onFix - Receives each simulated fix.
 * @returns A function that stops the simulation.
 */
export function startSimulation(
  route: NavRoute,
  speedFactor: () => number,
  onFix: (fix: NavFix) => void,
): () => void {
  let along = 0;
  onFix(simulatedFix(route, 0, Date.now()));
  const timer = setInterval(() => {
    const factor = speedFactor();
    along = Math.min(
      route.distance,
      along + simulatedSpeed(route, along) * factor * (SIM_TICK_MS / 1000),
    );
    const fix = simulatedFix(route, along, Date.now());
    onFix({ ...fix, speed: (fix.speed ?? 0) * factor });
  }, SIM_TICK_MS);
  return () => clearInterval(timer);
}
