/**
 * Normalize a user-provided value into an absolute `http:`/`https:` URL.
 *
 * Returns the normalized href, or `null` when the value is empty, unparseable,
 * or uses a non-HTTP protocol. The value must already carry an absolute
 * scheme: parsing with no base rejects relative/bare paths (e.g. `/api/x`,
 * `../secret`) instead of resolving them against the current origin, and
 * avoids touching `window.location` in non-browser contexts.
 */
export function normalizeProjectUrl(value: string | null): string | null {
  if (!value?.trim()) return null;

  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
