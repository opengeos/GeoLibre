import { useAppStore } from "@geolibre/core";
import {
  CLOUDS_PLUGIN_ID,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  GRATICULE_PLUGIN_ID,
  isPluginEngineSupported,
  openRightPanel,
  PRECIPITATION_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
} from "@geolibre/plugins";
import { useMemo } from "react";
import { openSettingsSection } from "../../components/layout/SettingsDialog";
import { EARTH_ENGINE_AVAILABLE } from "../../components/layout/toolbar/ProcessingMenu";
import {
  buildToolbarCommands,
  type ToolbarCommandContext,
} from "../../components/layout/toolbar/toolbar-commands";
import { supportsAddDataRenderer } from "../../lib/add-data-renderer";
import type { Command } from "../../lib/commands";
import {
  filterCommandsByCapabilities,
  filterCommandsByPrivileges,
} from "../../lib/deployment-gates";
import { useGlobalShortcuts } from "../useGlobalShortcuts";

// Atmospheric Effects, Directions, Reverse Geocode, Gridlines, Clouds,
// Precipitation, and the deck.gl viz renderer get no palette toggle: they are
// surfaced under Controls / Add Data instead (matching the menus).
const PALETTE_EXCLUDED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  EFFECTS_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
  GRATICULE_PLUGIN_ID,
  CLOUDS_PLUGIN_ID,
  PRECIPITATION_PLUGIN_ID,
  DECK_VIZ_PLUGIN_ID,
]);

/** Context the hook supplies itself rather than taking from the toolbar. */
type HookSuppliedContext =
  | "paletteExcludedPluginIds"
  | "effectsPluginId"
  | "isPluginEngineSupported"
  | "openRightPanel"
  | "earthEngineAvailable"
  | "onSimplifyInterface"
  | "setCollaborateDialogOpen"
  | "setProcessingOpen"
  | "setSqlWorkspaceOpen"
  | "setPythonConsoleOpen"
  | "setAssistantOpen"
  | "setGeocodeOpen"
  | "setModelBuilderOpen"
  | "setBatchToolsOpen"
  | "setSegmentationOpen"
  | "setObjectDetectionOpen"
  | "setSegmentEverythingOpen"
  | "setConversionOpen"
  | "setVectorToolOpen"
  | "setRasterToolOpen"
  | "setStyleManagerOpen";

export interface UseToolbarCommandsOptions extends Omit<
  ToolbarCommandContext,
  HookSuppliedContext | "capabilities"
> {
  capabilities: { nativeMapInstance: boolean; deckOverlay: boolean };
  /** True for the read-only viewer preset. */
  viewer: boolean;
  /** Whether the live engine can take Add Data requests yet. */
  addDataReady: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
}

/** Open Settings → Interface, where the UI profiles live. */
export function openSimplifyInterface(): void {
  openSettingsSection("interface");
}

/**
 * Builds the toolbar's command registry, applies every gate to it, and binds
 * the global shortcut layer (including Ctrl/Cmd+K and "?") to the result.
 *
 * @param options - The toolbar handlers and state the commands use, plus the
 *   gating inputs.
 * @returns The commands the palette and the cheat sheet may offer.
 */
export function useToolbarCommands(options: UseToolbarCommandsOptions): Command[] {
  const {
    viewer,
    addDataReady,
    capabilities,
    primaryRenderer,
    setCommandPaletteOpen,
    setShortcutsOpen,
  } = options;
  const deploymentCapabilities = useAppStore((state) => state.deploymentCapabilities);
  const appPrivileges = useAppStore((state) => state.capabilities.privileges);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const setConversionOpen = useAppStore((s) => s.setConversionOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setGeocodeOpen = useAppStore((s) => s.setGeocodeOpen);
  const setModelBuilderOpen = useAppStore((s) => s.setModelBuilderOpen);
  const setBatchToolsOpen = useAppStore((s) => s.setBatchToolsOpen);
  const setStyleManagerOpen = useAppStore((s) => s.setStyleManagerOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const setSegmentationOpen = useAppStore((s) => s.setSegmentationOpen);
  const setObjectDetectionOpen = useAppStore((s) => s.setObjectDetectionOpen);
  const setSegmentEverythingOpen = useAppStore((s) => s.setSegmentEverythingOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const setCollaborateDialogOpen = useAppStore((s) => s.setCollaborateDialogOpen);

  const commands = buildToolbarCommands({
    ...options,
    paletteExcludedPluginIds: PALETTE_EXCLUDED_PLUGIN_IDS,
    effectsPluginId: EFFECTS_PLUGIN_ID,
    isPluginEngineSupported,
    openRightPanel,
    earthEngineAvailable: EARTH_ENGINE_AVAILABLE,
    onSimplifyInterface: openSimplifyInterface,
    setCollaborateDialogOpen,
    setProcessingOpen,
    setSqlWorkspaceOpen,
    setPythonConsoleOpen,
    setAssistantOpen,
    setGeocodeOpen,
    setModelBuilderOpen,
    setBatchToolsOpen,
    setSegmentationOpen,
    setObjectDetectionOpen,
    setSegmentEverythingOpen,
    setConversionOpen,
    setVectorToolOpen,
    setRasterToolOpen,
    setStyleManagerOpen,
  });

  // The viewer preset hides every authoring menu, so the surfaces that reach
  // those commands without a menu go with them: the command palette
  // (Ctrl/Cmd+K) and the cheat sheet (?) are not mounted, and the Help menu
  // drops its entries for them (see `viewer` on HelpMenu). Otherwise a
  // `layout=viewer` embed would still answer Ctrl+N with "New Project", or
  // overwrite the host's project on Ctrl+S — exactly what the read-only chrome
  // promises it cannot do.
  //
  // The shortcut layer is narrowed rather than switched off, because the View
  // menu *does* stay visible in this mode: `view.*` is camera and theme work
  // only, so dropping its keys would leave those items clickable but silently
  // keyless. Everything else carrying a `shortcut` authors the project
  // (`project.*`, `add.comment`), so filtering to `view.*` drops exactly the
  // authoring keyboard surface.
  //
  // Independently of the viewer preset, a withheld capability is withheld
  // everywhere: the menu gates in the toolbar only hide or disable menu
  // entries, while the palette, the cheat sheet, and the shortcut layer call
  // `run()` directly. Filtering the registry once here is what keeps those
  // three from advertising and invoking what was denied — and it has to apply
  // both vocabularies, the deployment's (issue #1673) and the session role's
  // (issue #1672), or the model gated by whichever one is missing is a UI
  // convention rather than an access control.
  const allowedCommands = useMemo(
    () =>
      filterCommandsByPrivileges(
        filterCommandsByCapabilities(
          commands.filter(
            (command) =>
              !command.id.startsWith("add.") ||
              (addDataReady &&
                supportsAddDataRenderer(
                  command.id.slice(4),
                  primaryRenderer,
                  capabilities.deckOverlay,
                )),
          ),
          deploymentCapabilities,
        ),
        appPrivileges,
      ),
    [
      commands,
      deploymentCapabilities,
      appPrivileges,
      primaryRenderer,
      addDataReady,
      capabilities.deckOverlay,
    ],
  );
  const shortcutCommands = useMemo(
    () =>
      viewer
        ? allowedCommands.filter((command) => command.id.startsWith("view."))
        : allowedCommands,
    [allowedCommands, viewer],
  );
  useGlobalShortcuts({
    commands: shortcutCommands,
    onOpenPalette: viewer ? undefined : () => setCommandPaletteOpen(true),
    onOpenShortcuts: viewer ? undefined : () => setShortcutsOpen(true),
  });

  return allowedCommands;
}
