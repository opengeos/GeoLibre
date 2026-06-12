import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { AVAILABLE_LANGUAGES } from "../i18n";
import {
  DEFAULT_LANGUAGE,
  languageOptions,
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
      void i18n.changeLanguage(code);
      const current = useDesktopSettingsStore.getState().desktopSettings;
      setDesktopSettings({ ...current, language: code });
    },
    [i18n, setDesktopSettings],
  );

  // i18n.language can be a full tag (e.g. `en-US`); collapse to a code we ship.
  const base = i18n.language?.split("-")[0];
  const language = AVAILABLE_LANGUAGES.includes(i18n.language)
    ? i18n.language
    : base && AVAILABLE_LANGUAGES.includes(base)
      ? base
      : DEFAULT_LANGUAGE;

  return { language, options: OPTIONS, setLanguage };
}
