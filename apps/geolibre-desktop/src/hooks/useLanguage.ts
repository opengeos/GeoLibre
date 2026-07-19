import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { AVAILABLE_LANGUAGES, loadCatalog } from "../i18n";
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
      // Import the target locale's lazy catalog chunk before switching, then
      // persist only after the language has actually switched — so a catalog
      // that fails to load leaves neither the UI nor the persisted setting on a
      // language with no strings. English is bundled, so switching to it needs
      // no fetch.
      loadCatalog(code)
        .then(() => i18n.changeLanguage(code))
        .then(() => {
          const current = useDesktopSettingsStore.getState().desktopSettings;
          setDesktopSettings({ ...current, language: code });
        })
        .catch((error: unknown) => {
          // Keep the current language (its catalog is still loaded) rather than
          // switch to an empty one; surface the failed fetch.
          console.error("[GeoLibre] Failed to change language", error);
        });
    },
    [i18n, setDesktopSettings],
  );

  // i18n.language can be a full tag (e.g. `en-US`); reuse the shared resolver to
  // collapse it to a code we ship.
  const language = resolveLanguage(i18n.language, AVAILABLE_LANGUAGES) ?? DEFAULT_LANGUAGE;

  return { language, options: OPTIONS, setLanguage };
}
