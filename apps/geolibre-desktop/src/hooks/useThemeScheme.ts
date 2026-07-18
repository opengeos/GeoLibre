import { useLayoutEffect } from "react";
import { applyThemeScheme } from "../lib/theme-schemes";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * Keeps the document's `data-theme` attribute in sync with the persisted accent
 * scheme. Pairs with `useThemeMode` (light/dark): mode toggles the `.dark` class,
 * this hook sets the accent scheme on top of it.
 */
export function useThemeScheme(): void {
  const scheme = useDesktopSettingsStore((state) => state.desktopSettings.theme.scheme);
  const customColor = useDesktopSettingsStore((state) => state.desktopSettings.theme.customColor);

  useLayoutEffect(() => {
    applyThemeScheme(scheme, customColor);
  }, [scheme, customColor]);
}
