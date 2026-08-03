/**
 * Return a whole-value HTTP(S) URL that is safe to expose as an attribute link.
 *
 * Attribute values may contain arbitrary user data, so only explicit web URLs
 * are accepted. Substrings in prose and schemes such as `javascript:` and
 * `file:` remain plain text.
 */
export function attributeLinkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  // Bidirectional controls can make an untrusted hostname appear to read as a
  // different domain even though the browser opens the original URL.
  if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(trimmed)) return null;
  if (!/^https?:\/\/[^/?#]/i.test(trimmed)) return null;

  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}
