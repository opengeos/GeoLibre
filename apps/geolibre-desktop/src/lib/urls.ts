/**
 * Normalize a user-provided value into an absolute `http:`/`https:` URL.
 *
 * Returns the normalized href, or `null` when the value is empty, unparseable,
 * or uses a non-HTTP protocol.
 */
export function normalizeProjectUrl(value: string | null): string | null {
  if (!value?.trim()) return null;

  try {
    const url = new URL(value.trim(), window.location.href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
