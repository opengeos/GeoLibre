import { Button, Input, Label } from "@geolibre/ui";
import { Download, FolderOpen, Link2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_UI_PROFILE_SETTINGS,
  useDesktopSettingsStore,
  type ExperienceLevel,
  type UiProfileSettings,
} from "../../../hooks/useDesktopSettings";
import { useLanguage } from "../../../hooks/useLanguage";
import {
  openLocalDataFileWithFallback,
  saveTextFileWithFallback,
} from "../../../lib/file-io/file-dialogs";
import {
  applyInterfaceSettings,
  fetchInterfaceFile,
  parseInterfaceFile,
  serializeInterfaceFile,
  type InterfaceSettings,
} from "../../../lib/interface-settings-file";
import { notify } from "../../../lib/notify";
import { pluginDisplayName } from "../../../lib/plugin-display-name";
import {
  DATA_SOURCE_CATALOG,
  DATA_SOURCE_SECTION_LABEL_KEYS,
  DATA_SOURCE_SECTION_ORDER,
  INTERFACE_PROFILES,
  MENU_ITEM_CATALOG,
  MENU_ITEM_GROUPS,
  TOP_LEVEL_MENUS,
  activeInterfaceProfile,
  presetHiddenSets,
} from "../../../lib/ui-profile";
import type { ProfilePlugin } from "./settings-draft";
import { useSettingsDraft } from "./SettingsDraftContext";

interface InterfaceSectionProps {
  /** Toggleable plugins for the UI profile (issue #500). */
  profilePlugins: ProfilePlugin[];
}

/**
 * The Interface section: experience-level presets and per-item visibility for
 * data sources, plugins, menus and menu items.
 *
 * Args:
 *   props: The section props.
 *
 * Returns:
 *   The section content.
 */
