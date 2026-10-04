import { Button } from "@geolibre/ui";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_UI_PROFILE_SETTINGS,
  type ExperienceLevel,
  type UiProfileSettings,
} from "../../../hooks/useDesktopSettings";
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
