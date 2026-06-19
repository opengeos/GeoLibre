import { isAllowedPluginManifestUrl } from "@geolibre/core";
import { useEffect } from "react";
import { create } from "zustand";
import { normalizeStringList } from "../lib/string-lists";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../lib/storage-keys";

export interface DesktopSettings {
  additionalPluginDirectories: string[];
  /**
   * Persisted UI language code (e.g. `"en"`, `"zh"`). Empty string means "follow
   * automatic detection" (browser/default). The i18n layer reads this directly
   * from localStorage on startup; a `?locale`/`?lang` query param overrides it
   * for embeds. See `src/i18n/index.ts`.
   */
  language: string;
  layout: DesktopLayoutSettings;
  pluginManifestUrls: string[];
  /**
   * Personal API token for uploading projects to share.geolibre.app. Stored in
   * the same localStorage-backed settings as everything else, so on the web
   * build it shares the exposure surface of any other localStorage entry (a
   * same-origin script could read it). This is the well-understood "PAT in local
   * storage" trade-off; the token is short-lived/revocable and scoped to one
   * service. Moving it to OS secure storage on desktop is a possible future
   * hardening (see PR #190 review).
   */
  shareToken: string;
  /**
   * Customizable UI profile: which data sources / web services / plugins are
   * visible, an optional experience-level preset, first-launch onboarding state,
   * and an admin lock. See `src/lib/ui-profile.ts` and `docs/ui-profiles.md`.
   */
  uiProfile: UiProfileSettings;
}

export interface DesktopLayoutSettings {
  layerPanelVisible: boolean;
  showProjectInfo: boolean;
  stylePanelVisible: boolean;
  toolbarLabels: boolean;
}

/** Experience-level presets offered by the onboarding wizard and Settings. */
export type ExperienceLevel = "beginner" | "intermediate" | "advanced";

export interface UiProfileSettings {
  /**
   * When false, every data source and plugin is visible regardless of the hidden
   * lists below. This is the back-compat default so existing users see no change
   * until they opt in via onboarding, the Settings dialog, or an admin file.
   */
  enabled: boolean;
  /**
   * The experience-level preset last applied, or null for a custom selection
   * (the user manually toggled an item). Only used to highlight the active preset.
   */
  level: ExperienceLevel | null;
  /** Whether the first-launch onboarding wizard has been completed or dismissed. */
  onboarded: boolean;
  /**
   * Set by an admin config file (`docs/ui-profiles.md`). When true the profile is
   * managed centrally and the Settings controls are disabled.
   */
  locked: boolean;
  /** Data-source catalog ids hidden from the Add Data menu. */
  hiddenDataSources: string[];
  /** Plugin ids hidden from the Plugins menu. */
  hiddenPlugins: string[];
  /** Top-level toolbar menu ids hidden entirely (e.g. `processing`, `help`). */
  hiddenMenus: string[];
  /**
   * Menu-item catalog ids hidden from their menu (Project/Edit/Processing/
   * Controls/Settings/Help). Add Data and Plugins use the two lists above.
   */
  hiddenMenuItems: string[];
}

interface DesktopSettingsState {
  desktopSettings: DesktopSettings;
  setDesktopSettings: (settings: DesktopSettings) => void;
}

export const DEFAULT_DESKTOP_LAYOUT_SETTINGS: DesktopLayoutSettings = {
  layerPanelVisible: true,
  showProjectInfo: true,
  stylePanelVisible: true,
  toolbarLabels: true,
};

export const DEFAULT_UI_PROFILE_SETTINGS: UiProfileSettings = {
  enabled: false,
  level: null,
  onboarded: false,
  locked: false,
  hiddenDataSources: [],
  hiddenPlugins: [],
  hiddenMenus: [],
  hiddenMenuItems: [],
};

const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  additionalPluginDirectories: [],
  language: "",
  layout: DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  pluginManifestUrls: [],
  shareToken: "",
  uiProfile: DEFAULT_UI_PROFILE_SETTINGS,
};

/** The experience-level presets, in order. Single source of truth. */
export const EXPERIENCE_LEVELS: readonly ExperienceLevel[] = [
  "beginner",
  "intermediate",
  "advanced",
];

