/**
 * URL builders for Tauri's pooled custom URI scheme handlers (`mbtiles://`,
 * `pmtiles://`, and `local-cog://`) that serve local tiles and HTTP byte-range
 * media directly from Rust without JSON IPC serialization overhead.
 */

/**
 * Build a custom-protocol tile URL template for a local `.mbtiles` archive
 * served by the pooled Tauri `mbtiles://` handler.
 */
export function nativeMbtilesProtocolUrl(path: string): string {
  return `mbtiles://tile/{z}/{x}/{y}?path=${encodeURIComponent(path)}`;
}

/**
 * Build a custom-protocol URL for a local `.pmtiles` archive served with HTTP
 * `Range` (`206 Partial Content`) support by the pooled Tauri `pmtiles://`
 * handler.
 */
export function nativePmtilesProtocolUrl(path: string): string {
  return `pmtiles://file?path=${encodeURIComponent(path)}`;
}

/**
 * Build a custom-protocol URL for a local Cloud-Optimized GeoTIFF served with
 * HTTP `Range` (`206 Partial Content`) support by the pooled Tauri
 * `local-cog://` handler.
 */
export function nativeLocalCogProtocolUrl(path: string): string {
  return `local-cog://file?path=${encodeURIComponent(path)}`;
}
