/**
 * Whether the app is running on a mobile operating system (Android or iOS).
 *
 * This is distinct from a narrow *viewport* (see `useIsMobileViewport`): a
 * desktop window resized small is narrow but not mobile. Mobile platforms cannot
 * run the bundled Python sidecar or spawn local helper processes (rasterio,
 * format conversion, AI segmentation, the Martin tile server), so the UI uses
 * this to hide those tools instead of presenting them and failing. WebAssembly-
 * backed tools (the Whitebox toolbox) run in the browser and stay available.
 *
 * Detection is user-agent based so it needs no extra Tauri plugin or Rust/
 * capability wiring (the Tauri Android webview reports an "Android" UA). iPadOS
 * 13+ Safari reports a desktop "Macintosh" UA, so that case is disambiguated
 * from a real Mac via the multi-touch capability. For a stricter platform check
 * in the future, `@tauri-apps/plugin-os` `platform()` could replace this.
 *
 * @param userAgent - Override for testing; defaults to `navigator.userAgent`.
 * @param maxTouchPoints - Override for testing; defaults to
 *   `navigator.maxTouchPoints`. Used only to distinguish an iPad (multi-touch
 *   "Macintosh" UA) from a real Mac.
 * @returns True on Android/iOS (including desktop-UA iPadOS).
 */
const MOBILE_UA_PATTERN = /Android|iPhone|iPad|iPod/i;

export function isMobile(
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
  maxTouchPoints: number = typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0,
): boolean {
  if (MOBILE_UA_PATTERN.test(userAgent)) return true;
  // iPadOS 13+ requests desktop sites by default and spoofs a macOS UA; a real
  // Mac reports maxTouchPoints 0/1, an iPad reports >1.
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}