function normalizeDesktopSettings(settings: unknown): DesktopSettings {
  if (!settings || typeof settings !== "object") {
    return DEFAULT_DESKTOP_SETTINGS;
  }

  const candidate = settings as Partial<DesktopSettings>;
  return {
    additionalPluginDirectories: normalizeStringList(
      candidate.additionalPluginDirectories,
    ),
    language:
      typeof candidate.language === "string" ? candidate.language.trim() : "",
    layout: normalizeDesktopLayoutSettings(candidate.layout),
    // Apply the same scheme rule as project-file loading so stale or edited
    // localStorage values cannot smuggle in disallowed URL schemes.
    pluginManifestUrls: normalizeStringList(candidate.pluginManifestUrls).filter(
      isAllowedPluginManifestUrl,
    ),
    shareToken:
      typeof candidate.shareToken === "string" ? candidate.shareToken.trim() : "",
    uiProfile: normalizeUiProfileSettings(candidate.uiProfile),
  };
}

function normalizeUiProfileSettings(profile: unknown): UiProfileSettings {
  if (!profile || typeof profile !== "object") {
    return DEFAULT_UI_PROFILE_SETTINGS;
  }

  // Require strict booleans and a known level so tampered localStorage values
  // cannot smuggle non-boolean / unknown values into the profile.
  const candidate = profile as Partial<UiProfileSettings>;
  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : DEFAULT_UI_PROFILE_SETTINGS.enabled,
    level:
      typeof candidate.level === "string" &&
      EXPERIENCE_LEVELS.includes(candidate.level as ExperienceLevel)
        ? (candidate.level as ExperienceLevel)
        : null,
    onboarded:
      typeof candidate.onboarded === "boolean"
        ? candidate.onboarded
        : DEFAULT_UI_PROFILE_SETTINGS.onboarded,
    locked:
      typeof candidate.locked === "boolean"
        ? candidate.locked
        : DEFAULT_UI_PROFILE_SETTINGS.locked,
    hiddenDataSources: normalizeStringList(candidate.hiddenDataSources),
    hiddenPlugins: normalizeStringList(candidate.hiddenPlugins),
    hiddenMenus: normalizeStringList(candidate.hiddenMenus),
    hiddenMenuItems: normalizeStringList(candidate.hiddenMenuItems),
  };
}

function normalizeDesktopLayoutSettings(
  layout: unknown,
): DesktopLayoutSettings {
  if (!layout || typeof layout !== "object") {
    return DEFAULT_DESKTOP_LAYOUT_SETTINGS;
  }

  // Require strict booleans so tampered localStorage values (e.g. "yes")
  // cannot smuggle non-boolean values into the layout settings.
  const candidate = layout as Partial<DesktopLayoutSettings>;
  return {
    layerPanelVisible:
      typeof candidate.layerPanelVisible === "boolean"
        ? candidate.layerPanelVisible
        : DEFAULT_DESKTOP_LAYOUT_SETTINGS.layerPanelVisible,
    showProjectInfo:
      typeof candidate.showProjectInfo === "boolean"
        ? candidate.showProjectInfo
        : DEFAULT_DESKTOP_LAYOUT_SETTINGS.showProjectInfo,
    stylePanelVisible:
      typeof candidate.stylePanelVisible === "boolean"
        ? candidate.stylePanelVisible
        : DEFAULT_DESKTOP_LAYOUT_SETTINGS.stylePanelVisible,
    toolbarLabels:
      typeof candidate.toolbarLabels === "boolean"
        ? candidate.toolbarLabels
        : DEFAULT_DESKTOP_LAYOUT_SETTINGS.toolbarLabels,
  };
}

function loadDesktopSettings(): DesktopSettings {
  if (typeof window === "undefined") return DEFAULT_DESKTOP_SETTINGS;

  try {
    const stored = window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY);
    if (!stored) return DEFAULT_DESKTOP_SETTINGS;
    return normalizeDesktopSettings(JSON.parse(stored) as unknown);
  } catch {
    return DEFAULT_DESKTOP_SETTINGS;
  }
}

function saveDesktopSettings(settings: DesktopSettings): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      DESKTOP_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // Persistence is best-effort; ignore quota or disabled-storage errors.
  }
}

export const useDesktopSettingsStore = create<DesktopSettingsState>((set) => ({
  desktopSettings: loadDesktopSettings(),
  setDesktopSettings: (settings) =>
    set({ desktopSettings: normalizeDesktopSettings(settings) }),
}));

export function useDesktopSettingsPersistence() {
  useEffect(() => {
    saveDesktopSettings(useDesktopSettingsStore.getState().desktopSettings);

    return useDesktopSettingsStore.subscribe((state, previous) => {
      if (state.desktopSettings !== previous.desktopSettings) {
        saveDesktopSettings(state.desktopSettings);
      }
    });
  }, []);
}
