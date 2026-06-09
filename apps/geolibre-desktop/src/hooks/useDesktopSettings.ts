import { isAllowedPluginManifestUrl } from "@geolibre/core";
import { useEffect } from "react";
import { create } from "zustand";
import { normalizeStringList } from "../lib/string-lists";

const DESKTOP_SETTINGS_STORAGE_KEY = "geolibre.desktopSettings";

export interface DesktopSettings {
  additionalPluginDirectories: string[];
  layout: DesktopLayoutSettings;
  pluginManifestUrls: string[];
  /** Personal API token for uploading projects to share.geolibre.app. */
  shareToken: string;
}

export interface DesktopLayoutSettings {
  attributePanelVisible: boolean;
  layerPanelVisible: boolean;
  showProjectInfo: boolean;
  stylePanelVisible: boolean;
  toolbarLabels: boolean;
}

interface DesktopSettingsState {
  desktopSettings: DesktopSettings;
  setDesktopSettings: (settings: DesktopSettings) => void;
}

export const DEFAULT_DESKTOP_LAYOUT_SETTINGS: DesktopLayoutSettings = {
  attributePanelVisible: true,
  layerPanelVisible: true,
  showProjectInfo: true,
  stylePanelVisible: true,
  toolbarLabels: true,
};

const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  additionalPluginDirectories: [],
  layout: DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  pluginManifestUrls: [],
  shareToken: "",
};

function normalizeDesktopSettings(settings: unknown): DesktopSettings {
  if (!settings || typeof settings !== "object") {
    return DEFAULT_DESKTOP_SETTINGS;
  }

  const candidate = settings as Partial<DesktopSettings>;
  return {
    additionalPluginDirectories: normalizeStringList(
      candidate.additionalPluginDirectories,
    ),
    layout: normalizeDesktopLayoutSettings(candidate.layout),
    // Apply the same scheme rule as project-file loading so stale or edited
    // localStorage values cannot smuggle in disallowed URL schemes.
    pluginManifestUrls: normalizeStringList(candidate.pluginManifestUrls).filter(
      isAllowedPluginManifestUrl,
    ),
    shareToken:
      typeof candidate.shareToken === "string" ? candidate.shareToken.trim() : "",
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
    attributePanelVisible:
      typeof candidate.attributePanelVisible === "boolean"
        ? candidate.attributePanelVisible
        : DEFAULT_DESKTOP_LAYOUT_SETTINGS.attributePanelVisible,
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
