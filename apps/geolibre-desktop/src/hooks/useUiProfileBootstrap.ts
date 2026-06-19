import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { loadAdminProfile } from "../lib/admin-profile";
import { presetHiddenSets, toggleablePluginIds } from "../lib/ui-profile";
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
 *    (and skip onboarding — an admin-managed deployment is pre-configured). If
 *    absent, release any lock a previously-applied file left behind.
 * 2. Otherwise, show the first-launch onboarding wizard when it has not yet been
 *    completed.
 * 3. Keep a level preset's hidden plugin list in sync as external/bundled
 *    plugins finish loading after startup.
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

  // One-time admin-profile check. Built-in plugins are registered synchronously
  // at module load, so they are all present here; externally-loaded plugins are
  // reconciled by the effect below as the registry settles.
  useEffect(() => {
    if (bootstrapStarted) return;
    bootstrapStarted = true;

    const pluginIds = toggleablePluginIds(plugins);
    void (async () => {
      try {
        const patch = await loadAdminProfile(pluginIds);
        // Re-read the latest store state after the await so a concurrent update
        // is not clobbered.
        const current = useDesktopSettingsStore.getState().desktopSettings;
        if (patch) {
          useDesktopSettingsStore.getState().setDesktopSettings({
            ...current,
            uiProfile: { ...current.uiProfile, ...patch },
          });
        } else if (current.uiProfile.locked) {
          // The admin file is gone — release a lock a previous deployment left
          // behind so the machine is not stuck locked forever (docs/ui-profiles.md).
          useDesktopSettingsStore.getState().setDesktopSettings({
            ...current,
            uiProfile: { ...current.uiProfile, locked: false },
          });
        }
      } finally {
        // Always unblock onboarding, even if the admin check threw unexpectedly,
        // so a failed profile read can never strand the user on a blank screen.
        useBootstrapStore.getState().markChecked();
      }
    })();
    // Intentionally runs once: `plugins` is snapshotted, not reactive. Late
    // external plugins are handled by the reconcile effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a level preset is active, add any tier-hidden plugins that were not in
  // the registry when the preset was applied (external/bundled drop-ins load
  // asynchronously). Add-only, so it never removes an admin's or the user's
  // explicit entries, and a custom selection (level === null) is left untouched.
  useEffect(() => {
    if (!adminChecked) return;
    const { uiProfile: profile } =
      useDesktopSettingsStore.getState().desktopSettings;
    if (!profile.enabled || profile.level === null) return;

    const { hiddenPlugins } = presetHiddenSets(
      profile.level,
      toggleablePluginIds(plugins),
    );
    const missing = hiddenPlugins.filter(
      (id) => !profile.hiddenPlugins.includes(id),
    );
    if (missing.length === 0) return;

    const current = useDesktopSettingsStore.getState().desktopSettings;
    useDesktopSettingsStore.getState().setDesktopSettings({
      ...current,
      uiProfile: {
        ...current.uiProfile,
        hiddenPlugins: [...current.uiProfile.hiddenPlugins, ...missing],
      },
    });
  }, [plugins, adminChecked]);

  // Derived from store state so completing/dismissing onboarding (which sets
  // `onboarded`) hides the wizard without extra local state.
  const showOnboarding =
    adminChecked && !uiProfile.onboarded && !uiProfile.locked;

  // Marks onboarding complete when the wizard is dismissed without a choice
  // (Escape/overlay). The wizard's own buttons set `onboarded` first, so this is
  // a defensive backstop. Memoised so it stays referentially stable for callers.
  const dismissOnboarding = useCallback(() => {
    const current = useDesktopSettingsStore.getState().desktopSettings;
    if (current.uiProfile.onboarded) return;
    useDesktopSettingsStore.getState().setDesktopSettings({
      ...current,
      uiProfile: { ...current.uiProfile, onboarded: true },
    });
  }, []);

  return { showOnboarding, dismissOnboarding };
}
