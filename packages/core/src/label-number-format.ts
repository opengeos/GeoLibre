import type { LabelStyle } from "./types";

/**
 * Locale-aware number formatting for map labels (issue #2336).
 *
 * A numeric attribute rendered straight into a label reads as `1234567.5`,
 * which is hard to compare at a glance. QGIS solves this with
 * `format_number(field, places, language)`; the equivalent here is three
 * {@link LabelStyle} fields — {@link LabelStyle.numberFormatEnabled},
 * {@link LabelStyle.numberDecimals} and {@link LabelStyle.numberLocale} —
 * whose effect this module renders two ways:
 *
 * - {@link labelFieldTextField} builds the MapLibre `text-field` expression the
 *   2D map and the Mapbox/MapLibre style export both use, so the map and the
 *   exported style agree.
 * - {@link formatLabelNumber} does the same in JavaScript for the paths that
 *   resolve label text themselves: the Cesium globe and the duplicate-label
 *   collapsing modes.
 *
 * Formatting applies to {@link LabelStyle.field} only. A label
 * {@link LabelStyle.expression} formats its own output (with `number-format`,
 * offered in the Expression Builder), so wrapping it here would fight the
 * author.
 */

/**
 * Locales offered for {@link LabelStyle.numberLocale}, alongside the default
 * empty value that follows the app's own language.
 *
 * Deliberately short, and every entry groups with a character the map's glyph
 * stack can draw: ASCII `,`/`.` or U+00A0. Locales whose CLDR grouping uses
 * the narrow no-break space U+202F (`fr-FR`) or non-Latin digits (`ar-EG`)
 * are left out because a missing glyph renders as a blank box on the map
 * rather than as a separator. An author who needs one of those can still
 * write `["number-format", …]` in the label expression.
 */
export const LABEL_NUMBER_LOCALES = ["en-US", "de-DE", "ru-RU", "hi-IN"] as const;

/** Sample value used to preview a locale's separators in the Style panel. */
export const LABEL_NUMBER_SAMPLE = 1234567.5;

/**
 * Cached `Intl.NumberFormat`s, keyed by locale + decimals. `formatLabelNumber`
 * runs once per labeled feature (per Cesium entity, per deduplicated point), so
 * constructing a formatter on every call is the wrong order of magnitude.
 *
 * The key space is small: {@link LABEL_NUMBER_LOCALES} plus the app's own
 * language, times eleven decimal settings, times whatever a hand-edited project
 * pins.
 */
const formatterCache = new Map<string, Intl.NumberFormat>();

/** Locale tags `Intl` has already accepted or rejected, so each is tried once. */
const localeSupport = new Map<string, boolean>();

/**
 * A formatter for this locale/decimals pair. Grouping is always on: it is the
 * whole point of the setting. The locale must already have been vetted by
 * {@link usableLocale}, so this never throws.
 */
function labelNumberFormatter(locale: string | undefined, decimals: number): Intl.NumberFormat {
  const digits = clampLabelDecimals(decimals);
  const key = `${locale ?? ""}\u0000${digits}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(locale, {
    useGrouping: true,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  formatterCache.set(key, formatter);
  return formatter;
}

/**
 * The first locale tag `Intl` accepts, or `undefined` to leave `Intl` and
 * MapLibre on the runtime default.
 *
 * A malformed BCP 47 tag (`"en_US"`, `"not a locale"`) makes `Intl` throw a
 * `RangeError`. It can only arrive from a hand-edited project — the Style panel
 * offers a fixed list — but a throw would propagate out of the Cesium labeler
 * and the dedup builder and take down the whole layer's labels, and MapLibre
 * evaluates its own `Intl.NumberFormat` per feature, so the expression path is
 * exposed too. Both paths resolve the locale through here instead, degrading to
 * the next candidate and finally to the runtime default.
 */
function usableLocale(...tags: (string | undefined)[]): string | undefined {
  for (const tag of tags) {
    if (!tag) continue;
    let supported = localeSupport.get(tag);
    if (supported === undefined) {
      try {
        new Intl.NumberFormat(tag);
        supported = true;
      } catch {
        supported = false;
      }
      localeSupport.set(tag, supported);
    }
    if (supported) return tag;
  }
  return undefined;
}

/** Clamp a decimal-places setting to the range the UI and `Intl` both accept. */
export function clampLabelDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return 0;
  return Math.max(0, Math.min(10, Math.trunc(decimals)));
}

/**
 * Format one label value as a number, or `null` when the setting is off or the
 * value is not a finite number (a text attribute keeps its own rendering).
 *
 * @param value - The raw attribute value.
 * @param labels - The layer's label configuration.
 * @param fallbackLocale - Locale used when {@link LabelStyle.numberLocale} is
 *   empty; the caller passes the app's language. Omitted means the runtime
 *   default, matching how popups format their numbers.
 */
export function formatLabelNumber(
  value: unknown,
  labels: Pick<LabelStyle, "numberFormatEnabled" | "numberDecimals" | "numberLocale">,
  fallbackLocale?: string,
): string | null {
  if (!labels.numberFormatEnabled) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const locale = usableLocale(labels.numberLocale, fallbackLocale);
  return labelNumberFormatter(locale, labels.numberDecimals).format(value);
}

/**
 * The MapLibre expression that renders {@link LabelStyle.field} as text, with
 * number formatting applied when it is on. Returns `""` when no field is set,
 * which callers treat as "no label text".
 *
 * Number formatting is guarded by a `typeof` test rather than applied blindly
 * so a mixed or text column still labels normally; only real numbers take the
 * `number-format` branch.
 */
export function labelFieldTextField(
  labels: Pick<LabelStyle, "field" | "numberFormatEnabled" | "numberDecimals" | "numberLocale">,
  fallbackLocale?: string,
): unknown[] | "" {
  const field = labels.field;
  if (!field) return "";
  const asText = ["to-string", ["coalesce", ["get", field], ""]];
  if (!labels.numberFormatEnabled) return asText;
  const locale = usableLocale(labels.numberLocale, fallbackLocale);
  const digits = clampLabelDecimals(labels.numberDecimals);
  const options: Record<string, unknown> = {};
  if (locale) options.locale = locale;
  // MapLibre's `number-format` ignores a falsy option, so zero fraction digits
  // cannot be requested that way — it would silently fall back to the spec
  // default of up to three. Rounding first gives an integer, which then prints
  // with no fraction digits at all.
  const number =
    digits > 0 ? ["to-number", ["get", field]] : ["round", ["to-number", ["get", field]]];
  if (digits > 0) {
    options["min-fraction-digits"] = digits;
    options["max-fraction-digits"] = digits;
  }
  return [
    "case",
    ["==", ["typeof", ["get", field]], "number"],
    ["number-format", number, options],
    asText,
  ];
}

/**
 * Render {@link LABEL_NUMBER_SAMPLE} the way a locale/decimals pair would, so
 * the Style panel can name each choice by the separators it actually produces
 * ("1,234,567.50") instead of by an opaque language tag.
 *
 * Falls back to the raw number if the tag is one `Intl` rejects, which keeps a
 * hand-edited project from throwing inside a render.
 */
export function formatLabelNumberSample(locale: string, decimals: number): string {
  return labelNumberFormatter(usableLocale(locale), decimals).format(LABEL_NUMBER_SAMPLE);
}