export function InterfaceSection({ profilePlugins }: InterfaceSectionProps) {
  const { t } = useTranslation();
  const { draftDesktopSettings, setDraftDesktopSettings, setError } = useSettingsDraft();
  const { setLanguage } = useLanguage();
  const [interfaceUrl, setInterfaceUrl] = useState("");
  const [loadingUrl, setLoadingUrl] = useState(false);
  const locked = draftDesktopSettings.uiProfile.locked;

  // Export what the dialog shows: the draft layout and profile, with the
  // language and theme, which those sections commit as they change.
  const exportInterface = async () => {
    try {
      const current = useDesktopSettingsStore.getState().desktopSettings;
      await saveTextFileWithFallback(
        serializeInterfaceFile({
          ...current,
          layout: draftDesktopSettings.layout,
          uiProfile: draftDesktopSettings.uiProfile,
        }),
        {
          defaultName: "geolibre-interface.json",
          filters: [{ name: t("settings.interface.fileFilter"), extensions: ["json"] }],
          browserTypes: [
            {
              description: t("settings.interface.fileFilter"),
              accept: { "application/json": [".json"] },
            },
          ],
          mimeType: "application/json",
        },
      );
    } catch (error) {
      console.error("Could not export the interface settings.", error);
      setError(
        t("settings.interface.exportError", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  // An import applies at once, like a theme or language change, and the draft
  // follows so Save does not put the old layout and profile back.
  const applyImported = (imported: InterfaceSettings) => {
    const store = useDesktopSettingsStore.getState();
    store.setDesktopSettings(applyInterfaceSettings(store.desktopSettings, imported));
    setDraftDesktopSettings((current) => ({
      ...current,
      ...(imported.layout ? { layout: imported.layout } : {}),
      ...(imported.uiProfile ? { uiProfile: imported.uiProfile } : {}),
    }));
    if (imported.language !== undefined) setLanguage(imported.language);
    setError(null);
    notify.success(t("settings.interface.imported"), { dedupeKey: "interface-imported" });
  };

  const reportImportError = (error: unknown) => {
    console.error("Could not import the interface settings.", error);
    setError(
      t("settings.interface.importError", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const importInterfaceFile = async () => {
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [{ name: t("settings.interface.fileFilter"), extensions: ["json"] }],
        accept: ".json,application/json",
        readText: true,
      });
      if (!result || result.text === undefined) return;
      applyImported(parseInterfaceFile(result.text));
    } catch (error) {
      reportImportError(error);
    }
  };

  const importInterfaceUrl = async () => {
    setLoadingUrl(true);
    try {
      applyImported(await fetchInterfaceFile(interfaceUrl));
      setInterfaceUrl("");
    } catch (error) {
      reportImportError(error);
    } finally {
      setLoadingUrl(false);
    }
  };

  const updateUiProfile = (patch: Partial<UiProfileSettings>) => {
    setDraftDesktopSettings((current) => ({
      ...current,
      uiProfile: { ...current.uiProfile, ...patch },
    }));
    setError(null);
  };

  // Applying an experience-level preset overwrites the hidden lists from tiers
  // and turns the profile on. Plugin tiers consider the toggleable plugin ids.
  const applyExperiencePreset = (level: ExperienceLevel) => {
    const sets = presetHiddenSets(
      level,
      profilePlugins.map((plugin) => plugin.id),
    );
    updateUiProfile({ enabled: true, level, ...sets });
  };

  // Selecting "Custom" enables filtering and clears the preset level without
  // touching the hidden lists, so the current checkbox configuration is carried
  // through verbatim (issue #592). From the legacy "show everything" state this
  // simply opts into custom mode with everything still visible.
  const applyCustomProfile = () => {
    updateUiProfile({ enabled: true, level: null });
  };

  // Toggling a single item switches the profile to "custom" (level = null) and
  // enables filtering so the edit takes effect even when starting from the
  // legacy "show everything" state.
  const toggleDataSourceHidden = (id: string, visible: boolean) => {
    setDraftDesktopSettings((current) => {
      const hidden = new Set(current.uiProfile.hiddenDataSources);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return {
        ...current,
        uiProfile: {
          ...current.uiProfile,
          enabled: true,
          level: null,
          hiddenDataSources: [...hidden],
        },
      };
    });
    setError(null);
  };

  const togglePluginHidden = (id: string, visible: boolean) => {
    setDraftDesktopSettings((current) => {
      const hidden = new Set(current.uiProfile.hiddenPlugins);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return {
        ...current,
        uiProfile: {
          ...current.uiProfile,
          enabled: true,
          level: null,
          hiddenPlugins: [...hidden],
        },
      };
    });
    setError(null);
  };

  const toggleMenuHidden = (id: string, visible: boolean) => {
    setDraftDesktopSettings((current) => {
      const hidden = new Set(current.uiProfile.hiddenMenus);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return {
        ...current,
        uiProfile: {
          ...current.uiProfile,
          enabled: true,
          level: null,
          hiddenMenus: [...hidden],
        },
      };
    });
    setError(null);
  };

  const toggleMenuItemHidden = (id: string, visible: boolean) => {
    setDraftDesktopSettings((current) => {
      const hidden = new Set(current.uiProfile.hiddenMenuItems);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return {
        ...current,
        uiProfile: {
          ...current.uiProfile,
          enabled: true,
          level: null,
          hiddenMenuItems: [...hidden],
        },
      };
    });
    setError(null);
  };

  // Reset clears the profile to "show everything" but preserves the admin lock
  // and the onboarding flag.
  const resetUiProfile = () => {
    updateUiProfile({
      enabled: DEFAULT_UI_PROFILE_SETTINGS.enabled,
      level: DEFAULT_UI_PROFILE_SETTINGS.level,
      hiddenDataSources: [],
      hiddenPlugins: [],
      hiddenMenus: [],
      hiddenMenuItems: [],
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("settings.interface.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("settings.interface.description")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={draftDesktopSettings.uiProfile.locked}
          onClick={resetUiProfile}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("common.reset")}
        </Button>
      </div>
      {draftDesktopSettings.uiProfile.locked ? (
        <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          {t("settings.interface.lockedNote")}
        </div>
      ) : null}
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm">{t("settings.interface.fileTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("settings.interface.fileHint")}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void exportInterface()}
            >
              <Download className="h-3.5 w-3.5" />
              {t("settings.interface.export")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => void importInterfaceFile()}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("settings.interface.import")}
            </Button>
          </div>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void importInterfaceUrl();
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="settings-interface-url">{t("settings.interface.importUrl")}</Label>
            <Input
              id="settings-interface-url"
              type="url"
              placeholder="https://example.com/geolibre-interface.json"
              value={interfaceUrl}
              disabled={locked || loadingUrl}
              onChange={(event) => setInterfaceUrl(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={locked || loadingUrl || !interfaceUrl.trim()}
          >
            <Link2 className="h-3.5 w-3.5" />
            {loadingUrl ? t("settings.interface.loadingUrl") : t("settings.interface.loadUrl")}
          </Button>
        </form>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.interface.presets")}
        </h4>
        <div className="flex flex-wrap gap-2">
          {INTERFACE_PROFILES.map((option) => {
            const active = activeInterfaceProfile(draftDesktopSettings.uiProfile) === option;
            return (
              <Button
                key={option}
                type="button"
                size="sm"
                // The active profile gets the solid primary fill so it
                // reads clearly as the running state, including
                // "custom" (issue #592). Inactive choices stay
                // outlined.
                variant={active ? "default" : "outline"}
                // "custom" activates automatically when an item is
                // toggled below, but it is also directly clickable so
                // the user can opt into custom mode while keeping the
                // current configuration intact.
                disabled={draftDesktopSettings.uiProfile.locked}
                aria-current={active ? true : undefined}
                onClick={
                  option === "custom" ? applyCustomProfile : () => applyExperiencePreset(option)
                }
              >
                {t(`settings.interface.level.${option}`)}
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.interface.presetsHint")}</p>
      </div>
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.interface.dataSources")}
        </h4>
        {DATA_SOURCE_SECTION_ORDER.map((sectionId) => (
          <div key={sectionId} className="space-y-1.5">
            <h5 className="text-xs font-medium text-muted-foreground">
              {t(DATA_SOURCE_SECTION_LABEL_KEYS[sectionId])}
            </h5>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {DATA_SOURCE_CATALOG.filter((entry) => entry.section === sectionId).map((entry) => (
                <label
                  key={entry.id}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <input
                    className="h-4 w-4"
                    type="checkbox"
                    checked={!draftDesktopSettings.uiProfile.hiddenDataSources.includes(entry.id)}
                    disabled={draftDesktopSettings.uiProfile.locked}
                    onChange={(event) => toggleDataSourceHidden(entry.id, event.target.checked)}
                  />
                  <span>{t(entry.labelKey)}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      {profilePlugins.length > 0 ? (
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("settings.interface.plugins")}
          </h4>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {profilePlugins.map((plugin) => (
              <label
                key={plugin.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <input
                  className="h-4 w-4"
                  type="checkbox"
                  checked={!draftDesktopSettings.uiProfile.hiddenPlugins.includes(plugin.id)}
                  disabled={draftDesktopSettings.uiProfile.locked}
                  onChange={(event) => togglePluginHidden(plugin.id, event.target.checked)}
                />
                <span>{pluginDisplayName(t, plugin)}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.interface.menus")}
        </h4>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {TOP_LEVEL_MENUS.map((menu) => (
            <label
              key={menu.id}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
            >
              <input
                className="h-4 w-4"
                type="checkbox"
                checked={!draftDesktopSettings.uiProfile.hiddenMenus.includes(menu.id)}
                disabled={draftDesktopSettings.uiProfile.locked}
                onChange={(event) => toggleMenuHidden(menu.id, event.target.checked)}
              />
              <span>{t(menu.labelKey)}</span>
            </label>
          ))}
        </div>
      </div>
      {MENU_ITEM_GROUPS.map((group) => (
        <div key={group.menuId} className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t(group.labelKey)}
          </h4>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {MENU_ITEM_CATALOG.filter((entry) => entry.menuId === group.menuId).map((entry) => (
              <label
                key={entry.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <input
                  className="h-4 w-4"
                  type="checkbox"
                  checked={!draftDesktopSettings.uiProfile.hiddenMenuItems.includes(entry.id)}
                  disabled={draftDesktopSettings.uiProfile.locked}
                  onChange={(event) => toggleMenuItemHidden(entry.id, event.target.checked)}
                />
                <span>{t(entry.labelKey)}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
