/**
 * Whether the app runs inside the Tauri desktop webview. Kept in its own tiny,
 * side-effect-free module so it can be used from the eager entry (e.g.
 * stale-chunk-reload) without pulling the heavier tauri-io module — which
 * imports shpjs/fflate/Tauri plugins — into the initial bundle.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
