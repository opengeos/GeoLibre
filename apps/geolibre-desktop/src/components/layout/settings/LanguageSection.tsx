import { Button, Label, Select, cn } from "@geolibre/ui";
import {
  DownloadCloud,
  ExternalLink,
  LoaderCircle,
  PackageCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLanguage } from "../../../hooks/useLanguage";
import { installedPackDetail, languagePackHostname } from "./settings-draft";
import type { LanguagePackState } from "./useLanguagePack";

interface LanguageSectionProps {
  /** Language-pack state, owned by the dialog shell (see `useLanguagePack`). */
  languagePack: LanguagePackState;
}

/**
 * The Language section: the interface language picker and language-pack
 * download, import and removal.
 *
 * Args:
 *   props: The section props.
 *
 * Returns:
 *   The section content.
 */
export function LanguageSection({ languagePack }: LanguageSectionProps) {
  const { t } = useTranslation();
  const { language, options: languageOptions, setLanguage } = useLanguage();
  const {
    installedLanguagePack,
    languagePackBusy,
    languagePackNotice,
    setLanguagePackNotice,
    languagePackHost,
    languagePackDownloadsEnabled,
    handleLanguagePackDownload,
    handleLanguagePackFile,
    handleLanguagePackRemove,
  } = languagePack;
  const languagePackFileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">{t("settings.languagePack.title")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.languagePack.description")}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-language-pack-locale">
          {t("settings.languagePack.interfaceLanguage")}
        </Label>
        <Select
          id="settings-language-pack-locale"
          value={language}
          onChange={(event) => {
            setLanguagePackNotice(null);
            setLanguage(event.target.value);
          }}
        >
          {languageOptions.map((option) => (
            <option key={option.code} value={option.code}>
              {option.nativeName === option.englishName
                ? option.nativeName
                : `${option.nativeName} (${option.englishName})`}
            </option>
          ))}
        </Select>
      </div>
      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full",
              installedLanguagePack
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-muted text-muted-foreground",
            )}
          >
            <PackageCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {installedLanguagePack
                ? t("settings.languagePack.installed")
                : t("settings.languagePack.notInstalled")}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {installedLanguagePack
                ? installedPackDetail(t, language, installedLanguagePack)
                : language === "en"
                  ? t("settings.languagePack.englishFallback")
                  : languagePackDownloadsEnabled
                    ? t("settings.languagePack.notInstalledDetail")
                    : t("settings.languagePack.downloadsDisabled")}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {language !== "en" && languagePackDownloadsEnabled ? (
            <Button
              type="button"
              size="sm"
              onClick={handleLanguagePackDownload}
              disabled={languagePackBusy !== null}
            >
              {languagePackBusy === "download" ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <DownloadCloud className="h-3.5 w-3.5" />
              )}
              {t("settings.languagePack.download")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={languagePackBusy !== null}
            onClick={() => languagePackFileRef.current?.click()}
          >
            {languagePackBusy === "import" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {t("settings.languagePack.importFile")}
          </Button>
          {installedLanguagePack ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={languagePackBusy !== null}
              onClick={handleLanguagePackRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("settings.languagePack.remove")}
            </Button>
          ) : null}
          <input
            ref={languagePackFileRef}
            className="hidden"
            type="file"
            accept=".json,application/json"
            onChange={handleLanguagePackFile}
          />
        </div>
      </div>
      {languagePackNotice ? (
        <p
          className={cn(
            "text-sm",
            languagePackNotice.kind === "error"
              ? "text-destructive"
              : "text-emerald-700 dark:text-emerald-300",
          )}
          role={languagePackNotice.kind === "error" ? "alert" : "status"}
        >
          {languagePackNotice.text}
        </p>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        {languagePackHost
          ? t("settings.languagePack.privacy", {
              host: languagePackHostname(languagePackHost),
            })
          : t("settings.languagePack.privacyLocalOnly")}
        {languagePackHost ? (
          <>
            {" "}
            <a
              className="inline-flex items-center gap-1 underline underline-offset-2"
              href={languagePackHost}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t("settings.languagePack.browse")}
              <ExternalLink className="h-3 w-3" />
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}
