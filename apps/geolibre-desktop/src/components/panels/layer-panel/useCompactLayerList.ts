import { useCallback } from "react";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";

/**
 * Whether the Layers panel shows its compact list, and a setter that persists
 * the choice to the per-user layout settings (not the project, so opening a
 * shared project never changes how a viewer's panel looks).
 *
 * @returns The current flag and a setter.
 */
export function useCompactLayerList(): [boolean, (compact: boolean) => void] {
  const compact = useDesktopSettingsStore((s) => s.desktopSettings.layout.compactLayerList);
  const setCompact = useCallback((next: boolean) => {
    const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
    if (desktopSettings.layout.compactLayerList === next) return;
    setDesktopSettings({
      ...desktopSettings,
      layout: { ...desktopSettings.layout, compactLayerList: next },
    });
  }, []);
  return [compact, setCompact];
}
