/**
 * The document language, so formatted numbers and dates follow the UI locale.
 *
 * Shared by the Identify popup's value formatting and by label number
 * formatting, which both fall back to it when the author has not pinned an
 * explicit locale. Returns `undefined` outside a browser (tests, the headless
 * project authoring paths), which leaves `Intl` on its own default.
 */
export function documentLocale(): string | undefined {
  const lang = typeof document !== "undefined" ? document.documentElement.lang.trim() : "";
  return lang || undefined;
}
