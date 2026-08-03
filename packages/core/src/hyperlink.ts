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
  if (!/^https?:\/\/[^/?#]/i.test(trimmed)) return null;

  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}
