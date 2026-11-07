import { useAppStore } from "@geolibre/core";
import {
  getRightPanel,
  openRightPanel,
  subscribeRightPanels,
} from "@geolibre/plugins/right-panel-registry";
import {
  getFloatingPanel,
  openFloatingPanel,
  subscribeFloatingPanels,
} from "@geolibre/plugins/floating-panel-registry";

/**
 * Predicate determining whether the active workspace is a fresh, untitled project.
 * Returns true only when no saved project has been loaded and no file path is set.
 */
export function isStartupProjectFresh(): boolean {
  const s = useAppStore.getState();
  return !s.projectLoaded && s.projectPath === null;
}

/**
 * Opens a designated panel (dockable right-panel or floating) on startup for a fresh project.
 *
 * If the target panel is already registered, it is opened immediately. If the panel
 * registers asynchronously (e.g. while an external plugin completes its initialization),
 * this subscribes to the right-panel and floating-panel registries and opens the panel
 * the moment it becomes available, then unsubscribes immediately.
 *
 * If the current project is not fresh (or becomes non-fresh before the panel registers),
 * any pending subscription is cancelled without opening the panel.
 *
 * @param panelId - The id of the panel to open.
 * @param isFreshProject - Predicate returning true only while the current project is fresh.
 * @param onOpened - Optional callback invoked when the panel successfully opens.
 * @returns A disposer that unsubscribes any active registry listeners.
 */
export function openStartupPanel(
  panelId: string,
  isFreshProject: () => boolean = isStartupProjectFresh,
  onOpened?: () => void,
): () => void {
  const trimmed = panelId.trim();
  if (!trimmed || !isFreshProject()) return () => {};

  let unsubscribed = false;
  let unsubRight: (() => void) | null = null;
  let unsubFloating: (() => void) | null = null;

  const cleanup = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsubStore();
    unsubRight?.();
    unsubFloating?.();
  };

  const unsubStore = useAppStore.subscribe(() => {
    if (!isFreshProject()) {
      cleanup();
    }
  });

  const tryOpen = (): boolean => {
    if (!isFreshProject()) {
      cleanup();
      return true;
    }
    if (getRightPanel(trimmed)) {
      cleanup();
      if (openRightPanel(trimmed)) {
        onOpened?.();
      }
      return true;
    }
    if (getFloatingPanel(trimmed)) {
      cleanup();
      if (openFloatingPanel(trimmed)) {
        onOpened?.();
      }
      return true;
    }
    return false;
  };

  if (tryOpen()) {
    return cleanup;
  }

  const onRegistryChange = () => {
    if (unsubscribed) return;
    tryOpen();
  };

  unsubRight = subscribeRightPanels(onRegistryChange);
  unsubFloating = subscribeFloatingPanels(onRegistryChange);

  return cleanup;
}
