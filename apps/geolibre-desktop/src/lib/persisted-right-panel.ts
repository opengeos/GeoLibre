// The registry subpath rather than the package barrel: this module is a leaf the
// test suite imports directly, and the barrel pulls in the whole built-in plugin
// registry (including CSS imports Node cannot load). See docs/maintenance.md on testing
// against a leaf module.
import {
  collapseRightPanel,
  closeRightPanel,
  getRightPanel,
  isRightPanelVisible,
  openRightPanel,
  registerRightPanel,
  subscribeRightPanels,
} from "@geolibre/plugins/right-panel-registry";
import type { GeoLibreRightPanelRegistration } from "@geolibre/plugins";
import { useDesktopSettingsStore, type DesktopLayoutSettings } from "../hooks/useDesktopSettings";

/**
 * Layout settings that persist a dockable right panel's visibility. The Browser
 * and Comments panels are the two built-in panels that work this way; plugin
 * panels are owned by their plugin and are not persisted here.
 */
export type PersistedPanelKey = Extract<
  keyof DesktopLayoutSettings,
  "browserPanelVisible" | "commentsPanelVisible"
>;

/** Read a panel's persisted visibility, bypassing React so callers can seed. */
export function isPanelVisibleInSettings(key: PersistedPanelKey): boolean {
  return useDesktopSettingsStore.getState().desktopSettings.layout[key];
}

/** Persist a panel's visibility. A no-op when the value already matches. */
export function setPanelVisibleInSettings(key: PersistedPanelKey, visible: boolean): void {
  const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
  if (desktopSettings.layout[key] === visible) return;
  setDesktopSettings({
    ...desktopSettings,
    layout: { ...desktopSettings.layout, [key]: visible },
  });
}

/**
 * Move a panel to `visible`, showing it collapsed on its rail so re-enabling it
 * does not jump to an expanded panel that buries its neighbour. Bails out when
 * the panel is already where it is being asked to go, so a caller re-applying an
 * unchanged value cannot collapse a panel the user had expanded.
 */
export function applyRightPanelVisibility(panelId: string, visible: boolean): void {
  if (isRightPanelVisible(panelId) === visible) return;
  if (visible) {
    openRightPanel(panelId);
    collapseRightPanel(panelId);
  } else {
    closeRightPanel(panelId);
  }
}

/**
 * Register a dockable right panel whose visibility is a persisted layout
 * setting, and keep the two in step. Returns a disposer that unsubscribes
 * before unregistering.
 *
 * Visibility is seeded from the setting at registration, so a panel the user
 * turned off stays off across restarts instead of reopening on every launch
 * (GeoLibre#1935). From then on the setting mirrors the registry, which matters
 * because the panel can be closed from its own header as well as from Settings
 * → Layout: for these panels closing is not a transient collapse, it removes
 * the rail entry entirely and only Settings can bring it back, so it is a
 * preference either way. Mirroring is what keeps the Settings checkbox, the
 * panel on screen, and the stored value from ever disagreeing.
 *
 * Two registry events are deliberately *not* mirrored:
 *
 * - The `emit` from registration itself, because the panel is legitimately not
 *   visible yet. The subscription is therefore attached after the seed.
 * - The `emit` from unregistering on unmount, which would otherwise persist
 *   `false` every time the shell tears down. `unregisterRightPanel` removes the
 *   panel from the registry before it emits, so the `getRightPanel` guard
 *   catches it; the disposer unsubscribing first makes that belt-and-braces.
 *
 * Being displaced by another panel is not a close (the registry keeps a
 * displaced panel in `visibleIds`), so it correctly writes nothing.
 */
export function registerPersistedRightPanel(
  registration: GeoLibreRightPanelRegistration,
  key: PersistedPanelKey,
): () => void {
  const dispose = registerRightPanel(registration);
  applyRightPanelVisibility(registration.id, isPanelVisibleInSettings(key));
  const unsubscribe = subscribeRightPanels(() => {
    if (!getRightPanel(registration.id)) return;
    setPanelVisibleInSettings(key, isRightPanelVisible(registration.id));
  });
  return () => {
    unsubscribe();
    dispose();
  };
}
