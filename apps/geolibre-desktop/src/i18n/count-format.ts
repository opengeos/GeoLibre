import type { i18n as I18n } from "i18next";

/**
 * Interpolation keys whose numeric values are formatted with the active
 * locale's digit grouping: `1284` → "1,284" (en), "1.284" (de), "1 284" (fr),
 * and `1234567` → "12,34,567" (hi). These two names carry nearly every count
 * in the catalogs ("{{count}} features", "{{count}} of {{total}}"); a number
 * under any other key, such as `{{year}}` or `{{zoom}}`, is left as is.
 */
const COUNT_KEYS = new Set(["count", "total"]);

type FormatFn = (
  value: unknown,
  format: string | undefined,
  lng: string | undefined,
  options?: Record<string, unknown>,
) => unknown;

const formatters = new Map<string, Intl.NumberFormat>();

function numberFormat(lng: string): Intl.NumberFormat | null {
  let formatter = formatters.get(lng);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(lng);
    } catch {
      // A language pack may name a locale `Intl` doesn't know (RangeError).
      // Show the plain number rather than fail the whole string.
      return null;
    }
    formatters.set(lng, formatter);
  }
  return formatter;
}

/**
 * Format every `{{count}}` and `{{total}}` number by locale, with no catalog
 * changes. Call it right after `i18n.init()` with
 * `interpolation: { alwaysFormat: true }`, which makes i18next pass every
 * interpolated value through the interpolator's `format`, not just those
 * written `{{value, format}}`.
 *
 * Plurals are unaffected: i18next picks the `_one`/`_other` form from the
 * numeric `count` option before it interpolates, so this only changes how the
 * digits read. Pass counts as numbers, not `n.toLocaleString()` strings: a
 * string `count` turns plural selection off and formats with the browser's
 * locale instead of the app's.
 *
 * The hook replaces `i18n.services.interpolator.format`, which is not public
 * i18next API (the public `interpolation.format` option is overwritten by the
 * built-in formatter at init). `tests/i18n-count-format.test.ts` runs it
 * against the installed i18next, so an upgrade that moves the hook fails there
 * instead of silently dropping the separators.
 *
 * Returns false, leaving i18next untouched, if the hook isn't there.
 */
export function installCountFormatting(i18n: I18n): boolean {
  const interpolator = i18n.services?.interpolator as { format?: FormatFn } | undefined;
  const base = interpolator?.format;
  if (!interpolator || typeof base !== "function") return false;
  interpolator.format = (value, format, lng, options) => {
    if (
      format === undefined &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      COUNT_KEYS.has(options?.interpolationkey as string)
    ) {
      const locale = (options?.lng as string | undefined) ?? lng ?? i18n.language;
      const formatter = locale ? numberFormat(locale) : null;
      if (formatter) return formatter.format(value);
    }
    return base.call(interpolator, value, format, lng, options);
  };
  return true;
}
