import { isIpadDesktopUserAgent } from "@geolibre/core";
import { isTauri } from "./is-tauri";

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
const ANDROID_UA_PATTERN = /Android/i;

/**
 * Whether the app is running on Android.
 *
 * This narrower check is used for platform APIs whose Android behavior differs
 * from iOS, such as native document-picker MIME filtering.
 *
 * @param userAgent - Override for testing; defaults to `navigator.userAgent`.
 * @returns True when the user agent identifies Android.
 */
export function isAndroid(
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  return ANDROID_UA_PATTERN.test(userAgent);
}

export function isMobile(
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
  maxTouchPoints: number = typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0,
): boolean {
  if (MOBILE_UA_PATTERN.test(userAgent)) return true;
  // iPadOS 13+ requests desktop sites by default and spoofs a macOS UA. Shared
  // with @geolibre/plugins' Earth Engine availability check so a future
  // correction to the heuristic lands in both.
  return isIpadDesktopUserAgent(userAgent, maxTouchPoints);
}

const WINDOWS_UA_PATTERN = /Windows/i;

/**
 * Whether the app is running on Windows.
 *
 * Used to scope workarounds for WebView2-only behavior, such as routing the
 * loopback sidecar through Tauri's native HTTP client (see
 * `lib/sidecar-fetch.ts`): macOS and Linux use different webview stacks that
 * never hit that restriction, so they keep the direct WebView fetch rather than
 * paying the native client's IPC body serialization.
 *
 * User-agent based for the same reason as {@link isMobile} — no extra Tauri
 * plugin, Rust crate, or capability wiring — and every WebView2 user agent
 * carries a "Windows NT" token.
 *
 * @param userAgent - Override for testing; defaults to `navigator.userAgent`.
 * @returns True when the user agent identifies Windows.
 */
export function isWindows(
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  return WINDOWS_UA_PATTERN.test(userAgent);
}

/**
 * Whether the app runs in the *desktop* Tauri shell — the Tauri webview on a
 * desktop OS, excluding the packaged Android/iOS apps.
 *
 * {@link isTauri} alone is true in the mobile apps too, so a feature that needs
 * a local helper process (the Python sidecar, the Martin tile server) must gate
 * on this instead. Gating on `isTauri()` lets the flow run on a phone or tablet
 * and fail with a raw "could not connect to the sidecar at 127.0.0.1:8765"
 * error, which is what GeoLibre#2091 reported on iPadOS.
 *
 * @param userAgent - Override for testing; defaults to `navigator.userAgent`.
 * @param maxTouchPoints - Override for testing; see {@link isMobile}.
 * @returns True only inside the Tauri shell on a desktop operating system.
 */
export function isDesktopRuntime(userAgent?: string, maxTouchPoints?: number): boolean {
  return isTauri() && !isMobile(userAgent, maxTouchPoints);
}
