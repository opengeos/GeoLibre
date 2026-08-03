/**
 * Attribute values routinely carry a web address: the `url` on a USGS
 * earthquake feature, a photo page on a survey point, a "Link" field someone
 * typed onto a marker they drew. Identify and the attribute table render every
 * value as text, so those arrive as dead strings the user has to select and
 * paste. Detect the case where the whole value *is* one http(s) URL so they can
 * be rendered as real links instead.
 *
 * Deliberately strict, matching a whole value rather than linkifying substrings
 * of prose: guessing where a URL ends inside a sentence gets trailing
 * punctuation wrong, and a permissive scheme test would let `javascript:` or
 * `file:` reach an opener.
 */
export function attributeLinkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // A URL cannot carry unescaped whitespace, so an inner space means this is
  // prose that mentions a link, not a link.
  if (!trimmed || /\s/.test(trimmed)) return null;
  // Require a scheme plus a non-empty authority up front: `new URL` alone
  // accepts shapes such as "https:" or "http://" that are not openable.
  if (!/^https?:\/\/[^/?#]/i.test(trimmed)) return null;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}
