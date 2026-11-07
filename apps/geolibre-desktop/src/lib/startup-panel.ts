import { useAppStore } from "@geolibre/core";
import {
  getActiveRightPanel,
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

/** Readiness signals that gate the deployment policy `plugins.openPanel`. */
export interface StartupPanelGate {
  /** Whether the app runs in the read-only `layout=viewer` preset. */
  viewer: boolean;
  /** Whether the embed hides every side panel. */
  panelsHidden: boolean;
  /** Whether external plugins have finished loading. */
  externalPluginsReady: boolean;
  /** Non-zero once the map is ready. */
  mapReadyGeneration: number;
  /** Whether an initial `?url=` project load has settled. */
  projectUrlSettled: boolean;
  /** Whether an initial native startup project restore has settled. */
  startupProjectSettled: boolean;
}

/**
 * Whether startup is ready for the deployment `openPanel` to be attempted.
 *
 * @param gate - The readiness signals.
 * @returns True when the panel may be opened (freshness is checked separately).
 */
export function isStartupPanelGateOpen(gate: StartupPanelGate): boolean {
  return (
    !gate.viewer &&
    !gate.panelsHidden &&
    gate.externalPluginsReady &&
    gate.mapReadyGeneration > 0 &&
    gate.projectUrlSettled &&
    gate.startupProjectSettled
  );
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
 * any pending subscription is cancelled without opening the panel. A pending wait also
 * ends, without opening, once a different right panel becomes active, so a late
 * registration never displaces a panel the user (or a plugin) opened meanwhile.
 *
 * @param panelId - The id of the panel to open.
 * @param isFreshProject - Predicate returning true only while the current project is fresh.
 * @param onOpened - Optional callback invoked when the panel successfully opens.
 * @param onDisplaced - Optional callback invoked when the wait ends because another
 *   right panel became active.
 * @param activeBaseline - The right panel that was active when waiting first began.
 *   Defaults to the current one; pass the original value when restarting a wait so a
 *   panel opened in between still counts as displacement.
 * @returns A disposer that unsubscribes any active registry listeners.
 */
export function openStartupPanel(
  panelId: string,
  isFreshProject: () => boolean = isStartupProjectFresh,
  onOpened?: () => void,
  onDisplaced?: () => void,
  activeBaseline: string | null = getActiveRightPanel(),
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

  const displaced = (): boolean => {
    const active = getActiveRightPanel();
    if (active === null || active === activeBaseline || active === trimmed) return false;
    cleanup();
    onDisplaced?.();
    return true;
  };

  if (displaced() || tryOpen()) {
    return cleanup;
  }

  const onRegistryChange = () => {
    if (unsubscribed) return;
    if (displaced()) return;
    tryOpen();
  };

  unsubRight = subscribeRightPanels(onRegistryChange);
  unsubFloating = subscribeFloatingPanels(onRegistryChange);

  return cleanup;
}
