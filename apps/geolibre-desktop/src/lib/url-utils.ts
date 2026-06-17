/**
 * A browser-fetchable URL for a layer source value, or null.
 *
 * Accepts direct `http(s)`, `blob:`, `data:`, and `file:` URLs, and unwraps a
 * single `scheme://`-prefixed wrapper (e.g. a `cog://https://.../x.tif` COG
 * reference) when the inner value is itself web-fetchable. Wrapped `file://`
 * URLs are intentionally not unwrapped: the wrapper forms only ever carry a
 * remote, range-fetchable inner URL, so a wrapped local path would not be
 * readable by `fetch()` anyway.
 *
 * @param value - A candidate source value (often `unknown` from layer metadata).
 * @returns The fetchable URL string, or null when the value is not fetchable.
 */
export function fetchableUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^(https?|blob|data|file):/i.test(value)) return value;
  const inner = value.match(/^[a-z][\w+.-]*:\/\/(.+)$/i);
  if (inner && /^(https?|blob|data):/i.test(inner[1])) return inner[1];
  return null;
}
