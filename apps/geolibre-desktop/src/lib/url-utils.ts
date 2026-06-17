/**
 * A browser-fetchable URL for a layer source value, or null.
 *
 * Accepts direct `http(s)`, `blob:`, and `data:` URLs, and unwraps a single
 * `scheme://`-prefixed wrapper (e.g. a `cog://https://.../x.tif` COG reference)
 * when the inner value is itself web-fetchable. `file:` URLs are deliberately
 * excluded: `fetch("file://...")` throws in a standard browser and is blocked
 * in the Tauri WebView, so treating them as fetchable would make callers (e.g.
 * the raster export menu) offer actions that then fail.
 *
 * @param value - A candidate source value (often `unknown` from layer metadata).
 * @returns The fetchable URL string, or null when the value is not fetchable.
 */
export function fetchableUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^(https?|blob|data):/i.test(value)) return value;
  const inner = value.match(/^[a-z][\w+.-]*:\/\/(.+)$/i);
  if (inner && /^(https?|blob|data):/i.test(inner[1])) return inner[1];
  return null;
}
