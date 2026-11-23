/**
 * Platform-aware URL builders for Tauri's pooled custom URI scheme handlers
 * (`mbtiles`, `local-pmtiles`, and `local-cog`) that serve local tiles and HTTP
 * byte-range media directly from Rust without JSON IPC serialization overhead.
 *
 * Tauri v2 serves custom URI schemes over `http://<scheme>.localhost` on
 * Windows (WebView2) and Android, and `<scheme>://localhost` on macOS, Linux,
 * and iOS.
 */

export type NativeMediaPlatform = "windows" | "android" | "macos" | "linux" | "ios";

/** Whether the active webview dispatches custom Tauri protocols over `http://<scheme>.localhost`. */
export function usesLocalhostCustomSchemeOrigin(platform?: NativeMediaPlatform): boolean {
  if (platform) return platform === "windows" || platform === "android";
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  const navPlatform = navigator.platform ?? "";
  return /Android/i.test(ua) || /Win/i.test(navPlatform) || /Windows/i.test(ua);
}

function nativeProtocolOrigin(scheme: string, platform?: NativeMediaPlatform): string {
  return usesLocalhostCustomSchemeOrigin(platform)
    ? `http://${scheme}.localhost`
    : `${scheme}://localhost`;
}

/**
 * Build a custom-protocol tile URL template for a local `.mbtiles` archive
 * served by the pooled Tauri `mbtiles` handler, preserving `{z}/{x}/{y}`
 * coordinate placeholders.
 */
export function nativeMbtilesProtocolUrl(path: string, platform?: NativeMediaPlatform): string {
  return `${nativeProtocolOrigin("mbtiles", platform)}/tile/{z}/{x}/{y}?path=${encodeURIComponent(path)}`;
}

/**
 * Build a custom-protocol URL for a local `.pmtiles` archive served with HTTP
 * `Range` (`206 Partial Content`) support by the pooled Tauri `local-pmtiles`
 * handler (distinct from MapLibre's `pmtiles://` protocol).
 */
export function nativeLocalPmtilesProtocolUrl(
  path: string,
  platform?: NativeMediaPlatform,
): string {
  return `${nativeProtocolOrigin("local-pmtiles", platform)}/file?path=${encodeURIComponent(path)}`;
}

/**
 * Build a custom-protocol URL for a local Cloud-Optimized GeoTIFF served with
 * HTTP `Range` (`206 Partial Content`) support by the pooled Tauri `local-cog`
 * handler.
 */
export function nativeLocalCogProtocolUrl(path: string, platform?: NativeMediaPlatform): string {
  return `${nativeProtocolOrigin("local-cog", platform)}/file?path=${encodeURIComponent(path)}`;
}
