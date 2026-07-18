/**
 * Language registry for the app's internationalization layer.
 *
 * Adding a new locale is additive: drop a `locales/<code>.json` catalog next to
 * `en.json` (it is auto-discovered by `index.ts`) and, if the code is not
 * already listed here, add a `LANGUAGE_NAMES` entry so the Settings language
 * selector shows a friendly label. See `docs/i18n.md`.
 */

export const DEFAULT_LANGUAGE = "en";

/**
 * Friendly names for known language codes. The selector falls back to the raw
 * code for any catalog whose code is missing here, so this map is purely
 * cosmetic — a catalog never fails to load for lack of an entry.
 */
export const LANGUAGE_NAMES: Record<string, { nativeName: string; englishName: string }> = {
  en: { nativeName: "English", englishName: "English" },
  zh: { nativeName: "中文", englishName: "Chinese" },
  es: { nativeName: "Español", englishName: "Spanish" },
  fr: { nativeName: "Français", englishName: "French" },
  de: { nativeName: "Deutsch", englishName: "German" },
  pt: { nativeName: "Português", englishName: "Portuguese" },
  ja: { nativeName: "日本語", englishName: "Japanese" },
  ko: { nativeName: "한국어", englishName: "Korean" },
  ru: { nativeName: "Русский", englishName: "Russian" },
  nl: { nativeName: "Nederlands", englishName: "Dutch" },
  it: { nativeName: "Italiano", englishName: "Italian" },
  id: { nativeName: "Bahasa Indonesia", englishName: "Indonesian" },
  tr: { nativeName: "Türkçe", englishName: "Turkish" },
  hi: { nativeName: "हिन्दी", englishName: "Hindi" },
  ar: { nativeName: "العربية", englishName: "Arabic" },
  ka: { nativeName: "ქართული", englishName: "Georgian" },
};

/**
 * Languages written right-to-left. Checked by base subtag, so regional tags
 * (`ar-SA`) resolve the same way `resolveLanguage` resolves catalogs.
 */
const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

export type LanguageDirection = "ltr" | "rtl";

/**
 * The writing direction for a language tag. Works for any tag, not just the
 * codes in `LANGUAGE_NAMES`, and defaults to `ltr` for unknown or empty input.
 */
export function languageDirection(code: string | null | undefined): LanguageDirection {
  if (!code) return "ltr";
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return RTL_LANGUAGES.has(base) ? "rtl" : "ltr";
}

export interface LanguageOption {
  code: string;
  nativeName: string;
  englishName: string;
}

/**
 * Build the selector options for a set of available catalog codes, sorted so
 * the default language is first and the rest are alphabetical by English name.
 */
export function languageOptions(codes: readonly string[]): LanguageOption[] {
  return [...codes]
    .map((code) => {
      const names = LANGUAGE_NAMES[code];
      return {
        code,
        nativeName: names?.nativeName ?? code,
        englishName: names?.englishName ?? code,
      };
    })
    .sort((a, b) => {
      if (a.code === DEFAULT_LANGUAGE) return -1;
      if (b.code === DEFAULT_LANGUAGE) return 1;
      // Pin the collation locale so the selector order is deterministic
      // regardless of the runtime/OS locale (CI vs. a German desktop, etc.).
      return a.englishName.localeCompare(b.englishName, "en");
    });
}

/**
 * Normalize a raw language string (query param, navigator, stored setting) to a
 * catalog code we actually ship, or `null` if there is no match. Matches the
 * full tag first (`pt-BR`) then the base subtag (`pt`).
 */
export function resolveLanguage(
  raw: string | null | undefined,
  available: readonly string[],
): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  // Match case-insensitively but return the catalog's actual code, so a shipped
  // regional catalog like `pt-BR.json` still resolves from a `pt-br` input.
  const byLower = new Map(available.map((code) => [code.trim().toLowerCase(), code] as const));
  const exact = byLower.get(normalized);
  if (exact) return exact;
  const base = normalized.split(/[-_]/)[0];
  if (!base) return null;
  return byLower.get(base) ?? null;
}
