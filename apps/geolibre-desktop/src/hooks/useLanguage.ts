import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { AVAILABLE_LANGUAGES, setActiveLanguage } from "../i18n";
import {
  DEFAULT_LANGUAGE,
  languageOptions,
  resolveLanguage,
  type LanguageOption,
} from "../i18n/languages";
import { useDesktopSettingsStore } from "./useDesktopSettings";

export interface UseLanguageResult {
  /** The active UI language code (e.g. `"en"`). */
  language: string;
  /** Selectable languages, default first then alphabetical. */
  options: LanguageOption[];
  /** Switch the UI language and persist the choice to desktop settings. */
  setLanguage: (code: string) => void;
}

// Computed once at module init. AVAILABLE_LANGUAGES is populated by
// i18n/index.ts, which must be imported before this module (main.tsx imports
// "./i18n" first, so the order holds).
const OPTIONS = languageOptions(AVAILABLE_LANGUAGES);

/**
 * Bridge between the i18next instance and persisted desktop settings: reads the
 * live language from i18next (so a `?locale` embed override is reflected) and,
 * on change, both switches i18next and records the choice so it survives reloads.
 */
export function useLanguage(): UseLanguageResult {
  const { i18n } = useTranslation();
  const setDesktopSettings = useDesktopSettingsStore((s) => s.setDesktopSettings);

  const setLanguage = useCallback(
    (code: string) => {
      // `setActiveLanguage` lazily imports the target locale's catalog before
      // switching and applies the module-scope "latest request wins" guard, so
      // rapidly picking two uncached locales can't let a slower earlier fetch
      // clobber the newer selection. It resolves `true` only when this call
      // actually applied the language — persist the choice only then, so a
      // superseded or failed switch leaves neither the UI nor the setting on a
      // language with no strings.
      setActiveLanguage(code)
        .then((applied) => {
          if (!applied) return;
          const current = useDesktopSettingsStore.getState().desktopSettings;
          setDesktopSettings({ ...current, language: code });
        })
        .catch((error: unknown) => {
          // Only the latest request's genuine fetch failure rejects here; keep
          // the current language (its catalog is still loaded) and surface it.
          console.error("[GeoLibre] Failed to change language", error);
        });
    },
    [setDesktopSettings],
  );

  // i18n.language can be a full tag (e.g. `en-US`); reuse the shared resolver to
  // collapse it to a code we ship.
  const language = resolveLanguage(i18n.language, AVAILABLE_LANGUAGES) ?? DEFAULT_LANGUAGE;

  return { language, options: OPTIONS, setLanguage };
}
