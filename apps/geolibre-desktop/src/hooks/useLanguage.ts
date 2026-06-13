import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { AVAILABLE_LANGUAGES } from "../i18n";
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

const OPTIONS = languageOptions(AVAILABLE_LANGUAGES);

/**
 * Bridge between the i18next instance and persisted desktop settings: reads the
 * live language from i18next (so a `?locale` embed override is reflected) and,
 * on change, both switches i18next and records the choice so it survives reloads.
 */
export function useLanguage(): UseLanguageResult {
  const { i18n } = useTranslation();
  const setDesktopSettings = useDesktopSettingsStore(
    (s) => s.setDesktopSettings,
  );

  const setLanguage = useCallback(
    (code: string) => {
      // Persist only after the language has actually switched, so a future
      // lazy-loaded or remote catalog that fails to load does not leave a
      // broken language persisted for the next boot. With today's eagerly
      // bundled catalogs this resolves synchronously.
      void i18n.changeLanguage(code).then(() => {
        const current = useDesktopSettingsStore.getState().desktopSettings;
        setDesktopSettings({ ...current, language: code });
      });
    },
    [i18n, setDesktopSettings],
  );

  // i18n.language can be a full tag (e.g. `en-US`); reuse the shared resolver to
  // collapse it to a code we ship.
  const language =
    resolveLanguage(i18n.language, AVAILABLE_LANGUAGES) ?? DEFAULT_LANGUAGE;

  return { language, options: OPTIONS, setLanguage };
}
