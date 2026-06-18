import { useEffect } from "react";
import { create } from "zustand";
import { loadAdminProfile } from "../lib/admin-profile";
import { usePluginRegistry } from "./usePlugins";
import { useDesktopSettingsStore } from "./useDesktopSettings";

// Whether the one-time admin-profile check has finished. Kept in its own store
// so any live component instance observes the result — robust to React 18
// StrictMode mounting effects twice in development.
interface BootstrapState {
  adminChecked: boolean;
  markChecked: () => void;
}

const useBootstrapStore = create<BootstrapState>((set) => ({
  adminChecked: false,
  markChecked: () => set({ adminChecked: true }),
}));

// Module-level so the admin check runs exactly once per page load, even though
// StrictMode mounts/unmounts the effect twice in development.
let bootstrapStarted = false;

/**
 * Bootstrap the customizable UI profile (issue #500) on startup:
 *
 * 1. Look for an admin config file. If present, apply it to the stored profile
 *    (and skip onboarding — an admin-managed deployment is pre-configured).
 * 2. Otherwise, show the first-launch onboarding wizard when it has not yet been
 *    completed.
 *
 * @returns Whether to show the onboarding wizard, and a callback to dismiss it.
 */
export function useUiProfileBootstrap(): {
  showOnboarding: boolean;
  dismissOnboarding: () => void;
} {
  const { plugins } = usePluginRegistry();
  const adminChecked = useBootstrapStore((state) => state.adminChecked);
  const uiProfile = useDesktopSettingsStore(
    (state) => state.desktopSettings.uiProfile,
  );

  useEffect(() => {
    if (bootstrapStarted) return;
    bootstrapStarted = true;

    const pluginIds = plugins.map((plugin) => plugin.id);
    void (async () => {
      const patch = await loadAdminProfile(pluginIds);
      if (patch) {
        const current = useDesktopSettingsStore.getState().desktopSettings;
        useDesktopSettingsStore.getState().setDesktopSettings({
          ...current,
          uiProfile: { ...current.uiProfile, ...patch },
        });
      }
      useBootstrapStore.getState().markChecked();
    })();
  }, [plugins]);

  // Derived from store state so completing/dismissing onboarding (which sets
  // `onboarded`) hides the wizard without extra local state.
  const showOnboarding =
    adminChecked && !uiProfile.onboarded && !uiProfile.locked;

  const dismissOnboarding = () => {
    const current = useDesktopSettingsStore.getState().desktopSettings;
    if (current.uiProfile.onboarded) return;
    useDesktopSettingsStore.getState().setDesktopSettings({
      ...current,
      uiProfile: { ...current.uiProfile, onboarded: true },
    });
  };

  return { showOnboarding, dismissOnboarding };
}
