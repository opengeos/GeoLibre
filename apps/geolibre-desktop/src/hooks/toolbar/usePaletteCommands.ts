import { type NetworkToolKind, useAppStore } from "@geolibre/core";
import { Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { filterCommandsForPalette } from "../../lib/command-profile-gates";
import type { Command } from "../../lib/commands";
import {
  filterCommandsByCapabilities,
  filterCommandsByPrivileges,
} from "../../lib/deployment-gates";
import { isMobile } from "../../lib/is-mobile";
import { useDesktopSettingsStore } from "../useDesktopSettings";

type PaletteToolsModule = typeof import("../../lib/palette-tools");

export interface UsePaletteCommandsOptions {
  /** The registry after the deployment and privilege gates (`useToolbarCommands`). */
  commands: Command[];
  /** Whether the palette is open; the tool catalog loads on the first open. */
  open: boolean;
  /** Open a network tool through the routing-consent notice. */
  openNetworkTool: (kind: NetworkToolKind) => void;
}

export interface PaletteCommands {
  /** Commands listed with or without a query. */
  commands: Command[];
  /**
   * The per-tool entries (about 1,100), listed only once the user types, so an
   * empty palette still opens on the short list of actions.
   */
  toolCommands: Command[];
}

/**
 * The command palette's contents: the toolbar registry narrowed to what the
 * active UI profile and platform show in the menus, plus one entry per
 * processing and Whitebox tool.
 *
 * The tool entries come from `lib/palette-tools`, imported the first time the
 * palette opens so the processing registries and the Whitebox catalog stay out
 * of the toolbar's chunk. They pass the same deployment, privilege, profile and
 * mobile gates as the fixed commands.
 *
 * @param options - The gated registry, the palette's open state, and the
 *   network-tool opener.
 * @returns The fixed and per-tool commands the palette may list.
 */
export function usePaletteCommands({
  commands,
  open,
  openNetworkTool,
}: UsePaletteCommandsOptions): PaletteCommands {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  const deploymentCapabilities = useAppStore((state) => state.deploymentCapabilities);
  const appPrivileges = useAppStore((state) => state.capabilities.privileges);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const setProcessingInitialTool = useAppStore((s) => s.setProcessingInitialTool);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setStatisticsToolOpen = useAppStore((s) => s.setStatisticsToolOpen);
  // The user agent is fixed for the session.
  const mobile = useMemo(() => isMobile(), []);
  const [toolsModule, setToolsModule] = useState<PaletteToolsModule | null>(null);
  // The opener is a fresh closure every render; read the latest through a ref
  // so the ~1,100 tool commands are not rebuilt on every toolbar render.
  const openNetworkToolRef = useRef(openNetworkTool);
  useEffect(() => {
    openNetworkToolRef.current = openNetworkTool;
  });

  useEffect(() => {
    if (!open || toolsModule) return;
    let cancelled = false;
    import("../../lib/palette-tools")
      .then((module) => {
        if (!cancelled) setToolsModule(module);
      })
      .catch((error: unknown) => {
        // The palette still works without per-tool entries.
        console.warn("[palette] failed to load the tool catalog", error);
      });
    return () => {
      cancelled = true;
    };
  }, [open, toolsModule]);

  const fixed = useMemo(
    () => filterCommandsForPalette(commands, uiProfile, mobile),
    [commands, uiProfile, mobile],
  );

  // The registry ids are stable across renders even though `commands` is not,
  // so key the (expensive) tool list on them rather than on the array.
  const existingIdsKey = commands.map((command) => command.id).join("\n");
  const allTools = useMemo(() => {
    if (!toolsModule) return [];
    return toolsModule.buildPaletteToolCommands({
      t,
      existingIds: new Set(existingIdsKey.split("\n")),
      icon: Wrench,
      // Same two store writes as the Processing menu's Whitebox leaves: queue
      // the tool, then open the toolbox, which consumes the queued id.
      openWhiteboxTool: (toolId) => {
        setProcessingInitialTool(toolId);
        setProcessingOpen(true);
      },
      openVectorTool: setVectorToolOpen,
      openNetworkTool: (kind) => openNetworkToolRef.current(kind),
      openStatisticsTool: setStatisticsToolOpen,
    });
  }, [
    toolsModule,
    t,
    existingIdsKey,
    setProcessingInitialTool,
    setProcessingOpen,
    setVectorToolOpen,
    setStatisticsToolOpen,
  ]);

  const toolCommands = useMemo(
    () =>
      filterCommandsForPalette(
        filterCommandsByPrivileges(
          filterCommandsByCapabilities(allTools, deploymentCapabilities),
          appPrivileges,
        ),
        uiProfile,
        mobile,
      ),
    [allTools, deploymentCapabilities, appPrivileges, uiProfile, mobile],
  );

  return { commands: fixed, toolCommands };
}
