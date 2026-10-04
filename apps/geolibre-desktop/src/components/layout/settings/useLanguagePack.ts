import { useEffect, useState, type ChangeEvent } from "react";
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
    setLanguagePackBusy("download");
    setLanguagePackNotice(null);
    try {
      const installed = await downloadLanguagePack(language);
      setInstalledLanguagePack(installed);
      setLanguagePackNotice({ kind: "success", text: t("settings.languagePack.downloaded") });
    } catch (packError) {
      setLanguagePackNotice({ kind: "error", text: languagePackErrorMessage(packError) });
    } finally {
      setLanguagePackBusy(null);
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
    setLanguagePackBusy("import");
    setLanguagePackNotice(null);
    try {
      const installed = await installLanguagePackFile(await file.text());
      if (installed.locale === language) setInstalledLanguagePack(installed);
      setLanguagePackNotice({
        kind: "success",
        text: t("settings.languagePack.imported", { locale: installed.locale }),
      });
    } catch (packError) {
      setLanguagePackNotice({ kind: "error", text: languagePackErrorMessage(packError) });
    } finally {
      setLanguagePackBusy(null);
    }
  };

  const handleLanguagePackRemove = async () => {
    setLanguagePackBusy("remove");
    setLanguagePackNotice(null);
    try {
      await removeLanguagePack(language);
      setInstalledLanguagePack(null);
      setLanguagePackNotice({ kind: "success", text: t("settings.languagePack.removed") });
    } catch (packError) {
      setLanguagePackNotice({ kind: "error", text: languagePackErrorMessage(packError) });
    } finally {
      setLanguagePackBusy(null);
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
