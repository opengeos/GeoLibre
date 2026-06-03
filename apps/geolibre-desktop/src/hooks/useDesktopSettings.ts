import { isAllowedPluginManifestUrl } from "@geolibre/core";
import { useEffect } from "react";
import { create } from "zustand";
import { normalizeStringList } from "../lib/string-lists";

const DESKTOP_SETTINGS_STORAGE_KEY = "geolibre.desktopSettings";

export interface DesktopSettings {
  additionalPluginDirectories: string[];
  pluginManifestUrls: string[];
}

interface DesktopSettingsState {
  desktopSettings: DesktopSettings;
  setDesktopSettings: (settings: DesktopSettings) => void;
}

const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  additionalPluginDirectories: [],
  pluginManifestUrls: [],
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
    // Apply the same scheme rule as project-file loading so stale or edited
    // localStorage values cannot smuggle in disallowed URL schemes.
    pluginManifestUrls: normalizeStringList(candidate.pluginManifestUrls).filter(
      isAllowedPluginManifestUrl,
    ),
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
