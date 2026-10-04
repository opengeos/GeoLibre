import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  LANGUAGE_PACK_MAX_BYTES,
  LanguagePackError,
  languagePackBaseUrl,
  type InstalledLanguagePack,
} from "../../../lib/language-pack";
import {
  downloadLanguagePack,
  getInstalledLanguagePack,
  installLanguagePackFile,
  removeLanguagePack,
} from "../../../i18n";
import { createOperationTokens } from "../../../lib/operation-tokens";

export type LanguagePackBusy = "download" | "import" | "remove" | null;

export interface LanguagePackNotice {
  kind: "success" | "error";
  text: string;
}

/** Everything the Language section needs to show and manage language packs. */
export interface LanguagePackState {
  installedLanguagePack: InstalledLanguagePack | null;
  languagePackBusy: LanguagePackBusy;
  languagePackNotice: LanguagePackNotice | null;
  setLanguagePackNotice: (notice: LanguagePackNotice | null) => void;
  /** The configured pack host; empty when downloads are turned off. */
  languagePackHost: string;
  languagePackDownloadsEnabled: boolean;
  handleLanguagePackDownload: () => Promise<void>;
  handleLanguagePackFile: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleLanguagePackRemove: () => Promise<void>;
}

/**
 * Language-pack state for the Settings dialog. Lives in the dialog shell (not
 * the Language section) so the installed pack is read when the dialog opens and
 * the last notice survives switching between sections.
 *
 * Args:
 *   open: Whether the Settings dialog is open.
 *   language: The active UI language.
 *
 * Returns:
 *   The pack state and its download/import/remove handlers.
 */
export function useLanguagePack(open: boolean, language: string): LanguagePackState {
  const { t } = useTranslation();
  const [installedLanguagePack, setInstalledLanguagePack] = useState<InstalledLanguagePack | null>(
    null,
  );
  const [languagePackBusy, setLanguagePackBusy] = useState<LanguagePackBusy>(null);
  const [languagePackNotice, setLanguagePackNotice] = useState<LanguagePackNotice | null>(null);
  // One source for both the Download button and the catalog link below, so a
  // build that points `VITE_LANGUAGE_PACK_BASE_URL` at a self-hosted mirror (or
  // opts out of external CDNs entirely) can never offer a link to a host it does
  // not download from.
  const languagePackHost = languagePackBaseUrl();
  const languagePackDownloadsEnabled = languagePackHost.length > 0;
  // Download/import/remove all await, and the user can switch the UI language
  // before they settle. Each handler takes a token and only touches state while
  // it is still current, so a download started for one language can't mark the
  // next language's pack as installed, and a late remove can't clear it (#2866).
  const operationsRef = useRef(createOperationTokens());
  // The language a late-settling import compares its pack's locale against:
  // the one active when it settles, not the one captured when it started.
  const languageRef = useRef(language);
  // Counts operations started, never reset by a language change, so a late
  // import can tell whether a newer download/import/remove has since written
  // the installed state (which it must not overwrite).
  const startedRef = useRef(0);

  useEffect(() => {
    // Orphan anything in flight for the previous language and drop its busy
    // state and notice: neither describes the language now shown.
    languageRef.current = language;
    operationsRef.current.invalidate();
    setLanguagePackBusy(null);
    setLanguagePackNotice(null);
  }, [language]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getInstalledLanguagePack(language)
      .then((installed) => {
        if (!cancelled) setInstalledLanguagePack(installed);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          console.error("[GeoLibre] Failed to read the installed language pack", loadError);
          setInstalledLanguagePack(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, language]);

  const languagePackErrorMessage = (packError: unknown): string => {
    if (!(packError instanceof LanguagePackError)) {
      return t("settings.languagePack.errorGeneric");
    }
    switch (packError.code) {
      case "invalid-json":
        return t("settings.languagePack.errorInvalidJson");
      case "invalid-format":
      case "invalid-translations":
      case "empty-pack":
        return t("settings.languagePack.errorInvalidFormat");
      case "unsupported-version":
        return t("settings.languagePack.errorUnsupportedVersion");
      case "invalid-locale":
        return t("settings.languagePack.errorInvalidLocale");
      case "unsupported-locale":
        return t("settings.languagePack.errorUnsupportedLocale");
      case "too-large":
        return t("settings.languagePack.errorTooLarge");
      case "not-found":
        return t("settings.languagePack.errorNotFound");
      case "download-failed":
        return t("settings.languagePack.errorDownload");
    }
  };

  const handleLanguagePackDownload = async () => {
    const operations = operationsRef.current;
    const token = operations.begin();
    startedRef.current += 1;
    setLanguagePackBusy("download");
    setLanguagePackNotice(null);
    try {
      const installed = await downloadLanguagePack(language);
      if (!operations.isCurrent(token)) return;
      setInstalledLanguagePack(installed);
      setLanguagePackNotice({ kind: "success", text: t("settings.languagePack.downloaded") });
    } catch (packError) {
      if (!operations.isCurrent(token)) return;
      setLanguagePackNotice({ kind: "error", text: languagePackErrorMessage(packError) });
    } finally {
      if (operations.isCurrent(token)) setLanguagePackBusy(null);
    }
  };

  const handleLanguagePackFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    // `parseLanguagePack` enforces the same limit, but only after `file.text()`
    // has already buffered the whole file. Checking the declared size first
    // turns a mistakenly picked multi-gigabyte file into a clean error rather
    // than a tab that reads it into memory before rejecting it.
    if (file.size > LANGUAGE_PACK_MAX_BYTES) {
      setLanguagePackNotice({ kind: "error", text: t("settings.languagePack.errorTooLarge") });
      return;
    }
    const operations = operationsRef.current;
    const token = operations.begin();
    const started = ++startedRef.current;
    setLanguagePackBusy("import");
    setLanguagePackNotice(null);
    try {
      const installed = await installLanguagePackFile(await file.text());
      // The file names its own locale, so the pack is still worth showing when
      // it matches whatever language is active by now, even if the language
      // changed while it installed.
      if (installed.locale === languageRef.current && startedRef.current === started) {
        setInstalledLanguagePack(installed);
      }
      if (!operations.isCurrent(token)) return;
      setLanguagePackNotice({
        kind: "success",
        text: t("settings.languagePack.imported", { locale: installed.locale }),
      });
    } catch (packError) {
      if (!operations.isCurrent(token)) return;
      setLanguagePackNotice({ kind: "error", text: languagePackErrorMessage(packError) });
    } finally {
      if (operations.isCurrent(token)) setLanguagePackBusy(null);
    }
  };

  const handleLanguagePackRemove = async () => {
    const operations = operationsRef.current;
    const token = operations.begin();
    startedRef.current += 1;
    setLanguagePackBusy("remove");
    setLanguagePackNotice(null);
    try {
      await removeLanguagePack(language);
      if (!operations.isCurrent(token)) return;
      setInstalledLanguagePack(null);
      setLanguagePackNotice({ kind: "success", text: t("settings.languagePack.removed") });
    } catch (packError) {
      if (!operations.isCurrent(token)) return;
      setLanguagePackNotice({ kind: "error", text: languagePackErrorMessage(packError) });
    } finally {
      if (operations.isCurrent(token)) setLanguagePackBusy(null);
    }
  };

  return {
    installedLanguagePack,
    languagePackBusy,
    languagePackNotice,
    setLanguagePackNotice,
    languagePackHost,
    languagePackDownloadsEnabled,
    handleLanguagePackDownload,
    handleLanguagePackFile,
    handleLanguagePackRemove,
  };
}
