/**
 * Touch UI mode resolution for phones, tablets, and desktop devices.
 *
 * Keeps pointer coarseness / mobile OS detection separate from viewport width
 * so:
 * - Phones (`< 768px` with coarse pointer or mobile OS) get the mobile phone
 *   shell (compact top bar, bottom nav dock, draggable BottomSheet, floating
 *   status pill) AND touch-sized targets.
 * - Tablets (`>= 768px` with coarse pointer or mobile OS) keep split-screen
 *   sidebars while opting into touch-sized targets (`data-touch-ui="true"`).
 * - Narrow desktop windows with a mouse stay on desktop chrome unless the user
 *   explicitly switches Touch interface to `"touch"` in Settings → Layout.
 * - Phone/tablet users can opt out to `"desktop"` at any time.
 */

export type TouchUiMode = "auto" | "touch" | "desktop";

export const TOUCH_UI_MODES: readonly TouchUiMode[] = ["auto", "touch", "desktop"];

export const DEFAULT_TOUCH_UI_MODE: TouchUiMode = "auto";

/** Type guard for persisted or URL-provided touch UI modes. */
export function isTouchUiMode(value: unknown): value is TouchUiMode {
  return typeof value === "string" && (TOUCH_UI_MODES as readonly string[]).includes(value);
}

/**
 * Whether touch ergonomics (`data-touch-ui="true"`, 44px targets, 16px inputs,
 * enlarged sliders and MapLibre controls) should be active.
 */
export function resolveTouchUi(options: {
  mode: TouchUiMode;
  coarsePointer: boolean;
  mobilePlatform: boolean;
}): boolean {
  if (options.mode === "touch") return true;
  if (options.mode === "desktop") return false;
  return options.coarsePointer || options.mobilePlatform;
}

/**
 * Whether the phone-sized mobile shell chrome (compact top bar, bottom nav bar,
 * draggable BottomSheet host, floating status pill) should replace the desktop
 * menubar + side rails + status bar.
 *
 * Compact embeds (`?maponly`, `?layout=viewer`, `?layout=compact`) and
 * panel-hidden embeds (`?panels=hidden`) always stay on their dedicated embed
 * chrome so iframe/Jupyter layouts are never altered.
 */
export function resolveMobileShell(options: {
  mode: TouchUiMode;
  touchUi: boolean;
  mobileViewport: boolean;
  compact: boolean;
  panelsHidden: boolean;
}): boolean {
  if (options.mode === "desktop") return false;
  if (options.compact || options.panelsHidden) return false;
  return options.touchUi && options.mobileViewport;
}
