import { isAllowedPluginManifestUrl } from "@geolibre/core";
import { useEffect } from "react";
import { create } from "zustand";
import { normalizeStringList } from "../lib/string-lists";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../lib/storage-keys";
import {
  DEFAULT_CUSTOM_COLOR,
  DEFAULT_THEME_SCHEME,
  isHexColor,
  isThemeScheme,
  type ThemeScheme,
} from "../lib/theme-schemes";
import type { UpdateNotificationLevel } from "../lib/updates";

/** Notification-granularity options, in order. Single source of truth. */
export const UPDATE_NOTIFICATION_LEVELS: readonly UpdateNotificationLevel[] = [
  "all",
  "minor",
  "major",
];

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
   * Cesium Ion access token for the 3D-globe view (Cesium World Imagery +
   * Terrain need one). Stored here — device-local localStorage, not the shared
   * project file — so a personal credential is never serialized into a
   * `.geolibre.json` a user shares. Projected into `VITE_CESIUM_TOKEN` at
   * runtime by `useRuntimeEnvironmentVariables`, and resolved through
   * `getCesiumIonToken`, so it overrides the build-time token with no rebuild.
   * Same "token in localStorage" trade-off as {@link shareToken}.
   */
  cesiumIonToken: string;
  /**
   * AI Assistant provider credentials (Settings → AI Providers), keyed by the
   * runtime environment variable each field maps to (e.g. `ANTHROPIC_API_KEY`,
   * `OPENAI_API_KEY`, `OLLAMA_BASE_URL`). Stored here — device-local
   * localStorage, not the shared project file — so a personal API key survives
   * app restarts (the desktop webview persists localStorage across launches)
   * yet is never serialized into a `.geolibre.json` a user shares. Projected
   * into `window.__GEOLIBRE_RUNTIME_ENV__` at runtime by
   * `useRuntimeEnvironmentVariables`, below any explicit project Environment
   * variable of the same name. Same "secret in localStorage" trade-off as
   * {@link cesiumIonToken}.
   */
  aiProviderEnv: Record<string, string>;
  /**
   * Appearance preferences (the accent color scheme). The light/dark mode is
   * handled separately by `useThemeMode` (it tracks the OS / embed preference).
   */
  theme: ThemeSettings;
  /**
   * Customizable UI profile: which data sources / web services / plugins are
   * visible, an optional experience-level preset, first-launch onboarding state,
   * and an admin lock. See `src/lib/ui-profile.ts` and `docs/ui-profiles.md`.
   */
  uiProfile: UiProfileSettings;
  /**
   * Automated software-update preferences. The startup check only runs in the
   * desktop (Tauri) build; on the web these settings are inert.
   */
  updates: UpdateSettings;
}

export interface ThemeSettings {
  /** Accent color scheme. Presets set a `data-theme` attribute on <html>. */
  scheme: ThemeScheme;
  /** Hex color backing the "custom" scheme (ignored by the presets). */
  customColor: string;
}

export interface UpdateSettings {
  /** Whether to check for a newer version each time the desktop app starts. */
  checkOnStartup: boolean;
  /** Which kinds of releases raise a startup notification. */
  notificationLevel: UpdateNotificationLevel;
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
  // Ship the Advanced interface by default (`enabled: false` shows every item,
  // which `activeInterfaceProfile` reports as "advanced") and skip the
  // first-launch welcome dialog (`onboarded: true`). Users can still switch to a
  // curated preset from the Settings dialog.
  enabled: false,
  level: null,
  onboarded: true,
  locked: false,
  hiddenDataSources: [],
  hiddenPlugins: [],
  hiddenMenus: [],
  hiddenMenuItems: [],
};

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  checkOnStartup: true,
  notificationLevel: "all",
};

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  scheme: DEFAULT_THEME_SCHEME,
  customColor: DEFAULT_CUSTOM_COLOR,
};

const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  additionalPluginDirectories: [],
  language: "",
  layout: DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  pluginManifestUrls: [],
  shareToken: "",
  cesiumIonToken: "",
  aiProviderEnv: {},
  theme: DEFAULT_THEME_SETTINGS,
  uiProfile: DEFAULT_UI_PROFILE_SETTINGS,
  updates: DEFAULT_UPDATE_SETTINGS,
};

/** The experience-level presets, in order. Single source of truth. */
export const EXPERIENCE_LEVELS: readonly ExperienceLevel[] = [
  "beginner",
  "intermediate",
  "advanced",
];

