/**
 * Whether the app is running on a mobile operating system (Android or iOS).
 *
 * This is distinct from a narrow *viewport* (see `useIsMobileViewport`): a
 * desktop window resized small is narrow but not mobile. Mobile platforms cannot
 * run the bundled Python sidecar or spawn local helper processes (Whitebox,
 * rasterio, format conversion, AI segmentation, the Martin tile server), so the
 * UI uses this to hide those tools instead of presenting them and failing.
 *
 * Detection is user-agent based so it needs no extra Tauri plugin or Rust/
 * capability wiring (the Tauri Android webview reports an "Android" UA). For a
 * stricter platform check in the future, `@tauri-apps/plugin-os` `platform()`
 * could replace this.
 *
 * @param userAgent - Override for testing; defaults to `navigator.userAgent`.
 * @returns True on Android/iOS.
 */
const MOBILE_UA_PATTERN = /Android|iPhone|iPad|iPod/i;

export function isMobile(
  userAgent: string = typeof navigator !== "undefined"
    ? navigator.userAgent
    : "",
): boolean {
  return MOBILE_UA_PATTERN.test(userAgent);
}
