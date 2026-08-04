// Shared validation primitives for the relay core.
//
// Kept in one place because both `session.ts` and `comment-validate.ts` need
// them and they are validation *contracts*: two copies of the colour pattern
// would let `sanitizeColor` and `validateAuthor` drift into accepting different
// values for the same session. Not re-exported from the package root, so the
// public surface is unchanged.

export const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