export function normalizeDesktopSettings(settings: unknown): DesktopSettings {
  if (!settings || typeof settings !== "object") {
    return DEFAULT_DESKTOP_SETTINGS;
  }

  const candidate = settings as Partial<DesktopSettings>;
  return {
    additionalPluginDirectories: normalizeStringList(candidate.additionalPluginDirectories),
    language: typeof candidate.language === "string" ? candidate.language.trim() : "",
    layout: normalizeDesktopLayoutSettings(candidate.layout),
    // Apply the same scheme rule as project-file loading so stale or edited
    // localStorage values cannot smuggle in disallowed URL schemes.
    pluginManifestUrls: normalizeStringList(candidate.pluginManifestUrls).filter(
      isAllowedPluginManifestUrl,
    ),
    shareToken: typeof candidate.shareToken === "string" ? candidate.shareToken.trim() : "",
    cesiumIonToken:
      typeof candidate.cesiumIonToken === "string" ? candidate.cesiumIonToken.trim() : "",
    aiProviderEnv: normalizeEnvRecord(candidate.aiProviderEnv),
    theme: normalizeThemeSettings(candidate.theme),
    uiProfile: normalizeUiProfileSettings(candidate.uiProfile),
    updates: normalizeUpdateSettings(candidate.updates),
  };
}

/**
 * Coerce a persisted (or tampered) value into a clean env-var record: entries
 * with a non-empty trimmed name mapped to a non-empty string value. Blank keys,
 * blank values, and non-string values are dropped so a malformed localStorage
 * entry cannot inject bad values into the runtime environment and the persisted
 * blob never accrues empty leftovers (every consumer treats a blank as unset).
 */
function normalizeEnvRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (name && typeof entry === "string" && entry) result[name] = entry;
  }
  return result;
}

function normalizeThemeSettings(theme: unknown): ThemeSettings {
  if (!theme || typeof theme !== "object") {
    return DEFAULT_THEME_SETTINGS;
  }

  // Require a known scheme id and a valid hex color so tampered localStorage
  // values cannot smuggle an unknown scheme into the `data-theme` attribute or an
  // arbitrary string into the inline custom-color tokens.
  const candidate = theme as Partial<ThemeSettings>;
  return {
    scheme: isThemeScheme(candidate.scheme) ? candidate.scheme : DEFAULT_THEME_SETTINGS.scheme,
    // Normalize so the value bound to `<input type="color">` is exactly
    // `#rrggbb` lowercase (isHexColor already requires the leading `#`).
    customColor: isHexColor(candidate.customColor)
      ? candidate.customColor.trim().toLowerCase()
      : DEFAULT_THEME_SETTINGS.customColor,
  };
}

function normalizeUpdateSettings(updates: unknown): UpdateSettings {
  if (!updates || typeof updates !== "object") {
    return DEFAULT_UPDATE_SETTINGS;
  }

  // Require a strict boolean and a known level so tampered localStorage values
  // cannot smuggle non-boolean / unknown values into the update settings.
  const candidate = updates as Partial<UpdateSettings>;
  return {
    checkOnStartup:
      typeof candidate.checkOnStartup === "boolean"
        ? candidate.checkOnStartup
        : DEFAULT_UPDATE_SETTINGS.checkOnStartup,
    notificationLevel:
      typeof candidate.notificationLevel === "string" &&
      UPDATE_NOTIFICATION_LEVELS.includes(candidate.notificationLevel as UpdateNotificationLevel)
        ? (candidate.notificationLevel as UpdateNotificationLevel)
        : DEFAULT_UPDATE_SETTINGS.notificationLevel,
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
      typeof candidate.locked === "boolean" ? candidate.locked : DEFAULT_UI_PROFILE_SETTINGS.locked,
    hiddenDataSources: normalizeStringList(candidate.hiddenDataSources),
    hiddenPlugins: normalizeStringList(candidate.hiddenPlugins),
    hiddenMenus: normalizeStringList(candidate.hiddenMenus),
    hiddenMenuItems: normalizeStringList(candidate.hiddenMenuItems),
  };
}

function normalizeDesktopLayoutSettings(layout: unknown): DesktopLayoutSettings {
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
    window.localStorage.setItem(DESKTOP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort; ignore quota or disabled-storage errors.
  }
}

export const useDesktopSettingsStore = create<DesktopSettingsState>((set) => ({
  desktopSettings: loadDesktopSettings(),
  setDesktopSettings: (settings) => set({ desktopSettings: normalizeDesktopSettings(settings) }),
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
